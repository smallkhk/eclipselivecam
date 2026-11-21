import CoreMedia
import Foundation
import QuartzCore
import UIKit

/// "Share live to my link": JPEG-encodes the AI output at a capped frame rate and uploads the latest
/// frame to the EclipseLiveCam server (api/live.php), which serves it to anyone who opens the watch
/// link in a browser. Openly a watch page — it does not pretend to be a camera in another app.
///
/// One upload is in flight at a time; while it is, newer frames are dropped rather than queued, so a
/// slow uplink costs frame rate, never lag that grows without bound.
final class ShareStreamer {
    private let queue = DispatchQueue(label: "eclipse.share", qos: .userInitiated)
    private var inFlight = false
    private var stopped = false
    private var lastSent: CFTimeInterval = 0
    private var failures = 0
    private let fps: Double = 12
    private let maxSide: CGFloat = 960
    private var audioInFlight = false
    private var audioQueue: [Data] = []

    /// main thread
    var onViewers: ((Int) -> Void)?
    var onProblem: ((String?) -> Void)?

    /// A zoom-framed output buffer, from the output queue.
    func encode(_ pb: CVPixelBuffer) {
        queue.async { self.handle(pb) }
    }

    private func handle(_ pb: CVPixelBuffer) {
        guard !stopped, !inFlight else { return }
        let now = CACurrentMediaTime()
        guard now - lastSent >= 1 / fps - 0.005 else { return }
        lastSent = now
        guard let jpeg = FrameOps.jpeg(pb, maxSide: maxSide, quality: 0.5) else { return }
        upload(jpeg)
    }

    private func upload(_ jpeg: Data) {
        guard var req = try? API.shared.request("/api/live.php?action=frame", method: "POST") else { return }
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 10
        inFlight = true
        API.shared.session.uploadTask(with: req, from: jpeg) { [weak self] data, resp, err in
            guard let self else { return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let viewers = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["viewers"] as? Int
            self.queue.async {
                self.inFlight = false
                if err != nil || code != 200 {
                    self.failures += 1
                    if self.failures == 3 {
                        let msg = code == 401 ? "Log in again to share live" : "Live link: can't reach the server"
                        DispatchQueue.main.async { self.onProblem?(msg) }
                    }
                } else {
                    if self.failures >= 3 { DispatchQueue.main.async { self.onProblem?(nil) } }
                    self.failures = 0
                    if let viewers { DispatchQueue.main.async { self.onViewers?(viewers) } }
                }
            }
        }.resume()
    }

    /// The changed-voice audio (24 kHz s16le mono), one phrase chunk at a time, in order.
    func sendAudio(_ pcm: Data) {
        queue.async {
            guard !self.stopped, !pcm.isEmpty else { return }
            if self.audioQueue.count > 8 { self.audioQueue.removeFirst(self.audioQueue.count - 8) }
            self.audioQueue.append(pcm)
            self.flushAudio()
        }
    }

    private func flushAudio() {
        guard !audioInFlight, !stopped, !audioQueue.isEmpty else { return }
        let chunk = audioQueue.removeFirst()
        guard var req = try? API.shared.request("/api/live.php?action=audio", method: "POST") else { return }
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 10
        audioInFlight = true
        API.shared.session.uploadTask(with: req, from: chunk) { [weak self] _, _, _ in
            guard let self else { return }
            self.queue.async { self.audioInFlight = false; self.flushAudio() }
        }.resume()
    }

    func stop() {
        queue.async {
            guard !self.stopped else { return }
            self.stopped = true
            Task { try? await API.shared.post("/api/live.php?action=stop") }
        }
    }
}
