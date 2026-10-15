// Title bar + settings screen. Talks to the main process via window.shell
// (see shell-preload.js).
const $ = (id) => document.getElementById(id);
const api = window.shell;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Window controls ──────────────────────────────────────────────────────────
$('btnMin').addEventListener('click', () => api.minimize());
$('btnMax').addEventListener('click', () => api.toggleMaximize());
$('btnClose').addEventListener('click', () => api.close());
document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
  if (!e.target.closest('.tb-controls')) api.toggleMaximize();
});

function setMaxIcon(maximized) {
  $('maxIcon').innerHTML = maximized
    ? '<path d="M0 3h7v7H0zM3 0h7v7" fill="none" stroke="currentColor"/>'
    : '<rect width="9" height="9" x=".5" y=".5" fill="none" stroke="currentColor"/>';
}
api.onMaximized(setMaxIcon);

// ── Settings panel ───────────────────────────────────────────────────────────
function showSettings(show) {
  if (show) refreshActivation();
  document.body.classList.toggle('show-settings', show);
  $('btnSettings').classList.toggle('on', show);
  api.showSettings(show);
}
$('btnSettings').addEventListener('click', () =>
  showSettings(!document.body.classList.contains('show-settings')));
$('btnDone').addEventListener('click', () => showSettings(false));
api.onSettingsVisible((show) => {
  document.body.classList.toggle('show-settings', show);
  $('btnSettings').classList.toggle('on', show);
});

$('zoom').addEventListener('input', (e) => {
  $('zoomVal').textContent = e.target.value + '%';
  api.setSetting('zoom', Number(e.target.value));
});
$('startMaximized').addEventListener('change', (e) => api.setSetting('startMaximized', e.target.checked));
$('alwaysOnTop').addEventListener('change', (e) => api.setSetting('alwaysOnTop', e.target.checked));

$('btnReload').addEventListener('click', () => { api.reload(); showSettings(false); });
$('btnCache').addEventListener('click', async () => { await api.clearCache(); toast('Cache cleared'); });
$('btnCamInstall').addEventListener('click', async () => {
  $('btnCamInstall').disabled = true;
  const s = await api.installCamera().catch(() => null);
  $('btnCamInstall').disabled = false;
  toast(s && s.installed ? 'Camera installed' : 'Camera was not installed');
});

// ── Virtual camera status ────────────────────────────────────────────────────
function renderCam(s) {
  const chip = $('tbCam');
  let cls = '', text = 'Camera', desc = '';
  if (s.state === 'unsupported') { text = 'Camera: Windows only'; desc = 'The virtual camera is available on Windows.'; }
  else if (s.state === 'error') { cls = 'err'; text = 'Camera error'; desc = `Could not start (${s.error || 'unknown'}).`; }
  else if (s.state === 'ready' && s.installed === false) { cls = 'err'; text = 'Camera not installed'; desc = 'Other apps can’t see it yet. Click Reinstall camera.'; }
  else if (s.state === 'ready') {
    cls = 'on'; text = 'Camera on';
    desc = s.mode === 'mf'
      ? 'Windows 11 camera: pick “EclipseLiveCam” in any app, including WhatsApp, Teams, Zoom, Chrome and OBS.'
      : 'Pick “EclipseLiveCam” as your camera in Zoom, Meet, Chrome, Discord or OBS. (Microsoft Store apps such as WhatsApp need Windows 11.)';
  }
  else { text = 'Camera starting…'; desc = 'Starting…'; }
  chip.className = 'tb-cam' + (cls ? ' ' + cls : '');
  $('tbCamText').textContent = text;
  $('camDesc').textContent = desc;
  $('btnCamInstall').hidden = s.state === 'unsupported';
}
api.onCameraStatus(renderCam);

async function refreshActivation() {
  const info = await api.info();
  $('actDesc').textContent = info.activated ? 'This device is activated.' : 'Not activated yet.';
}

// ── Updates ─────────────────────────────────────────────────────────────────
function renderUpdate(u) {
  const ready = u.state === 'ready';
  $('tbUpdate').hidden = !ready;
  $('tbUpdate').textContent = `⬆ Restart to update${u.version ? ' to ' + u.version : ''}`;
  const desc = {
    disabled: 'Updates are only checked in the installed app.',
    idle: 'Not checked yet.',
    checking: 'Checking for updates…',
    current: 'You have the latest version.',
    downloading: `Downloading version ${u.version}…`,
    ready: `Version ${u.version} is ready. Restart to install it.`,
    error: 'Could not check for updates. It will try again later.',
  }[u.state] || '';
  $('updDesc').textContent = desc;
  $('btnUpdate').textContent = ready ? 'Restart and update' : 'Check for updates';
  $('btnUpdate').disabled = ['disabled', 'checking', 'downloading'].includes(u.state);
}
$('tbUpdate').addEventListener('click', () => api.installUpdate());
$('btnUpdate').addEventListener('click', () => {
  if ($('btnUpdate').textContent === 'Restart and update') api.installUpdate();
  else api.checkForUpdates();
});
api.onUpdateStatus(renderUpdate);

// ── Initial state ────────────────────────────────────────────────────────────
(async function init() {
  const info = await api.info();
  $('version').textContent = 'v' + info.version;
  const s = info.settings;
  $('zoom').value = s.zoom || 100;
  $('zoomVal').textContent = (s.zoom || 100) + '%';
  $('startMaximized').checked = !!s.startMaximized;
  $('alwaysOnTop').checked = !!s.alwaysOnTop;
  $('actDesc').textContent = info.activated ? 'This device is activated.' : 'Not activated yet.';
  setMaxIcon(info.maximized);
  renderCam(info.camera);
  renderUpdate(info.update);
})();
