// EclipseLiveCam desktop app — main process.
//
// The app no longer loads the website. Every page (studio, login, top-up …)
// ships inside the app under src/web. Only the account API — login, credits,
// payments, activation and the short-lived AI tokens — still goes to the
// server, because that is where the Decart key and the customer balances live.
//
// How: the pages run in their own session where requests for
// https://eclipselivecam.online are intercepted. Page and asset requests are
// answered from src/web; /api/ requests are passed through to the real server.
// Keeping the real origin means login cookies, the Studio's billing beacons and
// Decart's origin checks all behave exactly as they did on the website.
//
// Window layout: the frameless window's own page (shell.html) draws the custom
// title bar and the settings screen. The app pages live in a WebContentsView
// placed below the title bar, so their layouts are untouched.
const { app, BrowserWindow, WebContentsView, session, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const vcam = require('./vcam');
const activation = require('./activation');

const SITE_HOST = 'eclipselivecam.online';
const SITE_ORIGIN = `https://${SITE_HOST}`;
// Override for local testing only, e.g. ECLIPSE_API_ORIGIN=http://127.0.0.1:8080
const API_ORIGIN = process.env.ECLIPSE_API_ORIGIN || SITE_ORIGIN;
const START_URL = `${SITE_ORIGIN}/studio.html`;
const ACTIVATE_PATH = '/activate.html';
const WEB_ROOT = path.join(__dirname, '..', 'web');
const PARTITION = 'persist:eclipse';
const TITLEBAR_HEIGHT = 36;

let mainWindow = null;
let contentView = null;
let splashWindow = null;
let quitting = false;
let activated = false;

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

  // Until this device is activated, every page leads to the activation screen.
  if (!activated && rel.endsWith('.html') && rel !== ACTIVATE_PATH) {
    return new Response(null, { status: 302, headers: { location: SITE_ORIGIN + ACTIVATE_PATH } });
  }

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
        } catch (err) {
          return new Response(JSON.stringify({
            ok: false,
            error: `Could not reach the EclipseLiveCam server. Check your internet connection. (${err.message})`,
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

// ── IPC: app pages ───────────────────────────────────────────────────────────
ipcMain.on('vcam:frame', (e, data) => vcam.frame(data));
ipcMain.handle('vcam:status', () => vcam.status());
ipcMain.handle('vcam:install', async () => { await vcam.install(); vcam.stop(); vcam.start(); return vcam.status(); });
ipcMain.handle('app:version', () => app.getVersion());

// The activation page hands over the device token it just received. We check
// it with the server ourselves before unlocking, so the page can't fake it.
ipcMain.handle('app:activate', async (e, token) => {
  if (typeof token !== 'string' || !token) return false;
  const ok = await activation.verify(session.fromPartition(PARTITION), API_ORIGIN, token);
  if (ok !== true) return false;
  activation.save(token);
  activated = true;
  return true;
});

// ── IPC: title bar + settings ────────────────────────────────────────────────
ipcMain.handle('shell:info', () => ({
  version: app.getVersion(),
  settings: loadSettings(),
  maximized: !!mainWindow?.isMaximized(),
  activated,
  camera: vcam.status(),
}));
ipcMain.handle('shell:minimize', () => mainWindow?.minimize());
ipcMain.handle('shell:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.handle('shell:close', () => mainWindow?.close());
ipcMain.handle('shell:show-settings', (e, show) => setSettingsVisible(!!show));
ipcMain.handle('shell:reload', () => contentView?.webContents.reload());
ipcMain.handle('shell:clear-cache', async () => {
  // HTTP cache only — cookies (the login) are kept.
  await session.fromPartition(PARTITION).clearCache();
  return true;
});
ipcMain.handle('shell:set-setting', (e, key, value) => {
  if (!['zoom', 'startMaximized', 'alwaysOnTop'].includes(key)) return;
  saveSettings({ ...loadSettings(), [key]: value });
  if (key === 'zoom') contentView?.webContents.setZoomFactor(clampZoom(value) / 100);
  if (key === 'alwaysOnTop') mainWindow?.setAlwaysOnTop(!!value);
});

const clampZoom = (z) => Math.min(150, Math.max(70, Number(z) || 100));

vcam.onStatus((s) => {
  for (const wc of [mainWindow?.webContents, contentView?.webContents]) {
    if (wc && !wc.isDestroyed()) wc.send('vcam:status', s);
  }
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

function layoutContent() {
  if (!mainWindow || !contentView) return;
  const { width, height } = mainWindow.getContentBounds();
  contentView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) });
}

function setSettingsVisible(show) {
  if (!contentView || !mainWindow) return;
  contentView.setVisible(!show);
  mainWindow.webContents.send('shell:settings-visible', show);
  if (!show) contentView.webContents.focus();
}

function createMain() {
  const s = loadSettings();

  mainWindow = new BrowserWindow({
    width: s.width || 1300,
    height: s.height || 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,             // we draw our own title bar
    title: 'EclipseLiveCam',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#0c0c0e',
    alwaysOnTop: !!s.alwaysOnTop,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'shell-preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'shell.html'));

  contentView = new WebContentsView({
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
  contentView.setBackgroundColor('#0c0c0e');
  mainWindow.contentView.addChildView(contentView);
  layoutContent();
  mainWindow.on('resize', layoutContent);
  mainWindow.on('maximize', () => { layoutContent(); mainWindow.webContents.send('shell:maximized', true); });
  mainWindow.on('unmaximize', () => { layoutContent(); mainWindow.webContents.send('shell:maximized', false); });

  mainWindow.on('resized', () => {
    if (mainWindow.isMaximized()) return;
    const [width, height] = mainWindow.getSize();
    saveSettings({ ...loadSettings(), width, height });
  });

  const wc = contentView.webContents;
  // Links to anything outside the app open in the normal browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url) && /^(https?:|mailto:)/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^(https?:|mailto:)/.test(url)) shell.openExternal(url);
    }
  });
  wc.on('did-finish-load', () => {
    if (s.zoom) wc.setZoomFactor(clampZoom(loadSettings().zoom) / 100);
  });
  // The shell's own page is never navigated away from.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  wc.once('did-finish-load', () => {
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
    const settle = wc.executeJavaScript('window.__eclipseStop ? window.__eclipseStop() : null', true)
      .catch(() => {});
    const timeout = new Promise((r) => setTimeout(r, 4000));
    Promise.race([settle, timeout]).finally(() => mainWindow?.destroy());
  });
  mainWindow.on('closed', () => { mainWindow = null; contentView = null; });

  wc.loadURL(activated ? START_URL : SITE_ORIGIN + ACTIVATE_PATH);
}

// Re-check a saved activation with the server. A revoked key locks the app
// again; if the server can't be reached we let the device in rather than
// locking out paying customers during an outage.
async function checkActivation(ses) {
  const token = activation.load();
  if (!token) return false;
  const ok = await activation.verify(ses, API_ORIGIN, token);
  if (ok === false) { activation.clear(); return false; }
  return true;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  const ses = session.fromPartition(PARTITION);
  const allowed = ['media', 'camera', 'microphone', 'notifications', 'clipboard-sanitized-write', 'fullscreen'];
  ses.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(allowed.includes(permission) && isAppUrl(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.includes(permission) && isAppUrl(origin));
  installRequestHandler(ses);

  createSplash();
  vcam.refreshInstalled();
  vcam.start();

  activated = await checkActivation(ses);
  createMain();
});

app.on('before-quit', () => vcam.stop());
app.on('window-all-closed', () => app.quit());
