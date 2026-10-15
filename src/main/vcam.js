// Virtual camera bridge (Windows only).
//
// The camera itself is softcam, a DirectShow filter DLL rebranded as
// "EclipseLiveCam" (see native/). The installer registers it once so Zoom,
// Meet, Discord, OBS etc. list it as a webcam. While the app runs, a small
// helper process (eclipse-vcam.exe) owns the camera and we stream raw RGBA
// frames to its stdin.
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Must match native/patch-softcam.mjs and build/installer.nsh.
const CAMERA_CLSID = '{4C23FA8E-932C-4342-92E8-7F3EDA72F4BA}';
const CAMERA_NAME = 'EclipseLiveCam';
// DirectShow "Video Capture Sources" category; softcam registers itself here
// under its friendly name.
const VIDEO_CAPTURE_CATEGORY = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

function vcamDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vcam')
    : path.join(__dirname, '..', '..', 'native', 'out');
}
const helperPath = () => process.env.ECLIPSE_VCAM_HELPER || path.join(vcamDir(), 'eclipse-vcam.exe');
const dllPath = (arch = 'x64') => path.join(vcamDir(), arch, 'softcam.dll');

let proc = null;
let state = 'off';        // off | starting | ready | error | unsupported
let errorReason = '';
let installed = null;     // null = unknown
let dropped = 0;
let listeners = [];

function emit() {
  const s = status();
  listeners.forEach((fn) => fn(s));
}

function status() {
  return { state, error: errorReason, installed, width: WIDTH, height: HEIGHT, fps: FPS, name: 'EclipseLiveCam' };
}

function onStatus(fn) { listeners.push(fn); }

function isSupported() {
  return process.platform === 'win32' || !!process.env.ECLIPSE_VCAM_HELPER;
}

const regKeyExists = (key) => new Promise((resolve) => {
  execFile('reg', ['query', key], { windowsHide: true }, (err) => resolve(!err));
});

// Is the DirectShow filter registered, i.e. can other apps see the camera?
// Two entries are needed: the COM class (so apps can load the DLL) and the
// "Video Capture Sources" entry (so apps like OBS list it as a camera).
async function checkInstalled() {
  if (process.env.ECLIPSE_VCAM_HELPER) return true;
  if (process.platform !== 'win32') return false;
  const [comClass, deviceEntry] = await Promise.all([
    regKeyExists(`HKCR\\CLSID\\${CAMERA_CLSID}\\InprocServer32`),
    regKeyExists(`HKCR\\CLSID\\${VIDEO_CAPTURE_CATEGORY}\\Instance\\${CAMERA_NAME}`),
  ]);
  return comClass && deviceEntry;
}

async function refreshInstalled() {
  installed = await checkInstalled();
  emit();
  return installed;
}

// Register the camera (UAC prompt). Normally the installer does this; this is
// the repair path if it was skipped or another tool removed it.
function install() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const regsvr = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'regsvr32.exe');
  const regsvr32bit = path.join(process.env.WINDIR || 'C:\\Windows', 'SysWOW64', 'regsvr32.exe');
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const cmds = [`Start-Process -FilePath ${q(regsvr)} -ArgumentList '/s',${q('"' + dllPath('x64') + '"')} -Verb RunAs -Wait`];
  if (fs.existsSync(dllPath('x86')) && fs.existsSync(regsvr32bit)) {
    cmds.push(`Start-Process -FilePath ${q(regsvr32bit)} -ArgumentList '/s',${q('"' + dllPath('x86') + '"')} -Verb RunAs -Wait`);
  }
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmds.join('; ')],
      { windowsHide: true }, async () => resolve(await refreshInstalled()));
  });
}

function start() {
  if (proc) return;
  if (!isSupported()) { state = 'unsupported'; emit(); return; }
  if (!fs.existsSync(helperPath())) {
    state = 'error'; errorReason = 'helper-missing'; emit();
    return;
  }

  state = 'starting'; errorReason = ''; emit();
  const args = [dllPath('x64'), String(WIDTH), String(HEIGHT), String(FPS)];
  const child = spawn(helperPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  proc = child;

  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (line === 'READY') { state = 'ready'; emit(); }
      else if (line.startsWith('ERROR')) { state = 'error'; errorReason = line.slice(6); emit(); }
    }
  });
  // The helper exiting closes the pipe; swallow the resulting EPIPE.
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    if (proc === child) proc = null;
    state = 'error'; errorReason = err.code || 'spawn-failed'; emit();
  });
  child.on('exit', () => {
    if (proc === child) proc = null;
    if (state !== 'error') { state = 'off'; emit(); }
  });
}

// Called for every frame the renderer captures. Frames are dropped rather than
// queued when the helper falls behind, so the camera never lags behind live.
function frame(data) {
  if (!proc || state !== 'ready') return;
  if (data.byteLength !== FRAME_BYTES) return;
  if (proc.stdin.writableNeedDrain) { dropped++; return; }
  proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

function stop() {
  const child = proc;
  proc = null;
  if (!child) return;
  try { child.stdin.end(); } catch {}
  // The helper exits on stdin EOF; make sure it does.
  setTimeout(() => { try { child.kill(); } catch {} }, 2000);
  state = 'off'; emit();
}

module.exports = { start, stop, frame, status, onStatus, install, refreshInstalled, isSupported, WIDTH, HEIGHT, FPS };
