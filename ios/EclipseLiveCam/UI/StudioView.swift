import PhotosUI
import SwiftUI

struct StudioView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var live: LiveController
    @Environment(\.verticalSizeClass) private var vClass
    @Environment(\.scenePhase) private var phase
    @State private var showInput = true
    @State private var web: URL?
    @State private var pick: PhotosPickerItem?

    private struct Preset: Hashable { let name: String; let prompt: String }
    private static let presets: [Preset] = [
        Preset(name: "Anime", prompt: "anime style, vibrant cel shading, expressive eyes"),
        Preset(name: "Cyberpunk", prompt: "cyberpunk neon city, rain, cinematic lighting, teal and magenta"),
        Preset(name: "Claymation", prompt: "claymation character, soft studio light, stop-motion look"),
        Preset(name: "Oil painting", prompt: "classical oil painting, thick brush strokes, warm palette"),
        Preset(name: "Pixel art", prompt: "retro 16-bit pixel art, limited palette"),
        Preset(name: "Noir", prompt: "black and white film noir, dramatic shadows, high contrast"),
        Preset(name: "Watercolor", prompt: "soft watercolor illustration, paper texture, pastel"),
        Preset(name: "3D cartoon", prompt: "polished 3D animated movie character, subsurface skin"),
    ]

    private var busy: Bool { live.running || live.starting }

    var body: some View {
        Group {
            if vClass == .compact {
                HStack(spacing: 0) {
                    stage.padding(10)
                    VStack(spacing: 0) {
                        topBar
                        ScrollView { controls.padding(14) }
                        goBar
                    }
                    .frame(width: 380)
                }
            } else {
                VStack(spacing: 0) {
                    topBar
                    stage.padding(.horizontal, 12).padding(.top, 4)
                    ScrollView { controls.padding(14) }
                    goBar
                }
            }
        }
        .screenBackground()
        .task { await live.loadModels(); await live.loadVoiceConfig(); await live.loadShareLink() }
        .sheet(item: $web, onDismiss: { Task { await app.refreshBalance() } }) { SafariView(url: $0).ignoresSafeArea() }
        .onChange(of: phase) { p in
            // With PiP the camera keeps running behind other apps. Without it iOS pauses the camera, so stop billing.
            if p == .background, busy, !live.keepsRunningInBackground {
                Task { await live.stop(reason: "Stopped: this iPhone doesn't let the camera run in the background") }
            }
        }
        .onChange(of: pick) { item in
            guard let item else { return }
            Task {
                if let d = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: d) { live.setReference(img) }
                pick = nil
            }
        }
    }

    // MARK: top bar

    private var topBar: some View {
        HStack(spacing: 10) {
            Logo()
            Spacer()
            Button { web = Server.page("/topup.html") } label: {
                HStack(spacing: 6) {
                    Image(systemName: "bolt.fill").font(.system(size: 12))
                    Text("\(app.user?.points ?? 0) pts").font(.system(size: 14, weight: .bold)).monospacedDigit()
                }
                .foregroundStyle(Theme.warn)
                .padding(.horizontal, 12).frame(height: 34)
                .background(Theme.warn.opacity(0.12), in: Capsule())
            }
            Menu {
                if let u = app.user { Text(u.email.isEmpty ? u.name : u.email) }
                Button { web = Server.page("/topup.html") } label: { Label("Top up credits", systemImage: "creditcard") }
                Button { Task { await app.refreshBalance() } } label: { Label("Refresh balance", systemImage: "arrow.clockwise") }
                Button(role: .destructive) {
                    Task { await live.stop(); await app.logout() }
                } label: { Label("Log out", systemImage: "rectangle.portrait.and.arrow.right") }
            } label: {
                Image(systemName: "person.crop.circle.fill").font(.system(size: 28)).foregroundStyle(Theme.dim)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    // MARK: output + camera preview

    private var stage: some View {
        let size = live.outputSize
        return ZStack {
            RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.elev)
            VideoSurfaceView(mirrored: live.previewMirrored, zoomable: true) { live.attachOutput($0) }
                .aspectRatio(size.width / max(size.height, 1), contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(live.statusLive ? Theme.brand : Theme.line, lineWidth: live.statusLive ? 1.5 : 1))
                .shadow(color: live.statusLive ? Theme.brand.opacity(0.35) : .clear, radius: 24)
            if !busy { idleCard }
            if live.starting && !live.statusLive { ProgressView().tint(Theme.brand2).scaleEffect(1.3) }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 6) {
                Pill(text: live.status, color: live.statusLive ? Theme.good : (busy ? Theme.warn : Theme.dim), pulsing: live.statusLive)
                if live.fps > 0 { Pill(text: "\(live.fps) fps", color: Theme.brand2) }
            }
            .padding(12)
        }
        .overlay(alignment: .topTrailing) {
            if live.shareOn && busy {
                Pill(text: live.shareProblem == nil ? "Link · \(live.viewers) watching" : "Link: slow",
                     color: live.shareProblem == nil ? Theme.good : Theme.bad)
                    .padding(12)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if showInput && busy {
                VideoSurfaceView(mirrored: live.previewMirrored, zoomable: false) { live.attachInput($0) }
                    .aspectRatio(inputAspect, contentMode: .fit)
                    .frame(width: inputAspect < 1 ? 64 : 112)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.brand2.opacity(0.8), lineWidth: 1.5))
                    .padding(12)
                    .onTapGesture { withAnimation { showInput = false } }
            }
        }
        .overlay(alignment: .bottomTrailing) { tools.padding(10) }
    }

    private var inputAspect: CGFloat {
        guard let m = live.model else { return 16.0 / 9 }
        let s = m.spec
        return live.isPortraitOutput ? CGFloat(s.height) / CGFloat(s.width) : CGFloat(s.width) / CGFloat(s.height)
    }

    private var idleCard: some View {
        VStack(spacing: 12) {
            if let img = live.refImage {
                Image(uiImage: img).resizable().scaledToFill().frame(width: 92, height: 92).clipShape(Circle())
                    .overlay(Circle().stroke(Theme.brand, lineWidth: 2))
            } else {
                Image(systemName: "sparkles.tv").font(.system(size: 44)).foregroundStyle(Theme.brand)
            }
            Text("The AI output appears here").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.dim)
            if !live.note.isEmpty {
                Text(live.note).font(.footnote).foregroundStyle(Theme.text.opacity(0.85)).multilineTextAlignment(.center).padding(.horizontal, 20)
            }
        }
    }

    private var tools: some View {
        HStack(spacing: 8) {
            if live.zoom > 1.01 {
                Button { live.resetZoom() } label: { Text(String(format: "%.1f×", live.zoom)).font(.system(size: 13, weight: .bold)) }
                    .buttonStyle(RoundTool())
            }
            if live.running {
                if !showInput { Button { withAnimation { showInput = true } } label: { Image(systemName: "rectangle.inset.bottomleft.filled") }.buttonStyle(RoundTool()) }
                if PiPController.supported {
                    Button { live.pipActive ? live.pip.stop() : live.pip.start() } label: { Image(systemName: live.pipActive ? "pip.exit" : "pip.enter") }
                        .buttonStyle(RoundTool(active: live.pipActive))
                }
                Button { Task { await live.takePhoto() } } label: { Image(systemName: "camera.fill") }.buttonStyle(RoundTool())
                Button { Task { await live.toggleRecording() } } label: {
                    if live.recording {
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            let s = Int(ctx.date.timeIntervalSince(live.recordStart))
                            Label(String(format: "%d:%02d", s / 60, s % 60), systemImage: "stop.fill").font(.system(size: 13, weight: .bold)).monospacedDigit()
                        }
                    } else { Image(systemName: "record.circle") }
                }
                .buttonStyle(RoundTool(active: live.recording))
            }
        }
    }

    // MARK: controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !live.note.isEmpty && busy {
                Text(live.note).font(.footnote).foregroundStyle(Theme.text.opacity(0.85))
            }
            if live.running { meter }

            Card {
                SectionTitle(text: "AI model")
                if live.models.isEmpty {
                    if live.modelsError.isEmpty { ProgressView().tint(Theme.brand2) }
                    else {
                        Text(live.modelsError).font(.footnote).foregroundStyle(Theme.bad)
                        Button("Try again") { Task { await live.loadModels() } }.buttonStyle(SoftButtonStyle())
                    }
                } else {
                    Picker("Model", selection: Binding(get: { live.model?.id ?? "" }, set: { live.modelID = $0 })) {
                        ForEach(live.models) { m in Text("\(m.label) — \(formatRate(m.perSecond)) pts/sec").tag(m.id) }
                    }
                    .pickerStyle(.menu)
                    .disabled(busy)
                }
                if let m = live.model {
                    HStack {
                        SectionTitle(text: "Video shape")
                        Spacer()
                        Picker("", selection: Binding(get: { m.isEden ? false : live.portrait }, set: { live.portrait = $0 })) {
                            Label("Portrait", systemImage: "rectangle.portrait").tag(true)
                            Label("Landscape", systemImage: "rectangle").tag(false)
                        }
                        .pickerStyle(.segmented).frame(width: 200)
                        .disabled(busy || m.isEden)
                    }
                    Text(m.isEden ? "Eden Live streams in landscape only."
                         : live.portrait ? "Portrait 9:16, like a phone video." : "Landscape 16:9.")
                        .font(.caption).foregroundStyle(Theme.dim)
                }
            }

            Card {
                HStack {
                    SectionTitle(text: "Reference image")
                    Spacer()
                    if live.refImage != nil {
                        Button { live.setReference(nil) } label: { Image(systemName: "xmark.circle.fill") }.foregroundStyle(Theme.dim)
                    }
                }
                HStack(spacing: 12) {
                    PhotosPicker(selection: $pick, matching: .images) {
                        ZStack {
                            if let img = live.refImage { Image(uiImage: img).resizable().scaledToFill() }
                            else { Image(systemName: "plus").font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.brand) }
                        }
                        .frame(width: 72, height: 72)
                        .background(Theme.elev2)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(live.refImage != nil ? Theme.brand : Theme.line, lineWidth: live.refImage != nil ? 2 : 1))
                    }
                    Text(live.model?.isTryOn == true ? "The outfit to try on (required)." : "Who or what to become, or a style to copy.")
                        .font(.footnote).foregroundStyle(Theme.dim)
                }
            }

            Card {
                SectionTitle(text: "Prompt")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.presets, id: \.name) { p in
                            Button(p.name) { live.prompt = p.prompt; if live.running { Task { await live.apply() } } }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(live.prompt == p.prompt ? Color.white : Theme.dim)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(live.prompt == p.prompt ? Theme.brand.opacity(0.35) : Theme.elev2, in: Capsule())
                                .overlay(Capsule().stroke(live.prompt == p.prompt ? Theme.brand : Theme.line))
                        }
                    }
                }
                TextField("Describe the change", text: $live.prompt, axis: .vertical)
                    .lineLimit(2...5)
                    .padding(12)
                    .background(Theme.elev2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line))
                    .foregroundStyle(Theme.text)
            }

            VoiceCard()

            Card {
                Toggle(isOn: Binding(get: { live.shareOn }, set: { on in Task { await live.setShare(on) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Share live to my link").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                        Text("Anyone who opens your link watches your character live in a browser — a watch page, not a camera. Turn on the voice changer for sound on the link.")
                            .font(.caption).foregroundStyle(Theme.dim)
                    }
                }
                .tint(Theme.good)
                if !live.shareURL.isEmpty {
                    HStack(spacing: 8) {
                        Text(live.shareURL).font(.caption.monospaced()).foregroundStyle(Theme.brand2).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Button { UIPasteboard.general.string = live.shareURL } label: { Image(systemName: "doc.on.doc") }
                            .foregroundStyle(Theme.dim)
                        ShareLink(item: live.shareURL) { Image(systemName: "square.and.arrow.up") }
                            .foregroundStyle(Theme.dim)
                    }
                    .padding(10)
                    .background(Theme.elev2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line))
                }
            }

            Card {
                SectionTitle(text: "Camera & output")
                HStack(spacing: 8) {
                    Button { Task { await live.flipCamera() } } label: {
                        Label(live.backCamera ? "Back" : "Front", systemImage: "arrow.triangle.2.circlepath.camera")
                    }
                    .buttonStyle(SoftButtonStyle())
                    Button { live.rotateCamera() } label: { Label("\(live.rotation)°", systemImage: "rotate.right") }
                        .buttonStyle(SoftButtonStyle())
                    Button { live.mirror.toggle() } label: {
                        Label("Mirror", systemImage: "arrow.left.and.right.righttriangle.left.righttriangle.right")
                    }
                    .buttonStyle(SoftButtonStyle(tint: live.mirror ? Theme.brand2 : Theme.dim))
                }
                HStack {
                    Image(systemName: "plus.magnifyingglass").foregroundStyle(Theme.dim)
                    Slider(value: Binding(get: { Double(live.zoom) }, set: { live.setZoom(CGFloat($0)) }), in: 1...4).tint(Theme.brand2)
                    Text(String(format: "%.1f×", live.zoom)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.dim).frame(width: 40)
                }
                Text("Pinch the output to zoom, drag to move, double-tap to reset. Photos and recordings go to your Photos.")
                    .font(.caption).foregroundStyle(Theme.dim)
            }
        }
    }

    private var meter: some View {
        Card(padding: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Elapsed").font(.caption).foregroundStyle(Theme.dim)
                    Text(String(format: "%02d:%02d", live.elapsed / 60, live.elapsed % 60)).font(.headline.monospacedDigit()).foregroundStyle(Theme.text)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Spent").font(.caption).foregroundStyle(Theme.dim)
                    Text("\(live.spent) pts").font(.headline.monospacedDigit()).foregroundStyle(Theme.warn)
                }
            }
            if live.maxSeconds > 0 {
                ProgressView(value: Double(max(0, live.maxSeconds - live.elapsed)), total: Double(live.maxSeconds)).tint(Theme.brand2)
                Text("Credit remaining for this session").font(.caption2).foregroundStyle(Theme.faint)
            }
        }
    }

    private func formatRate(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%g", v) }

    // MARK: start / stop bar

    private var goBar: some View {
        HStack(spacing: 10) {
            if busy {
                Button { Task { await live.stop() } } label: { Label("Stop", systemImage: "stop.fill") }
                    .buttonStyle(PrimaryButtonStyle(danger: true))
                if live.running {
                    Button { Task { await live.apply() } } label: {
                        if live.applying { ProgressView().tint(.white) } else { Label("Apply", systemImage: "wand.and.stars") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(live.applying)
                }
            } else {
                Button { Task { await live.start() } } label: { Label("Start live stream", systemImage: "play.fill") }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(live.model == nil)
            }
        }
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 6)
        .background(Theme.bg.shadow(.drop(color: .black.opacity(0.4), radius: 12, y: -4)))
    }
}
