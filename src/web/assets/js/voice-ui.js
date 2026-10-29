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

async function loadVoices() {
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
    const saved = localStorage.getItem('eclipse_voice');
    if (saved && voices.some((v) => v.id === saved)) voiceSelect.value = saved;
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
