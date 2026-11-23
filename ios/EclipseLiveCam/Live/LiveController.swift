import AVFoundation
import LiveKit
import SwiftUI
import UIKit

/// Camera frames → (engine, input preview), from the camera queue. Lock-protected so it can be swapped while live.
final class FrameRouter: @unchecked Sendable {
    private let lock = NSLock()
    private var _engine: LiveEngine?
    private weak var _input: VideoSurface?

    var engine: LiveEngine? {
        get { lock.lock(); defer { lock.unlock() }; return _engine }
        set { lock.lock(); _engine = newValue; lock.unlock() }
    }
    var input: VideoSurface? {
        get { lock.lock(); defer { lock.unlock() }; return _input }
        set { lock.lock(); _input = newValue; lock.unlock() }
    }

    func frame(_ pb: CVPixelBuffer) {
        lock.lock(); let e = _engine; let i = _input; lock.unlock()
        e?.pushCamera(pb)
        i?.show(pb)
    }
}

/// One live session: credit hold on the EclipseLiveCam server, camera, AI engine (Decart Lucy or Eden Live),
/// and the billing beats — the same flow as the desktop Studio.
@MainActor
final class LiveController: ObservableObject {
    // choices (kept between launches)
    @AppStorage("ec.model") var modelID = "" { willSet { objectWillChange.send() } }
    @AppStorage("ec.portrait") var portrait = true { willSet { objectWillChange.send() } }
    @AppStorage("ec.mirror") var mirror = true { willSet { objectWillChange.send() } }
    @AppStorage("ec.backCamera") var backCamera = false { willSet { objectWillChange.send() } }
    // voice changer
    @AppStorage("ec.voiceOn") var voiceOn = false { willSet { objectWillChange.send() } }
    @AppStorage("ec.voiceID") var voiceID = "" { willSet { objectWillChange.send() } }
    @AppStorage("ec.voiceName") var voiceName = "" { willSet { objectWillChange.send() } }
    @AppStorage("ec.voiceMode") var voiceMode = "natural" { willSet { objectWillChange.send() } }
    @AppStorage("ec.voiceMonitor") var voiceMonitor = false { willSet { objectWillChange.send() } }
    @AppStorage("ec.avOffset") var avOffset = 0.3 { willSet { objectWillChange.send() } }
    @Published var voiceAvailable = false
    @Published var voicePerSecond = 0
    @Published var voiceState = ""
    private var voice: VoiceEngine?
    private var voiceUsed = false
    @Published var rotation = 0

    @Published var models: [StudioModel] = []
    @Published var modelsError = ""
    @Published var prompt = "Transform the character in the video into the character from the reference image"
    @Published var refImage: UIImage?
    private(set) var refData: Data?
    private var refDirty = false

    // live state
    @Published var running = false
    @Published var starting = false
    @Published var applying = false
    @Published var status = "Idle"
    @Published var statusLive = false
    @Published var note = ""
    @Published var fps = 0
    @Published var outputSize = CGSize(width: 9, height: 16)
    @Published var zoom: CGFloat = 1
    @Published var recording = false
    @Published var recordStart = Date()
    @Published var pipActive = false
    // share-live link
    @AppStorage("ec.shareOn") var shareOn = false { willSet { objectWillChange.send() } }
    @Published var shareURL = ""
    @Published var viewers = 0
    @Published var shareProblem: String?
    // billing
    @Published var elapsed = 0
    @Published var spent = 0
    @Published var maxSeconds = 0

    var onBalance: (Int) -> Void = { _ in }

    @Published var playingFile = false
    private var filePlayer: FilePlayer?
    // local fast preview (this phone only, 127.0.0.1)
    @Published var localURL = ""
    let localServer = LocalServer()

    let camera = Camera()
    let hub = OutputHub()
    let router = FrameRouter()
    let pip = PiPController()
    private weak var outputSurface: VideoSurface?
    private var engine: LiveEngine?
    private var hold: (id: Any, perSecond: Double)?
    private var billingStart: Date?
    private var beatTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?
    private var stopping = false

    var model: StudioModel? { models.first { $0.id == modelID } ?? models.first }
    var isPortraitOutput: Bool { (model.map { !$0.isEden } ?? false) && portrait }
    var previewMirrored: Bool { mirror && !backCamera }
    /// camera + stream keep going when you switch to another app (PiP)
    var keepsRunningInBackground: Bool { camera.worksInBackground && PiPController.supported }

    init() {
        // the app manages the audio session itself (PiP needs one)
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        let router = self.router
        camera.onFrame = { pb, _ in router.frame(pb) }
        hub.onFirstFrame = { [weak self] in Task { @MainActor in self?.firstFrame() } }
        hub.onSize = { [weak self] s in Task { @MainActor in self?.outputSize = s; self?.pip.setAspect(s) } }
        hub.pipDisplay = pip.surface
        pip.onActive = { [weak self] on in Task { @MainActor in self?.pipActive = on } }
        hub.onFPS = { [weak self] f in Task { @MainActor in self?.fps = f } }
    }

    func attachOutput(_ v: VideoSurface) {
        outputSurface = v
        v.framing = hub.framing
        hub.display = v
        pip.attach(source: v)
        v.onFraming = { [weak self] f in
            self?.hub.framing = f
            Task { @MainActor in self?.zoom = f.zoom }
        }
    }
    func attachInput(_ v: VideoSurface) { router.input = v }
    func resetZoom() { outputSurface?.framing = .full }
    func setZoom(_ z: CGFloat) { outputSurface?.setZoom(z) }

    // MARK: catalog

    func loadModels() async {
        do {
            let r = try await API.shared.get("/api/job.php?action=models")
            let list = (r["models"] as? [[String: Any]]) ?? []
            models = list.compactMap { m in
                guard (m["type"] as? String) == "realtime", let id = m["id"] as? String else { return nil }
                let per = (m["perSecond"] as? Double) ?? Double(Account.int(m["perSecond"]) ?? 0)
                return StudioModel(id: id, label: m["label"] as? String ?? id, perSecond: per)
            }
            modelsError = models.isEmpty ? "No live models are switched on right now." : ""
            if !models.contains(where: { $0.id == modelID }), let first = models.first { modelID = first.id }
        } catch {
            modelsError = error.localizedDescription
        }
    }

    // MARK: reference image

    func setReference(_ image: UIImage?) {
        refImage = image
        refData = image?.referenceJPEG()
        refDirty = true
        if running { note = "Press Apply to use the new image" }
    }

    // MARK: start / stop

    func start() async {
        guard !running, !starting, let model else { return }
        if model.isTryOn && refData == nil { note = "Try-on needs a reference image — add the outfit photo first."; return }
        starting = true; note = ""; status = "Reserving credits…"; statusLive = false
        elapsed = 0; spent = 0
        UIApplication.shared.isIdleTimerDisabled = true
        guard await Camera.authorize() else {
            starting = false; status = "Idle"; UIApplication.shared.isIdleTimerDisabled = false
            note = "Allow camera access for EclipseLiveCam in Settings"
            return
        }
        do {
            // 1. The server holds credits (and, for Decart, mints a short-lived token).
            let s = try await API.shared.post("/api/session.php?action=start", ["model": model.id])
            guard let holdId = s["holdId"] else { throw APIError(message: "The server did not open a session.", status: 0) }
            hold = (holdId, (s["perSecond"] as? Double) ?? Double(Account.int(s["perSecond"]) ?? Int(model.perSecond)))
            maxSeconds = Account.int(s["maxSeconds"]) ?? 0
            if let b = Account.int(s["balance"]) { onBalance(b) }

            // 2. Camera at the model's size. Portrait (Lucy only) opens it 9:16 so Lucy answers in portrait.
            let spec = model.spec
            let (w, h) = isPortraitOutput ? (spec.height, spec.width) : (spec.width, spec.height)
            status = "Opening camera…"
            camera.configure(width: w, height: h, fps: spec.fps)
            camera.setRotation(rotation)
            hub.reset()
            hub.avOffset = avOffset
            if voiceOn && voiceAvailable && !voiceID.isEmpty { await startVoice() } else { AudioSessionSetup.activate() }
            try await camera.start(position: backCamera ? .back : .front)
            pip.setEnabled(true)
            startLocal()
            if shareOn { await startShare() }

            // 3. Connect the AI. Neither path puts a permanent key on the phone.
            status = "Connecting to AI…"
            let events = makeEvents()
            let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if model.isEden {
                let eng = EdenEngine(endpoint: model.id, events: events)
                eng.buildAnchor = { img in try Self.smallDataURI(img) }
                engine = eng; router.engine = eng
                let imageURL = try refData.map { try Self.smallDataURI($0) }
                try await eng.start(prompt: text.isEmpty ? "cinematic, high quality" : text, imageURL: imageURL, enhance: false)
            } else {
                guard let token = s["apiKey"] as? String, !token.isEmpty else {
                    throw APIError(message: "The server did not return an AI token.", status: 0)
                }
                let eng = LucyEngine(events: events)
                engine = eng; router.engine = eng
                try await eng.start(token: token, model: model.id, fast: false, width: w, height: h,
                                    prompt: text.isEmpty ? "cinematic, high quality" : text, image: refData, enhance: true)
                beginBilling()   // Decart's session is up once start returns
            }
            refDirty = false
            running = true
            starting = false
        } catch {
            await stop(reason: error.localizedDescription)
        }
    }

    private func makeEvents() -> EngineEvents {
        let hub = self.hub
        var e = EngineEvents()
        e.output = { pb in hub.push(pb) }
        e.state = { [weak self] text, live in Task { @MainActor in
            guard let self, self.running || self.starting else { return }
            self.status = live ? "Live" : text.prefix(1).uppercased() + text.dropFirst()
            self.statusLive = live
        } }
        e.note = { [weak self] text in Task { @MainActor in self?.note = text } }
        e.ended = { [weak self] why in Task { @MainActor in await self?.stop(reason: why) } }
        return e
    }

    private func firstFrame() {
        guard running || starting else { return }
        status = "Live"; statusLive = true
        beginBilling()
    }

    /// Billing (meter + beats) starts once the AI is actually streaming, never while it is connecting.
    private func beginBilling() {
        guard billingStart == nil, let hold else { return }
        billingStart = Date()
        let holdId = hold.id, per = hold.perSecond
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, let start = self.billingStart else { return }
                self.elapsed = Int(Date().timeIntervalSince(start))
                self.spent = Int((Double(self.elapsed) * per).rounded(.up))
                if self.maxSeconds > 0 && self.elapsed >= self.maxSeconds {
                    await self.stop(reason: "Your credits ran out — top up to keep going.")
                    return
                }
            }
        }
        beatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled, let self, let start = self.billingStart else { return }
                let secs = Int(Date().timeIntervalSince(start))
                guard let r = try? await API.shared.post("/api/session.php?action=beat", ["holdId": holdId, "seconds": secs]) else { continue }
                if let b = Account.int(r["balance"]) { self.onBalance(b) }
                if (r["exhausted"] as? Bool) == true {
                    await self.stop(reason: "Your credits ran out — top up to keep going.")
                    return
                }
            }
        }
    }

    // MARK: play a pre-recorded video file (no AI, no credits)

    /// Output a video file straight to the screen, PiP, recording and share link,
    /// with no camera and no AI engine. Any live session is stopped first.
    func playVideoFile(_ url: URL) async {
        if running || starting { await stop() }
        stopFilePlayback()
        elapsed = 0; spent = 0; maxSeconds = 0
        UIApplication.shared.isIdleTimerDisabled = true
        AudioSessionSetup.activate()
        hub.reset()
        hub.avOffset = avOffset
        let hub = self.hub
        let fp = FilePlayer()
        fp.onFrame = { pb in hub.push(pb) }
        filePlayer = fp
        pip.setEnabled(true)
        startLocal()
        if shareOn { await startShare() }
        fp.start(url: url)
        playingFile = true
        running = true
        status = "Playing video file"; statusLive = true; note = ""
    }

    private func stopFilePlayback() {
        filePlayer?.stop(); filePlayer = nil
        playingFile = false
    }

    private func startLocal() {
        localServer.start()
        hub.localServer = localServer
        localURL = localServer.url
    }

    private func stopLocal() {
        hub.localServer = nil
        localServer.stop()
        localURL = ""
    }

    func stop(reason: String = "") async {
        guard !stopping, running || starting || hold != nil else { return }
        stopping = true
        defer { stopping = false }
        stopFilePlayback()
        beatTask?.cancel(); tickTask?.cancel()
        let e = engine
        engine = nil; router.engine = nil
        // Settle: bill the seconds used and refund the rest of the deposit (all of it if we never went live).
        if let h = hold {
            let secs = billingStart.map { Int(Date().timeIntervalSince($0)) } ?? 0
            hold = nil; billingStart = nil
            Task { [weak self] in
                if let r = try? await API.shared.post("/api/session.php?action=stop", ["holdId": h.id, "seconds": secs]),
                   let b = Account.int(r["balance"]) {
                    await MainActor.run { self?.onBalance(b) }
                }
            }
        }
        if recording { await toggleRecording() }
        stopVoice()
        stopShare()
        stopLocal()
        await e?.stop()
        camera.stop()
        pip.setEnabled(false)
        AudioSessionSetup.deactivate()
        router.input?.flush()
        hub.reset()
        running = false; starting = false
        status = "Idle"; statusLive = false; fps = 0
        if !reason.isEmpty && reason != "Stopped" { note = reason }
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func apply() async {
        guard let engine, running else { return }
        applying = true
        do {
            try await engine.apply(prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines), image: refData,
                                   imageChanged: refDirty, enhance: !(model?.isEden ?? false))
            refDirty = false
            note = "Applied"
        } catch { note = error.localizedDescription }
        applying = false
    }

    // MARK: camera

    func flipCamera() async {
        backCamera.toggle()
        guard running || starting else { return }
        do { try await camera.start(position: backCamera ? .back : .front) } catch { note = error.localizedDescription }
    }

    func rotateCamera() {
        rotation = (rotation + 90) % 360
        camera.setRotation(rotation)
    }

    // MARK: voice changer (ElevenLabs via the server's api/voice.php)

    func loadVoiceConfig() async {
        guard let r = try? await API.shared.get("/api/voice.php?action=config") else { voiceAvailable = false; return }
        voiceAvailable = (r["enabled"] as? Bool) == true
        voicePerSecond = Account.int(r["perSecond"]) ?? 0
    }

    private func startVoice() async {
        guard voice == nil, !voiceID.isEmpty else { return }
        guard await VoiceEngine.authorize() else { note = "Allow the microphone for EclipseLiveCam in Settings to change your voice"; return }
        do { try VoiceAudioSession.activate() } catch { note = "Microphone: \(error.localizedDescription)"; return }
        var ev = VoiceEngine.Events()
        let hub = self.hub
        ev.converted = { pcm, at in hub.addVoice(pcm, spokenAt: at) }
        ev.state = { [weak self] s in Task { @MainActor in self?.voiceState = s } }
        ev.balance = { [weak self] b in Task { @MainActor in self?.onBalance(b) } }
        ev.failed = { [weak self] msg in Task { @MainActor in
            self?.voiceState = msg
            self?.note = "Voice: \(msg)"
            let m = msg.lowercased()
            if m.contains("credit") || m.contains("switched off") || m.contains("not set up") { self?.stopVoice() }
        } }
        let v = VoiceEngine(voiceID: voiceID, mode: voiceMode, events: ev)
        v.monitor = voiceMonitor
        do { try v.start(); voice = v; voiceUsed = true } catch { note = "Voice: \(error.localizedDescription)"; voiceState = "" }
    }

    private func stopVoice() {
        voice?.stop()
        voice = nil
        voiceState = ""
        if voiceUsed {
            voiceUsed = false
            // one history line for the whole voice session
            Task { [weak self] in
                if let r = try? await API.shared.post("/api/voice.php?action=stop", [:]), let b = Account.int(r["balance"]) {
                    await MainActor.run { self?.onBalance(b) }
                }
            }
        }
    }

    /// Turn the voice changer on/off, or switch voices or modes, while live.
    func setVoice(on: Bool) async {
        voiceOn = on
        guard running || starting else { return }
        stopVoice()
        if on { await startVoice() } else { AudioSessionSetup.activate() }
    }

    func chooseVoice(id: String, name: String) async {
        voiceID = id; voiceName = name
        if voiceOn && (running || starting) { stopVoice(); await startVoice() }
    }

    func setVoiceMode(_ mode: String) async {
        voiceMode = mode
        if voiceOn && (running || starting) { stopVoice(); await startVoice() }
    }

    func setMonitor(_ on: Bool) { voiceMonitor = on; voice?.monitor = on }
    func setAVOffset(_ v: Double) { avOffset = v; hub.avOffset = v }

    // MARK: share-live link (api/live.php — an open watch page, not a camera)

    /// Fetch the (stable) watch link so it can be shown and copied even before going live.
    func loadShareLink() async {
        if let r = try? await API.shared.get("/api/live.php?action=link"), let u = r["url"] as? String { shareURL = u }
    }

    func setShare(_ on: Bool) async {
        shareOn = on
        guard running || starting else { return }
        if on { await startShare() } else { stopShare() }
    }

    private func startShare() async {
        guard hub.streamer == nil else { return }
        let s = ShareStreamer()
        s.onViewers = { [weak self] n in Task { @MainActor in self?.viewers = n } }
        s.onProblem = { [weak self] p in Task { @MainActor in self?.shareProblem = p } }
        hub.streamer = s
        if let r = try? await API.shared.post("/api/live.php?action=start"), let u = r["url"] as? String {
            shareURL = u
        } else {
            note = "The live link isn't set up on the server yet."
        }
    }

    private func stopShare() {
        hub.streamer?.stop()
        hub.streamer = nil
        viewers = 0
        shareProblem = nil
    }

    // MARK: photo / record

    func takePhoto() async {
        do { try await hub.photo(); note = "Photo saved to Photos"; UINotificationFeedbackGenerator().notificationOccurred(.success) }
        catch { note = error.localizedDescription }
    }

    func toggleRecording() async {
        if recording {
            recording = false
            do { try await hub.stopRecording(); note = "Video saved to Photos" } catch { note = error.localizedDescription }
        } else {
            do { try hub.startRecording(); recordStart = Date(); recording = true } catch { note = error.localizedDescription }
        }
    }

    // MARK: helpers

    /// Eden takes the reference image as a data URI under ~45 KB: shrink the JPEG until it fits.
    nonisolated static func smallDataURI(_ data: Data, maxChars: Int = 44_000) throws -> String {
        guard let img = UIImage(data: data) else { throw APIError(message: "That image could not be read.", status: 0) }
        var side: CGFloat = 640
        for _ in 0..<8 {
            for q in [0.8, 0.65, 0.5] as [CGFloat] {
                guard let jpeg = img.referenceJPEG(maxSide: side, quality: q) else { continue }
                let uri = "data:image/jpeg;base64," + jpeg.base64EncodedString()
                if uri.count <= maxChars { return uri }
            }
            side *= 0.75
        }
        throw APIError(message: "Could not shrink the reference image enough.", status: 0)
    }
}
