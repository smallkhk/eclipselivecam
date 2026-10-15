/* ── EclipseLiveCam desktop — virtual camera feed ───────────────────────────
 * Only active inside the desktop app (window.eclipseDesktop comes from its
 * preload script). Takes the live AI output the Studio publishes on
 * window.__eclipseStream, fills the camera frame with it (portrait 720×1280 or
 * landscape 1280×720, centre-cropped) and sends each frame to the app, which
 * pushes it into the "EclipseLiveCam" camera.
 * When nothing is streaming the camera shows a branded standby card, so it can
 * stay selected in Zoom/Meet between sessions.
 */
(function () {
  const D = window.eclipseDesktop;
  if (!D) return;

  const FPS = 30;
  const FRAME_MS = 1000 / FPS;
  let W = 720, H = 1280;   // replaced by the camera's real size from the app
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

  let camReady = false;
  let current = null;      // the MediaStream being fed
  let feedToken = 0;       // bumps whenever the stream changes; old loops exit
  let lastSent = 0;

  function send() {
    if (!camReady) return;
    D.vcamFrame(ctx.getImageData(0, 0, W, H).data);
  }

  // Fill the whole camera frame, cropping the edges that don't fit. The AI
  // output is landscape, so a portrait camera keeps the centre (the person).
  function drawCover(src, sw, sh) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!sw || !sh) return;
    const scale = Math.max(W / sw, H / sh);
    const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
    ctx.drawImage(src, (W - dw) >> 1, (H - dh) >> 1, dw, dh);
  }

  function resize(w, h) {
    if (!w || !h || (w === W && h === H)) return;
    W = w; H = h;
    canvas.width = W;
    canvas.height = H;
    if (!current) drawStandby();
  }

  function drawStandby() {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0c0c12');
    g.addColorStop(1, '#1b1030');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2 - 70, 46, 0, Math.PI * 2);
    const lg = ctx.createLinearGradient(W / 2 - 46, H / 2 - 116, W / 2 + 46, H / 2 - 24);
    lg.addColorStop(0, '#7c3aed');
    lg.addColorStop(1, '#a855f7');
    ctx.fillStyle = lg;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(W / 2 + 16, H / 2 - 82, 38, 0, Math.PI * 2);
    ctx.fillStyle = '#120c1f';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8e8f0';
    ctx.font = '700 44px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('EclipseLiveCam', W / 2, H / 2 + 40);
    ctx.fillStyle = 'rgba(232,232,240,.55)';
    ctx.font = '400 24px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Camera on standby — start a live stream in the app', W / 2, H / 2 + 86);
  }

  // Preferred path: read frames straight off the WebRTC track. This keeps
  // working while the window is minimised, unlike drawing from <video>.
  async function feedFromTrack(track, token) {
    const clone = track.clone();
    const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
    try {
      while (token === feedToken) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        const now = performance.now();
        if (token === feedToken && now - lastSent >= FRAME_MS - 2) {
          drawCover(frame, frame.displayWidth, frame.displayHeight);
          send();
          lastSent = now;
        }
        frame.close();
      }
    } finally {
      try { reader.cancel(); } catch {}
      clone.stop();
    }
  }

  // Fallback for engines without MediaStreamTrackProcessor.
  function feedFromVideo(stream, token) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    v.play().catch(() => {});
    const timer = setInterval(() => {
      if (token !== feedToken) { clearInterval(timer); v.srcObject = null; return; }
      if (v.readyState >= 2) { drawCover(v, v.videoWidth, v.videoHeight); send(); }
    }, FRAME_MS);
  }

  function setStream(stream) {
    if (stream === current) return;
    current = stream;
    const token = ++feedToken;
    const track = stream && stream.getVideoTracks()[0];
    if (!track) { drawStandby(); send(); return; }
    if ('MediaStreamTrackProcessor' in window) {
      feedFromTrack(track, token).catch(() => { if (token === feedToken) feedFromVideo(stream, token); });
    } else {
      feedFromVideo(stream, token);
    }
  }

  // The Studio swaps window.__eclipseStream on start/stop.
  setInterval(() => setStream(window.__eclipseStream || null), 300);
  // Re-send the standby card now and then, e.g. after the camera restarts.
  setInterval(() => { if (!current) { drawStandby(); send(); } }, 1000);

  // ── Status UI ───────────────────────────────────────────────────────────────
  const chip = document.getElementById('vcamChip');
  const chipText = document.getElementById('vcamChipText');
  const note = document.getElementById('vcamNote');
  const installBtn = document.getElementById('vcamInstall');

  const ERRORS = {
    'camera-busy': 'Another copy of EclipseLiveCam is already using the camera. Close it and restart the app.',
    'helper-missing': 'The camera component is missing — please reinstall EclipseLiveCam.',
    'dll-not-found': 'The camera component is missing — please reinstall EclipseLiveCam.',
  };

  function render(s) {
    resize(s.width, s.height);
    camReady = s.state === 'ready';
    if (camReady && !current) { drawStandby(); send(); }
    if (!chip) return;

    let cls = '', text = 'Virtual camera', msg = '';
    if (s.state === 'unsupported') {
      text = 'Virtual camera: Windows only';
      msg = 'The EclipseLiveCam camera is available in the Windows version of the app.';
    } else if (s.state === 'error') {
      cls = 'err'; text = 'Virtual camera: error';
      msg = ERRORS[s.error] || `The virtual camera could not start (${s.error || 'unknown error'}).`;
    } else if (s.state === 'ready' && s.installed === false) {
      cls = 'err'; text = 'Virtual camera: not installed';
      msg = 'Other apps can’t see the EclipseLiveCam camera yet. Install it once (Windows will ask for permission).';
    } else if (s.state === 'ready') {
      cls = 'on'; text = 'Virtual camera: on';
      msg = 'Showing your AI output when live, and a standby screen otherwise.';
    } else {
      cls = 'wait'; text = 'Virtual camera: starting…';
    }
    chip.className = 'status' + (cls ? ' ' + cls : '');
    chipText.textContent = text;
    if (note) note.textContent = msg;
    if (installBtn) installBtn.classList.toggle('hidden', !(s.state === 'ready' && s.installed === false));
  }

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installBtn.textContent = 'Installing…';
      const s = await D.vcamInstall().catch(() => null);
      installBtn.disabled = false;
      installBtn.textContent = 'Install the virtual camera';
      if (s && s.installed) toast('EclipseLiveCam camera installed. Restart Zoom/Meet if it was open.');
      else toast('The camera was not installed. Try again and accept the Windows prompt.', true);
    });
  }

  D.onVcamStatus(render);
  D.vcamStatus().then(render);
})();
