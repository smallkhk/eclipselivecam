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

async function loadVoices(selectId, selectName) {
  const { voices } = await API.get('/api/voice.php?action=voices');
  voiceSelect.innerHTML = '';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    voiceSelect.appendChild(o);
  }
  // A just-added voice may not be in the server's cached list yet — add it now
  // so it can be selected and used immediately.
  if (selectId && !voices.some((v) => v.id === selectId)) {
    const o = document.createElement('option');
    o.value = selectId;
    o.textContent = selectName || 'New voice';
    voiceSelect.appendChild(o);
  }
  if (!voices.length && !selectId) voiceSelect.innerHTML = '<option value="">No voices on the account</option>';
  try {
    if (selectId) {
      voiceSelect.value = selectId;
      localStorage.setItem('eclipse_voice', selectId);
      if (changer && changer.running) changer.setVoice(selectId);   // apply live
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

voiceSelect.addEventListener('change', () => {
  try { localStorage.setItem('eclipse_voice', voiceSelect.value); } catch {}
  if (changer && changer.running) changer.setVoice(voiceSelect.value);
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
      await loadVoices(r.voice_id, r.name);   // refresh list and select the new voice
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

// ── Browse the ElevenLabs voice library (filters: gender, age, region, language)
const libModal = $('voiceLib');
const libResults = $('libResults');
const libSearch = $('libSearch');
const libFilters = ['libGender', 'libAge', 'libAccent', 'libLanguage'].map($);
let libPreview = null;      // currently playing <audio>
let libTimer = null;
let libUseCase = '';        // active category chip

function openLib() { libModal.classList.remove('hidden'); searchLib(); }
function closeLib() {
  libModal.classList.add('hidden');
  if (libPreview) { libPreview.pause(); libPreview = null; }
}

async function searchLib() {
  libResults.innerHTML = '<p class="hint">Searching…</p>';
  const q = new URLSearchParams({ action: 'library' });
  const [g, a, acc, lang] = libFilters;
  if (g.value) q.set('gender', g.value);
  if (a.value) q.set('age', a.value);
  if (acc.value) q.set('accent', acc.value);
  if (lang.value) q.set('language', lang.value);
  if (libSearch.value.trim()) q.set('search', libSearch.value.trim());
  if (libUseCase) q.set('use_cases', libUseCase);
  try {
    const { voices } = await API.get('/api/voice_clone.php?' + q.toString());
    renderLib(voices);
  } catch (err) {
    libResults.innerHTML = `<p class="hint">${err.message || 'Could not load the library.'}</p>`;
  }
}

function renderLib(voices) {
  if (!voices.length) { libResults.innerHTML = '<p class="hint">No voices match those filters. Try fewer filters.</p>'; return; }
  libResults.innerHTML = '';
  for (const v of voices) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line,#2a2a33)';
    const tags = [v.gender, v.age && v.age.replace('_', ' '), v.accent, v.language].filter(Boolean).join(' · ');
    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0';
    meta.innerHTML = `<div style="font-weight:600">${esc(v.name)}</div><div class="faint" style="font-size:.78rem">${esc(tags)}</div>`;
    const play = document.createElement('button');
    play.className = 'btn btn-ghost btn-sm'; play.type = 'button'; play.textContent = '▶';
    play.disabled = !v.preview_url;
    play.onclick = () => {
      if (libPreview) libPreview.pause();
      libPreview = new Audio(v.preview_url); libPreview.play().catch(() => {});
    };
    const use = document.createElement('button');
    use.className = 'btn btn-ghost btn-sm'; use.type = 'button'; use.textContent = 'Use';
    use.onclick = async () => {
      use.disabled = true; use.textContent = 'Adding…';
      try {
        const r = await API.post('/api/voice_clone.php?action=add_shared', {
          public_owner_id: v.public_owner_id, voice_id: v.voice_id, name: v.name,
        });
        await loadVoices(r.voice_id, r.name);
        toast(`"${r.name}" added — selected above.`);
        closeLib();
      } catch (err) {
        use.disabled = false; use.textContent = 'Use';
        toast(err.message || 'Could not add this voice.', true);
      }
    };
    row.append(meta, play, use);
    libResults.appendChild(row);
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

if ($('voiceBrowseBtn')) {
  $('voiceBrowseBtn').addEventListener('click', openLib);
  $('voiceLibClose').addEventListener('click', closeLib);
  libModal.addEventListener('click', (e) => { if (e.target === libModal) closeLib(); });
  libFilters.forEach((el) => el.addEventListener('change', searchLib));
  libSearch.addEventListener('input', () => { clearTimeout(libTimer); libTimer = setTimeout(searchLib, 400); });

  const cats = [...document.querySelectorAll('#libCats .libcat')];
  cats[0]?.classList.add('active');
  cats.forEach((c) => c.addEventListener('click', () => {
    cats.forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    libUseCase = c.dataset.uc || '';
    searchLib();
  }));
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
