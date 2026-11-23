import CoreMedia
import Foundation
import Network
import QuartzCore

/// Local-only watch server for THIS phone (127.0.0.1). Serves the live output to
/// Safari on the same device with near-zero latency, alongside the hosted share
/// link. Bound to loopback, so nothing on the network or internet can reach it
/// (and loopback is exempt from iOS's local-network prompt). Display-only: it
/// sets no CORS headers, so other sites' scripts cannot read the frames.
///
/// It keeps serving only while the app is running — i.e. in the foreground or
/// while Picture-in-Picture / background audio keeps it alive.
///
/// Endpoints: `/` watch page, `/view` latest JPEG (204 when not live),
/// `/audio?after=N` the next changed-voice chunk after N (24 kHz s16le mono,
/// `X-Seq` / `X-Rate` headers; 204 when none), `/status` `{"live","audioSeq"}`.
/// The audio mirrors what the share link gets (`ShareStreamer.sendAudio`).
final class LocalServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "eclipse.localserver")
    private let lock = NSLock()
    private var latest: Data?
    private var latestAt = Date.distantPast
    private(set) var port: UInt16 = 0

    // frame encoding (throttled, like the share streamer)
    private let encQueue = DispatchQueue(label: "eclipse.localserver.enc", qos: .userInitiated)
    private var encoding = false
    private var lastEnc: CFTimeInterval = 0
    private let fps: Double = 15
    private let maxSide: CGFloat = 960

    // changed-voice audio, newest last (same chunks the share link uploads)
    static let audioRate = 24000
    private let audioKeep = 60
    private var audio: [(seq: Int, pcm: Data)] = []
    private var audioSeq = 0

    var url: String { port != 0 ? "http://127.0.0.1:\(port)/" : "" }

    // MARK: audio from the output hub

    /// One phrase of the changed voice (24 kHz s16le mono), in order.
    func addAudio(_ pcm: Data) {
        guard !pcm.isEmpty else { return }
        lock.lock()
        audioSeq += 1
        audio.append((audioSeq, pcm))
        if audio.count > audioKeep { audio.removeFirst(audio.count - audioKeep) }
        lock.unlock()
    }

    // MARK: frames from the output hub

    func encode(_ pb: CVPixelBuffer) {
        encQueue.async {
            guard !self.encoding else { return }
            let now = CACurrentMediaTime()
            guard now - self.lastEnc >= 1 / self.fps - 0.004 else { return }
            self.lastEnc = now
            self.encoding = true
            let jpeg = FrameOps.jpeg(pb, maxSide: self.maxSide, quality: 0.6)
            if let jpeg { self.setFrame(jpeg) }
            self.encoding = false
        }
    }

    private func setFrame(_ jpeg: Data) {
        lock.lock(); latest = jpeg; latestAt = Date(); lock.unlock()
    }

    // MARK: lifecycle

    func start() {
        guard listener == nil else { return }
        for p in UInt16(8723)...UInt16(8743) {
            guard let nwPort = NWEndpoint.Port(rawValue: p) else { continue }
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: nwPort)
            guard let l = try? NWListener(using: params) else { continue }
            l.newConnectionHandler = { [weak self] conn in self?.open(conn) }
            l.start(queue: queue)
            listener = l; port = p
            return
        }
    }

    func stop() {
        listener?.cancel(); listener = nil; port = 0
        lock.lock(); latest = nil; audio = []; lock.unlock()
    }

    // MARK: HTTP (minimal)

    private func open(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn)
    }

    private func receive(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, err in
            guard let self else { conn.cancel(); return }
            if let data, let line = String(data: data, encoding: .utf8) {
                let (path, query) = self.target(of: line)
                self.respond(conn, path: path, query: query)
            } else if isComplete || err != nil {
                conn.cancel()
            } else {
                self.receive(conn)
            }
        }
    }

    /// The request's path and its query values (`?after=12` → ["after": "12"]).
    private func target(of request: String) -> (String, [String: String]) {
        guard let first = request.split(separator: "\r\n").first else { return ("/", [:]) }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { return ("/", [:]) }
        let full = String(parts[1])
        guard let q = full.firstIndex(of: "?") else { return (full, [:]) }
        var query: [String: String] = [:]
        for pair in full[full.index(after: q)...].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if let k = kv.first { query[String(k)] = kv.count > 1 ? String(kv[1]) : "" }
        }
        return (String(full[..<q]), query)
    }

    private func respond(_ conn: NWConnection, path: String, query: [String: String]) {
        if path == "/" || path == "/index.html" {
            send(conn, status: "200 OK", type: "text/html; charset=utf-8", body: Data(Self.page.utf8))
        } else if path == "/view" {
            lock.lock(); let d = latest; let fresh = Date().timeIntervalSince(latestAt) < 2.5; lock.unlock()
            if let d, fresh { send(conn, status: "200 OK", type: "image/jpeg", body: d) }
            else { send(conn, status: "204 No Content", type: "image/jpeg", body: Data()) }
        } else if path == "/audio" {
            let after = Int(query["after"] ?? "") ?? 0
            lock.lock()
            let next = audio.first { $0.seq > after }
            let current = audioSeq
            lock.unlock()
            if let next {
                send(conn, status: "200 OK", type: "application/octet-stream", body: next.pcm,
                     extra: ["X-Seq": "\(next.seq)", "X-Rate": "\(Self.audioRate)"])
            } else {
                send(conn, status: "204 No Content", type: "application/octet-stream", body: Data(),
                     extra: ["X-Seq": "\(current)", "X-Rate": "\(Self.audioRate)"])
            }
        } else if path == "/status" {
            lock.lock(); let live = latest != nil && Date().timeIntervalSince(latestAt) < 2.5; let seq = audioSeq; lock.unlock()
            send(conn, status: "200 OK", type: "application/json",
                 body: Data("{\"live\":\(live),\"audioSeq\":\(seq)}".utf8))
        } else {
            send(conn, status: "404 Not Found", type: "text/plain", body: Data("not found".utf8))
        }
    }

    private func send(_ conn: NWConnection, status: String, type: String, body: Data, extra: [String: String] = [:]) {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(type)\r\n"
        for (k, v) in extra { header += "\(k): \(v)\r\n" }
        header += "Content-Length: \(body.count)\r\n"
        header += "Cache-Control: no-store\r\n"
        header += "Connection: close\r\n\r\n"
        var out = Data(header.utf8); out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    static let page = """
    <!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>EclipseLiveCam — Local</title>
    <style>:root{color-scheme:dark}*{box-sizing:border-box;margin:0;padding:0}
    body{background:#06070d;color:#eef1f8;font-family:-apple-system,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
    header{display:flex;align-items:center;gap:10px;padding:12px 16px}.brand{font-weight:800}
    .status{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:.82rem;color:#9aa3b8}
    .dot{width:9px;height:9px;border-radius:50%;background:#626b82}.status.live .dot{background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,.15)}
    main{flex:1;display:flex;align-items:center;justify-content:center;padding:8px 16px 20px}
    .stage{position:relative;width:100%;max-width:520px;background:#000;border:1px solid #232838;border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center}
    .stage img{width:100%;height:auto;display:none}.msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa3b8;text-align:center;padding:24px}
    footer{text-align:center;padding:12px;color:#626b82;font-size:.78rem}</style></head><body>
    <header><span class="brand">EclipseLiveCam</span><span class="status" id="st"><span class="dot"></span><span id="stt">Connecting…</span></span></header>
    <main><div class="stage"><img id="v" alt=""><div class="msg" id="msg">Waiting for the live output…</div></div></main>
    <footer>Local preview · this iPhone only</footer>
    <script>
    var img=document.getElementById('v'),msg=document.getElementById('msg'),st=document.getElementById('st'),stt=document.getElementById('stt');
    var live=false,inflight=0,MAXQ=3,lastShown=0;
    function setLive(on){live=on;st.classList.toggle('live',on);stt.textContent=on?'Live':'Offline';if(!on){img.style.display='none';msg.style.display='flex';msg.textContent='Offline — start a stream in the app.';}}
    function tick(){if(inflight>=MAXQ)return;inflight++;var t=Date.now();var im=new Image();
    im.onload=function(){if(t>=lastShown){lastShown=t;img.src=im.src;img.style.display='block';msg.style.display='none';if(!live)setLive(true);}inflight--;};
    im.onerror=function(){inflight--;if(live)setLive(false);};im.src='/view?t='+t;}
    setInterval(tick,40);
    </script></body></html>
    """
}
