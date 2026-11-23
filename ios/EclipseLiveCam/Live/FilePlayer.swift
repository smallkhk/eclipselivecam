import AVFoundation
import QuartzCore

/// Plays a local video file and hands out its frames as pixel buffers. Used for
/// "Play a video file (no AI)": the frames go into the same OutputHub the AI
/// output would, so the clip shows on screen, in Picture-in-Picture, in
/// recordings and on the share link — with no camera and no AI engine.
final class FilePlayer: NSObject {
    private let player = AVPlayer()
    private var output: AVPlayerItemVideoOutput?
    private var link: CADisplayLink?
    var onFrame: ((CVPixelBuffer) -> Void)?

    func start(url: URL) {
        let item = AVPlayerItem(asset: AVURLAsset(url: url))
        let out = AVPlayerItemVideoOutput(pixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        item.add(out)
        output = out
        player.replaceCurrentItem(with: item)
        player.isMuted = false
        player.actionAtItemEnd = .none
        NotificationCenter.default.addObserver(self, selector: #selector(loop),
                                               name: .AVPlayerItemDidPlayToEndTime, object: item)
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
        player.play()
    }

    @objc private func loop() {
        player.seek(to: .zero) { [weak self] _ in self?.player.play() }
    }

    @objc private func tick() {
        guard let out = output else { return }
        let t = player.currentTime()
        guard out.hasNewPixelBuffer(forItemTime: t),
              let pb = out.copyPixelBuffer(forItemTime: t, itemTimeForDisplay: nil) else { return }
        onFrame?(pb)
    }

    func stop() {
        link?.invalidate(); link = nil
        NotificationCenter.default.removeObserver(self)
        player.pause()
        player.replaceCurrentItem(with: nil)
        output = nil
        onFrame = nil
    }
}
