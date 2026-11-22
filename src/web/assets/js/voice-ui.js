/* ── Studio panel for the live voice changer (see voice.js) ──────────────── */
import { VoiceChanger, findCableOutput, CABLE_DOWNLOAD } from './voice.js';

const $ = (id) => document.getElementById(id);
const box = $('voiceBox');
const voiceSelect = $('voiceSelect');
const modeSelect = $('voiceMode');
const monitorBox = $('voiceMonitor');
const btn = $('voiceBtn');
const statusEl = $('voiceStatus');
const cableEl = $('voiceCable');

let changer = null;
let cable = null;

const STATUS = {
  listening: 'Listening — talk and your new voice goes to the EclipseLiveCam mic (VB-CABLE).',
  converting: 'Changing your voice…',
  off: '',
};

function setRunning(on) {
  btn.textContent = on ? '■ Stop voice changer' : '🎙️ Start voice changer';
  btn.classList.toggle('btn-danger', on);
  btn.classList.toggle('btn-ghost', !on);
  voiceSelect.disabled = on;
  modeSelect.disabled = on;
  monitorBox.disabled = on;
}

async function checkCable() {
  try { cable = await findCableOutput(); } catch { cable = null; }
  if (cable) {
    cableEl.innerHTML = 'In Zoom, WhatsApp, OBS… choose <strong>CABLE Output (VB-Audio Virtual Cable)</strong> as the microphone.';
  } else {
    cableEl.innerHTML = 'To use your new voice in calls, install the free <strong>VB-CABLE</strong> virtual mic once, then restart the app. '
      + `<a href="${CABLE_DOWNLOAD}" target="_blank" rel="noopener" style="color:var(--brand-2);font-weight:600">Download VB-CABLE</a>`
      + '<br>Without it you can still try voices with “Hear my new voice”.';
  }
}

async function loadVoices(selectId) {
  const { voices } = await API.get('/api/voice.php?action=voices');
  voiceSelect.innerHTML = '';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    voiceSelect.appendChild(o);
  }
  if (!voices.length) voiceSelect.innerHTML = '<option value="">No voices on the account</option>';
  try {
    if (selectId && voices.some((v) => v.id === selectId)) {
      voiceSelect.value = selectId;
      localStorage.setItem('eclipse_voice', selectId);
    } else {
      const saved = localStorage.getItem('eclipse_voice');
      if (saved && voices.some((v) => v.id === saved)) voiceSelect.value = saved;
    }
    const mode = localStorage.getItem('eclipse_voice_mode');
    if (mode) modeSelect.value = mode;
  } catch {}
}

async function start() {
  if (!voiceSelect.value) return toast('Pick a voice first.', true);
  await checkCable();
  if (!cable && !monitorBox.checked) {
    toast('Install VB-CABLE to use the voice in calls, or tick “Hear my new voice” to try it out.', true);
    return;
  }
  try {
    localStorage.setItem('eclipse_voice', voiceSelect.value);
    localStorage.setItem('eclipse_voice_mode', modeSelect.value);
  } catch {}
  changer = new VoiceChanger({
    onStatus: (s) => { statusEl.textContent = STATUS[s] ?? ''; if (s === 'off') setRunning(false); },
    onBalance: (b) => setBalance(b),
    onError: (err) => toast(err.message || 'The voice changer stopped.', true),
  });
  setRunning(true);
  try {
    await changer.start({
      micDeviceId: $('micSelect')?.value || undefined,
      voiceId: voiceSelect.value,
      mode: modeSelect.value,
      outputDeviceId: cable ? cable.deviceId : undefined,
      monitor: monitorBox.checked,
    });
  } catch (err) {
    console.error(err);
    toast('Could not start the voice changer: ' + (err.message || err), true);
    setRunning(false);
    changer = null;
  }
}

btn.addEventListener('click', () => {
  if (changer && changer.running) changer.stop();
  else start();
});

// Stop cleanly (and record the session) when the page or app closes.
window.addEventListener('pagehide', () => { if (changer?.running) changer.stop(); });

// ── Train & save a new voice (ElevenLabs Instant Voice Cloning) ──────────────
const nameEl = $('voiceTrainName');
const recBtn = $('voiceRecBtn');
const fileEl = $('voiceFile');
const sampleInfo = $('voiceSampleInfo');
const trainBtn = $('voiceTrainBtn');
const trainStatus = $('voiceTrainStatus');

let recorder = null;       // MediaRecorder while recording
let recStream = null;      // its mic stream
let recChunks = [];
let recStart = 0;
let recTimer = null;
let recordedBlob = null;   // the recorded sample

function fmtKB(bytes) { return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }

function currentSample() {
  if (fileEl.files && fileEl.files[0]) return fileEl.files[0];
  if (recordedBlob) return new File([recordedBlob], 'recording.webm', { type: recordedBlob.type || 'audio/webm' });
  return null;
}

function refreshTrainState() {
  const s = currentSample();
  trainBtn.disabled = !(nameEl.value.trim() && s);
  if (s && !sampleInfo.dataset.recording) {
    const src = (fileEl.files && fileEl.files[0]) ? 'File' : 'Recording';
    sampleInfo.textContent = `${src} ready — ${fmtKB(s.size)}.`;
  }
}

async function startRec() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: $('micSelect')?.value ? { exact: $('micSelect').value } : undefined, channelCount: 1 },
    });
  } catch { toast('Could not open the microphone.', true); return; }
  recChunks = [];
  recordedBlob = null;
  fileEl.value = '';
  recorder = new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    recordedBlob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null; recorder = null;
    clearInterval(recTimer);
    delete sampleInfo.dataset.recording;
    recBtn.textContent = '● Record sample';
    recBtn.classList.remove('btn-danger');
    refreshTrainState();
  };
  recorder.start();
  recStart = Date.now();
  sampleInfo.dataset.recording = '1';
  recBtn.textContent = '■ Stop recording';
  recBtn.classList.add('btn-danger');
  recTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - recStart) / 1000);
    sampleInfo.textContent = `Recording… ${sec}s (aim for 30–60s, keep talking clearly)`;
    if (sec >= 90) recorder.stop();   // ElevenLabs needs no more than this
  }, 250);
}

if (recBtn) {
  recBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') recorder.stop();
    else startRec();
  });
  nameEl.addEventListener('input', refreshTrainState);
  fileEl.addEventListener('change', () => { recordedBlob = null; refreshTrainState(); });

  trainBtn.addEventListener('click', async () => {
    const sample = currentSample();
    const name = nameEl.value.trim();
    if (!sample || !name) return;
    const form = new FormData();
    form.append('name', name);
    form.append('sample', sample, sample.name || 'sample.webm');
    trainBtn.disabled = true;
    trainStatus.textContent = 'Training the voice… this can take up to a minute.';
    try {
      const r = await API.call('/api/voice_clone.php?action=clone', { method: 'POST', form });
      trainStatus.textContent = `✅ "${r.name}" trained and saved.`;
      nameEl.value = ''; fileEl.value = ''; recordedBlob = null; sampleInfo.textContent = '';
      await loadVoices(r.voice_id);           // refresh list and select the new voice
      toast(`Voice "${r.name}" saved — it's selected above.`);
      $('voiceTrain').open = false;
    } catch (err) {
      trainStatus.textContent = '';
      toast(err.message || 'Voice training failed.', true);
    } finally {
      refreshTrainState();
    }
  });
}

(async function init() {
  try {
    const cfg = await API.get('/api/voice.php?action=config');
    if (!cfg.enabled) return;
    box.classList.remove('hidden');
    $('voicePrice').textContent = `${cfg.perSecond} pts per second of speech`;
    await Promise.all([loadVoices(), checkCable()]);
    navigator.mediaDevices.addEventListener('devicechange', checkCable);
  } catch (err) {
    console.warn('Voice changer unavailable:', err);
  }
})();
