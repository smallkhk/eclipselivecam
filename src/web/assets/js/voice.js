/* ── Live voice changer (ElevenLabs Voice Changer via /api/voice.php) ───────
 * Records the microphone, cuts it into pieces of speech, sends each piece to
 * the server (which charges credits and calls ElevenLabs with its own key) and
 * plays the converted voice, in order, into a virtual microphone (VB-CABLE).
 * Call apps then pick "CABLE Output (VB-Audio Virtual Cable)" as their mic.
 *
 * Modes:
 *   fast    — ~1 s pieces, ElevenLabs' maximum latency optimisation.
 *   natural — whole phrases cut at natural pauses (up to ~4 s), best quality.
 * Silence is never sent, so customers only pay for speech.
 */

const IN_RATE = 16000;          // what voice.php / ElevenLabs expect
const OUT_RATE = 24000;         // what voice.php returns
const FRAME = 320;              // 20 ms analysis frames at 16 kHz
const MODES = {
  fast:    { minSec: 0.8, maxSec: 1.4, pauseMs: 180 },
  natural: { minSec: 0.6, maxSec: 4.0, pauseMs: 420 },
};
const MAX_IN_FLIGHT = 3;        // pieces being converted at once

// The virtual-mic driver. "CABLE Input" is the speaker side we play into;
// "CABLE Output" is the microphone side call apps record from.
export const CABLE_PLAYBACK = /CABLE Input/i;
export const CABLE_MIC = /CABLE Output/i;
export const CABLE_DOWNLOAD = 'https://vb-audio.com/Cable/';

/** The VB-CABLE playback device, or null if VB-CABLE isn't installed. */
export async function findCableOutput() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.find((d) => d.kind === 'audiooutput' && CABLE_PLAYBACK.test(d.label)) || null;
}

// AudioWorklet that hands raw mic samples to the page.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('eclipse-voice-tap', Tap);`;

export class VoiceChanger {
  constructor({ onStatus, onBalance, onError } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onBalance = onBalance || (() => {});
    this.onError = onError || (() => {});
    this.running = false;
  }

  /**
   * micDeviceId: real microphone. voiceId: ElevenLabs voice. mode: fast|natural.
   * outputDeviceId: where the new voice goes (VB-CABLE Input). monitor: also
   * play it on the normal speakers/headphones so the customer can hear it.
   */
  async start({ micDeviceId, voiceId, mode = 'natural', outputDeviceId, monitor = false }) {
    if (this.running) return;
    this.voiceId = voiceId;
    this.mode = MODES[mode] ? mode : 'natural';
    this.cfg = MODES[this.mode];
    this.seq = 0;
    this.nextToPlay = 0;
    this.ready = new Map();      // seq -> Float32Array (or null if failed)
    this.inFlight = 0;
    this.chunk = [];             // Float32Array frames of the current piece
    this.chunkSamples = 0;
    this.speechInChunk = false;
    this.silentMs = 0;
    this.noiseFloor = 0.005;
    this.pending = new Float32Array(0);
    this.failures = 0;

    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    // Capture at 16 kHz: the browser resamples the mic for us.
    this.inCtx = new AudioContext({ sampleRate: IN_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.source = this.inCtx.createMediaStreamSource(this.mic);
    this.tap = new AudioWorkletNode(this.inCtx, 'eclipse-voice-tap');
    this.tap.port.onmessage = (e) => this.onSamples(e.data);
    // Keep the graph pulling without making any sound locally.
    const mute = this.inCtx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.tap).connect(mute).connect(this.inCtx.destination);

    // Output into the virtual mic, plus an optional monitor on the speakers.
    this.outCtx = new AudioContext();
    if (outputDeviceId && this.outCtx.setSinkId) await this.outCtx.setSinkId(outputDeviceId);
    this.outTime = 0;
    if (monitor) {
      this.monCtx = new AudioContext();
      this.monTime = 0;
    }

    this.running = true;
    this.onStatus('listening');
  }

  setVoice(voiceId) { this.voiceId = voiceId; }
  setMode(mode) { if (MODES[mode]) { this.mode = mode; this.cfg = MODES[mode]; } }

  async stop() {
    if (!this.running) return;
    this.running = false;
    try { this.flush(); } catch {}
    try { this.source?.disconnect(); this.tap?.disconnect(); } catch {}
    this.mic?.getTracks().forEach((t) => t.stop());
    for (const ctx of [this.inCtx, this.outCtx, this.monCtx]) { try { await ctx?.close(); } catch {} }
    this.inCtx = this.outCtx = this.monCtx = null;
    this.onStatus('off');
    try {
      const r = await API.post('/api/voice.php?action=stop', {});
      if (typeof r.balance === 'number') this.onBalance(r.balance);
    } catch {}
  }

  // ── Cutting speech into pieces ─────────────────────────────────────────────
  onSamples(samples) {
    if (!this.running) return;
    // Re-block into 20 ms frames for the speech detector.
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending); all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this.onFrame(all.subarray(i, i + FRAME));
    this.pending = all.slice(i);
  }

  onFrame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const speaking = rms > Math.max(0.012, this.noiseFloor * 3);
    // Track background noise slowly while nobody is talking.
    if (!speaking) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;

    if (speaking) { this.speechInChunk = true; this.silentMs = 0; }
    else this.silentMs += 20;

    // Keep a little silence before speech so words don't start clipped.
    if (!this.speechInChunk) {
      this.chunk.push(frame.slice(0));
      this.chunkSamples += frame.length;
      while (this.chunkSamples > IN_RATE * 0.2) this.chunkSamples -= this.chunk.shift().length;
      return;
    }

    this.chunk.push(frame.slice(0));
    this.chunkSamples += frame.length;
    const sec = this.chunkSamples / IN_RATE;
    if (sec >= this.cfg.maxSec || (sec >= this.cfg.minSec && this.silentMs >= this.cfg.pauseMs)) this.flush();
    else if (this.silentMs >= 1200) this.flush();   // a short word followed by silence
  }

  flush() {
    const hadSpeech = this.speechInChunk;
    const frames = this.chunk;
    this.chunk = [];
    this.chunkSamples = 0;
    this.speechInChunk = false;
    this.silentMs = 0;
    if (!hadSpeech) return;
    const total = frames.reduce((n, f) => n + f.length, 0);
    if (total < IN_RATE * 0.25) return;
    const pcm = new Int16Array(total);
    let o = 0;
    for (const f of frames) for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) return;   // falling behind: drop rather than lag
    this.convert(this.seq++, pcm);
  }

  // ── Converting and playing in order ────────────────────────────────────────
  async convert(seq, pcm) {
    this.inFlight++;
    this.onStatus('converting');
    let audio = null;
    try {
      const res = await fetch(`/api/voice.php?action=convert&voice=${encodeURIComponent(this.voiceId)}&mode=${this.mode}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm.buffer,
      });
      if (!res.ok) {
        let msg = 'The voice changer failed.';
        try { msg = (await res.json()).error || msg; } catch {}
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      const balance = parseInt(res.headers.get('X-Balance'), 10);
      if (!Number.isNaN(balance)) this.onBalance(balance);
      const buf = await res.arrayBuffer();
      const ints = new Int16Array(buf, 0, buf.byteLength >> 1);
      audio = new Float32Array(ints.length);
      for (let i = 0; i < ints.length; i++) audio[i] = ints[i] / 0x8000;
      this.failures = 0;
    } catch (err) {
      this.failures++;
      // Out of credit, switched off or misconfigured: stop and explain.
      if (err.status === 402 || err.status === 403 || err.status === 500 || this.failures >= 3) {
        this.onError(err);
        this.stop();
      }
    } finally {
      this.inFlight--;
    }
    this.ready.set(seq, audio);
    this.playReady();
  }

  playReady() {
    while (this.ready.has(this.nextToPlay)) {
      const audio = this.ready.get(this.nextToPlay);
      this.ready.delete(this.nextToPlay);
      this.nextToPlay++;
      if (audio && audio.length && this.outCtx) {
        this.outTime = this.schedule(this.outCtx, audio, this.outTime);
        if (this.monCtx) this.monTime = this.schedule(this.monCtx, audio, this.monTime);
      }
    }
    if (this.running) this.onStatus(this.inFlight ? 'converting' : 'listening');
  }

  schedule(ctx, audio, at) {
    const buffer = ctx.createBuffer(1, audio.length, OUT_RATE);
    buffer.copyToChannel(audio, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, at);
    node.start(start);
    return start + buffer.duration;
  }
}
