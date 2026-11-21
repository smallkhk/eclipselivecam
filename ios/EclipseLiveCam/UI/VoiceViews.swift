import SwiftUI

struct VoiceCard: View {
    @EnvironmentObject var live: LiveController
    @State private var picking = false

    var body: some View {
        Card {
            Toggle(isOn: Binding(get: { live.voiceOn && live.voiceAvailable }, set: { on in Task { await live.setVoice(on: on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Change my voice").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                    Text(live.voiceAvailable
                         ? "ElevenLabs voice changer, about 1–2 s behind you. Recordings get the new voice, lined up with the lips."
                           + (live.voicePerSecond > 0 ? " \(live.voicePerSecond) pts per second of speech." : "")
                         : "Not switched on — the admin turns it on in the admin panel.")
                        .font(.caption).foregroundStyle(Theme.dim)
                }
            }
            .tint(Theme.brand)
            .disabled(!live.voiceAvailable)

            if live.voiceOn && live.voiceAvailable {
                Button { picking = true } label: {
                    HStack {
                        Image(systemName: "waveform").foregroundStyle(Theme.brand)
                        Text(live.voiceName.isEmpty ? "Pick a voice" : live.voiceName).foregroundStyle(Theme.text)
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(Theme.dim)
                    }
                    .padding(12)
                    .background(Theme.elev2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line))
                }
                Picker("Mode", selection: Binding(get: { live.voiceMode }, set: { m in Task { await live.setVoiceMode(m) } })) {
                    Text("Natural").tag("natural")
                    Text("Fast").tag("fast")
                }
                .pickerStyle(.segmented)
                Text(live.voiceMode == "fast" ? "Fast: less delay." : "Natural: best sound, a bit more delay.")
                    .font(.caption).foregroundStyle(Theme.dim)
                Toggle("Hear the new voice (use headphones)", isOn: Binding(get: { live.voiceMonitor }, set: { live.setMonitor($0) }))
                    .font(.subheadline).tint(Theme.brand)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Lip sync").font(.subheadline)
                        Spacer()
                        Text(String(format: "%+.2f s", live.avOffset)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.dim)
                    }
                    Slider(value: Binding(get: { live.avOffset }, set: { live.setAVOffset($0) }), in: -0.3...1.0, step: 0.05).tint(Theme.brand)
                    Text("If the voice is early in your recordings, move right; if it's late, move left.").font(.caption).foregroundStyle(Theme.dim)
                }
                if !live.voiceState.isEmpty && live.running {
                    Text("Voice: \(live.voiceState)").font(.caption).foregroundStyle(Theme.dim)
                }
            }
        }
        .sheet(isPresented: $picking) { VoicePicker().environmentObject(live) }
    }
}

struct VoicePicker: View {
    struct Voice: Identifiable { let id: String; let name: String; let category: String }

    @EnvironmentObject var live: LiveController
    @Environment(\.dismiss) private var dismiss
    @State private var voices: [Voice] = []
    @State private var search = ""
    @State private var error = ""
    @State private var loaded = false

    private var shown: [Voice] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return voices }
        return voices.filter { ($0.name + " " + $0.category).lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                if !error.isEmpty { Text(error).foregroundStyle(Theme.bad) }
                if !loaded { HStack { Spacer(); ProgressView(); Spacer() } }
                ForEach(shown) { v in
                    HStack(spacing: 12) {
                        Image(systemName: "waveform.circle.fill").font(.system(size: 28)).foregroundStyle(Theme.brand)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(v.name).font(.headline)
                            if !v.category.isEmpty { Text(v.category.capitalized).font(.caption).foregroundStyle(Theme.dim) }
                        }
                        Spacer()
                        if v.id == live.voiceID { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.good) }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        Task { await live.chooseVoice(id: v.id, name: v.name) }
                        dismiss()
                    }
                }
            }
            .searchable(text: $search, prompt: "Search voices")
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            let r = try await API.shared.get("/api/voice.php?action=voices")
            voices = ((r["voices"] as? [[String: Any]]) ?? []).compactMap { v in
                guard let id = v["id"] as? String else { return nil }
                return Voice(id: id, name: v["name"] as? String ?? id, category: v["category"] as? String ?? "")
            }
            if voices.isEmpty { error = "No voices on the ElevenLabs account yet." }
        } catch { self.error = error.localizedDescription }
        loaded = true
    }
}
