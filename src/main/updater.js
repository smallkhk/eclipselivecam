// Auto-update from GitHub Releases (smallkhk/eclipselivecam).
//
// Only "Latest" releases (built from main) are offered; pre-releases from
// test branches are ignored. A new version downloads in the background and
// installs when the user clicks "Restart to update" or next quits the app.
const { app } = require('electron');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let autoUpdater = null;
let state = { state: 'idle', version: null, error: null };
const listeners = [];

function set(next) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn(state));
}

function onStatus(fn) { listeners.push(fn); }
function status() { return state; }

function check() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((err) => set({ state: 'error', error: err.message }));
}

function init() {
  // Updates only make sense for the installed app, not `npm start`.
  if (!app.isPackaged) { set({ state: 'disabled' }); return; }

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ state: 'current' }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => set({ state: 'error', error: err?.message || String(err) }));

  check();
  setInterval(check, CHECK_EVERY_MS);
}

// Quits (letting the Studio settle any running session) and runs the installer.
function installNow() {
  // Silent install (Windows still asks for admin), then reopen the app.
  if (autoUpdater && state.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

module.exports = { init, check, installNow, onStatus, status };
