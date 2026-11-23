// Local-only watch server. Serves the live AI output to a browser on THIS
// computer with near-zero latency (no internet round-trip). Bound to 127.0.0.1,
// so it is reachable only from this PC. It serves its own watch page and the
// latest JPEG, and sets NO CORS headers — other websites' scripts cannot read
// the frames, so this is display-only, not a cross-origin source.
const http = require('http');

let server = null;
let port = 0;
let latest = null;      // Buffer of the latest JPEG
let latestAt = 0;
const STALE_MS = 2500;

function setFrame(buf) {
  if (!buf || !buf.length) return;
  latest = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  latestAt = Date.now();
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>EclipseLiveCam — Local</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box;margin:0;padding:0}
  body{background:#06070d;color:#eef1f8;font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:10px;padding:12px 16px}
  .brand{font-weight:800}.status{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:.82rem;color:#9aa3b8}
  .dot{width:9px;height:9px;border-radius:50%;background:#626b82}
  .status.live .dot{background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,.15)}
  main{flex:1;display:flex;align-items:center;justify-content:center;padding:8px 16px 20px}
  .stage{position:relative;width:100%;max-width:640px;background:#000;border:1px solid #232838;border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center}
  .stage img{width:100%;height:auto;display:none}
  .msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa3b8;font-size:.95rem;text-align:center;padding:24px}
  footer{text-align:center;padding:12px;color:#626b82;font-size:.78rem}
</style></head><body>
<header><span class="brand">EclipseLiveCam</span><span class="status" id="st"><span class="dot"></span><span id="stt">Connecting…</span></span></header>
<main><div class="stage"><img id="v" alt=""><div class="msg" id="msg">Waiting for the live output…</div></div></main>
<footer>Local preview · this computer only</footer>
<script>
var img=document.getElementById('v'),msg=document.getElementById('msg'),st=document.getElementById('st'),stt=document.getElementById('stt');
var live=false,inflight=0,MAXQ=3,lastShown=0;
function setLive(on){live=on;st.classList.toggle('live',on);stt.textContent=on?'Live':'Offline';if(!on){img.style.display='none';msg.style.display='flex';msg.textContent='Offline — start a stream in the app.';}}
function tick(){
  if(inflight>=MAXQ)return;
  inflight++;var t=Date.now();var im=new Image();
  im.onload=function(){ if(t>=lastShown){lastShown=t;img.src=im.src;img.style.display='block';msg.style.display='none';if(!live)setLive(true);} inflight--; };
  im.onerror=function(){ inflight--; if(live)setLive(false); };
  im.src='/view?t='+t;
}
setInterval(tick,40);
</script></body></html>`;

function handle(req, res) {
  const u = (req.url || '/').split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (u === '/view') {
    if (!latest || Date.now() - latestAt > STALE_MS) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(latest);
    return;
  }
  res.writeHead(404); res.end();
}

function start() {
  if (server) return;
  const tryPort = (p, left) => {
    const s = http.createServer(handle);
    s.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
    });
    s.listen(p, '127.0.0.1', () => { server = s; port = p; });
  };
  tryPort(8723, 20);
}

function url() { return port ? `http://127.0.0.1:${port}/` : ''; }
function stop() { if (server) { try { server.close(); } catch {} server = null; port = 0; } }

module.exports = { start, setFrame, url, stop };
