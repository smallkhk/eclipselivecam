// EclipseLiveCam desktop app — main process.
//
// The app no longer loads the website. Every page (studio, login, top-up …)
// ships inside the app under src/web. Only the account API — login, credits,
// payments and the short-lived AI tokens — still goes to the server, because
// that is where the Decart key and the customer balances live.
//
// How: the app window runs in its own session where requests for
// https://eclipselivecam.com are intercepted. Page and asset requests are
// answered from src/web; /api/ requests are passed through to the real server.
// Keeping the real origin means login cookies, the Studio's billing beacons and
// Decart's origin checks all behave exactly as they did on the website.
const { app, BrowserWindow, session, shell, Menu, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const vcam = require('./vcam');

const SITE_HOST = 'eclipselivecam.com';
const SITE_ORIGIN = `https://${SITE_HOST}`;
// Override for local testing only, e.g. ECLIPSE_API_ORIGIN=http://127.0.0.1:8080
const API_ORIGIN = process.env.ECLIPSE_API_ORIGIN || SITE_ORIGIN;
const START_URL = `${SITE_ORIGIN}/studio.html`;
const WEB_ROOT = path.join(__dirname, '..', 'web');
const PARTITION = 'persist:eclipse';

let mainWindow = null;
let splashWindow = null;
let quitting = false;

// ── SINGLE INSTANCE ──────────────────────────────────────────────────────────
// Only one process can own the virtual camera.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); } catch {}
}

// ── BUNDLED PAGES + API PASS-THROUGH ─────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveLocal(url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/studio.html';
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return new Response(fs.readFileSync(file), {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'no-cache' },
  });
}

async function forwardApi(req, url, ses) {
  const target = API_ORIGIN + url.pathname + url.search;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return ses.fetch(target, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    credentials: 'include',
    bypassCustomProtocolHandlers: true,
  });
}

function installRequestHandler(ses) {
  ses.protocol.handle('https', async (req) => {
    const url = new URL(req.url);
    if (url.hostname === SITE_HOST || url.hostname === `www.${SITE_HOST}`) {
      if (url.pathname.startsWith('/api/')) {
        try {
          return await forwardApi(req, url, ses);
        } catch {
          return new Response(JSON.stringify({
            ok: false,
            error: 'Could not reach the EclipseLiveCam server. Check your internet connection.',
          }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
      }
      return serveLocal(url);
    }
    // Everything else (Decart, fonts …) goes out untouched.
    return ses.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}

function isAppUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === SITE_HOST || url.hostname === `www.${SITE_HOST}`);
  } catch { return false; }
}

// ── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('vcam:frame', (e, data) => vcam.frame(data));
ipcMain.handle('vcam:status', () => vcam.status());
ipcMain.handle('vcam:install', async () => { await vcam.install(); vcam.stop(); vcam.start(); return vcam.status(); });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:open-external', (e, url) => {
  if (/^https?:\/\//.test(url) || /^mailto:/.test(url)) shell.openExternal(url);
});

vcam.onStatus((s) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcam:status', s);
});

// ── WINDOWS ──────────────────────────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480, height: 320, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, center: true, skipTaskbar: true, show: false,
    webPreferences: { contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function createMain() {
  const s = loadSettings();
  const ses = session.fromPartition(PARTITION);

  mainWindow = new BrowserWindow({
    width: s.width || 1300,
    height: s.height || 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'EclipseLiveCam',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#0c0c0e',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // Keep feeding the virtual camera while the window is minimised or
      // hidden behind Zoom — that is exactly when it is being used.
      backgroundThrottling: false,
    },
  });

  mainWindow.on('resized', () => {
    const [width, height] = mainWindow.getSize();
    saveSettings({ ...loadSettings(), width, height });
  });

  // Links to anything outside the app open in the normal browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url) && /^(https?:|mailto:)/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^(https?:|mailto:)/.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.show();
    if (s.startMaximized) mainWindow.maximize();
  });

  // Closing mid-stream: let the Studio settle the session (bill the seconds
  // used, refund the deposit) before the window goes away.
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    const wc = mainWindow.webContents;
    const settle = wc.executeJavaScript('window.__eclipseStop ? window.__eclipseStop() : null', true)
      .catch(() => {});
    const timeout = new Promise((r) => setTimeout(r, 4000));
    Promise.race([settle, timeout]).finally(() => mainWindow?.destroy());
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(START_URL);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  const ses = session.fromPartition(PARTITION);
  const allowed = ['media', 'camera', 'microphone', 'notifications', 'clipboard-sanitized-write', 'fullscreen'];
  ses.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(allowed.includes(permission) && isAppUrl(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.includes(permission) && isAppUrl(origin));
  installRequestHandler(ses);

  createSplash();
  createMain();

  vcam.refreshInstalled();
  vcam.start();
});

app.on('before-quit', () => vcam.stop());
app.on('window-all-closed', () => app.quit());
