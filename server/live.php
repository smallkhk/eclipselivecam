<?php
// Public watch page for a shared live character. No login, no data except the token.
$s = substr(preg_replace('/[^a-f0-9]/', '', (string)($_GET['s'] ?? '')), 0, 20);
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>EclipseLiveCam — Live</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #06070d; color: #eef1f8; font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
         min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
  .logo { width: 22px; height: 22px; border-radius: 50%;
          background: linear-gradient(120deg,#7c5cff,#22d3ee); position: relative; overflow: hidden; flex: none; }
  .logo::after { content: ""; position: absolute; width: 17px; height: 17px; border-radius: 50%; background: #06070d; top: -4px; right: -5px; }
  .brand { font-weight: 800; font-size: 1rem; }
  .status { margin-left: auto; display: flex; align-items: center; gap: 7px; font-size: .82rem; color: #9aa3b8; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #626b82; }
  .status.live .dot { background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.15); }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 8px 16px 20px; }
  .stage { position: relative; width: 100%; max-width: 520px; aspect-ratio: 9/16; background: #000;
           border: 1px solid #232838; border-radius: 20px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .stage img { width: 100%; height: 100%; object-fit: contain; display: none; background: #000; }
  .msg { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
         gap: 10px; text-align: center; padding: 24px; color: #9aa3b8; font-size: .95rem; }
  .spin { width: 30px; height: 30px; border: 3px solid #232838; border-top-color: #22d3ee; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #sound { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); -webkit-appearance: none; appearance: none;
           border: 1px solid #2c3160; background: rgba(0,0,0,.55); color: #eef1f8; font: 600 .85rem inherit;
           padding: 9px 16px; border-radius: 999px; cursor: pointer; backdrop-filter: blur(6px); }
  #sound[hidden] { display: none; }
  footer { text-align: center; padding: 12px; color: #626b82; font-size: .78rem; }
  footer a { color: #22d3ee; text-decoration: none; }
</style>
</head>
<body>
<header>
  <span class="logo"></span>
  <span class="brand" id="name">EclipseLiveCam</span>
  <span class="status" id="status"><span class="dot"></span><span id="statusText">Connecting…</span></span>
</header>
<main>
  <div class="stage">
    <img id="v" alt="Live stream">
    <div class="msg" id="msg"><div class="spin"></div><div id="msgText">Connecting…</div></div>
    <button id="sound" hidden>🔊 Tap for sound</button>
  </div>
</main>
<footer>Live AI video by <a href="/">EclipseLiveCam</a></footer>
<script>
  var s = <?= json_encode($s) ?>;
  var img = document.getElementById('v'), msg = document.getElementById('msg'), msgText = document.getElementById('msgText');
  var statusEl = document.getElementById('status'), statusText = document.getElementById('statusText'), nameEl = document.getElementById('name');
  var soundBtn = document.getElementById('sound');
  var vid = '';
  try { vid = localStorage.getItem('ec_viewer') || (Math.random().toString(36).slice(2) + Date.now().toString(36)); localStorage.setItem('ec_viewer', vid); }
  catch (e) { vid = Math.random().toString(36).slice(2); }

  var live = false, loading = false, missing = false;
  var audioCtx = null, soundOn = false, audioAfter = null, audioBusy = false, nextPlay = 0;

  function setOffline(text) {
    live = false; img.style.display = 'none'; msg.style.display = 'flex';
    msgText.textContent = text; statusEl.classList.remove('live'); statusText.textContent = 'Offline';
    soundBtn.hidden = true;
  }
  function setLive() { live = true; statusEl.classList.add('live'); statusText.textContent = 'Live'; if (!soundOn) soundBtn.hidden = false; }

  soundBtn.addEventListener('click', function () {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
      soundOn = true; nextPlay = audioCtx.currentTime; soundBtn.hidden = true;
    } catch (e) {}
  });

  async function poll() {
    if (!s) { msg.querySelector('.spin').style.display = 'none'; setOffline('No live link.'); return; }
    try {
      var r = await fetch('/api/live.php?action=poll&s=' + s + '&v=' + vid, { cache: 'no-store' });
      if (r.status === 404) { missing = true; msg.querySelector('.spin').style.display = 'none'; setOffline('This live link was not found.'); return; }
      if (!r.ok) return;
      var d = await r.json();
      if (d.name) nameEl.textContent = d.name;
      if (audioAfter === null && typeof d.audioSeq === 'number') audioAfter = d.audioSeq;   // join at "now", skip old audio
      if (d.live) {
        if (!live) setLive();
        statusText.textContent = d.viewers > 0 ? 'Live · ' + d.viewers + ' watching' : 'Live';
      } else { msg.querySelector('.spin').style.display = 'none'; setOffline('Offline — the stream hasn\u2019t started yet, or it has ended.'); }
    } catch (e) {}
  }

  function videoLoop() {
    if (live && !loading) {
      loading = true;
      var im = new Image();
      im.onload = function () { img.src = im.src; img.style.display = 'block'; msg.style.display = 'none'; loading = false; };
      im.onerror = function () { loading = false; };
      im.src = '/api/live.php?action=view&s=' + s + '&v=' + vid + '&t=' + Date.now();
    }
    requestAnimationFrame(videoLoop);
  }

  function playPCM(ab) {
    var i16 = new Int16Array(ab); if (!i16.length || !audioCtx) return;
    var f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    var buf = audioCtx.createBuffer(1, f32.length, 24000);
    buf.getChannelData(0).set(f32);
    var src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
    var now = audioCtx.currentTime;
    if (nextPlay < now) nextPlay = now + 0.04;
    src.start(nextPlay); nextPlay += buf.duration;
  }

  async function pullAudio() {
    if (!soundOn || !live || audioAfter === null || audioBusy) return;
    audioBusy = true;
    try {
      for (var i = 0; i < 20; i++) {
        var r = await fetch('/api/live.php?action=audiopoll&s=' + s + '&after=' + audioAfter, { cache: 'no-store' });
        if (r.status !== 200) break;
        var seq = parseInt(r.headers.get('X-Seq') || '0', 10);
        var ab = await r.arrayBuffer();
        playPCM(ab);
        if (seq > audioAfter) audioAfter = seq; else break;
      }
    } catch (e) {}
    audioBusy = false;
  }

  poll();
  setInterval(function () { if (!missing) poll(); }, 2500);
  setInterval(pullAudio, 250);
  requestAnimationFrame(videoLoop);
</script>
</body>
</html>
