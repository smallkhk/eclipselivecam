import SwiftUI

/// EclipseLiveCam look (same palette as the website and desktop app).
enum Theme {
    static let bg = Color(red: 0.024, green: 0.027, blue: 0.051)       // #06070d
    static let elev = Color(red: 0.051, green: 0.059, blue: 0.102)     // #0d0f1a
    static let elev2 = Color(red: 0.078, green: 0.094, blue: 0.149)    // #141826
    static let line = Color(red: 0.137, green: 0.157, blue: 0.220)     // #232838
    static let text = Color(red: 0.933, green: 0.945, blue: 0.973)     // #eef1f8
    static let dim = Color(red: 0.604, green: 0.639, blue: 0.722)      // #9aa3b8
    static let faint = Color(red: 0.384, green: 0.420, blue: 0.510)    // #626b82
    static let brand = Color(red: 0.486, green: 0.361, blue: 1.0)      // #7c5cff
    static let brand2 = Color(red: 0.133, green: 0.827, blue: 0.933)   // #22d3ee
    static let pink = Color(red: 1.0, green: 0.361, blue: 0.541)       // #ff5c8a
    static let good = Color(red: 0.204, green: 0.827, blue: 0.600)     // #34d399
    static let warn = Color(red: 0.984, green: 0.749, blue: 0.141)     // #fbbf24
    static let bad = Color(red: 0.973, green: 0.443, blue: 0.443)      // #f87171
    static let grad = LinearGradient(colors: [brand, brand2], startPoint: .leading, endPoint: .trailing)
}

struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.elev, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.caption.weight(.bold)).tracking(0.6).foregroundStyle(Theme.dim)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var danger = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background {
                if danger { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.bad.opacity(0.85)) }
                else { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.grad) }
            }
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct SoftButtonStyle: ButtonStyle {
    var tint: Color = Theme.text
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 14).frame(minHeight: 40)
            .background(Theme.elev2, in: Capsule())
            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct RoundTool: ButtonStyle {
    var active = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(active ? Theme.pink : Theme.text)
            .padding(.horizontal, 12).frame(minWidth: 42, minHeight: 42)
            .background(.ultraThinMaterial, in: Capsule())
            .environment(\.colorScheme, .dark)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct Field: View {
    let label: String
    @Binding var text: String
    var secure = false
    var keyboard: UIKeyboardType = .default
    var content: UITextContentType? = nil
    var caps: TextInputAutocapitalization = .never
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim)
            Group {
                if secure { SecureField("", text: $text) } else { TextField("", text: $text) }
            }
            .textContentType(content)
            .keyboardType(keyboard)
            .textInputAutocapitalization(caps)
            .autocorrectionDisabled()
            .padding(.horizontal, 14).frame(minHeight: 48)
            .background(Theme.elev2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line, lineWidth: 1))
            .foregroundStyle(Theme.text)
        }
    }
}

struct Pill: View {
    let text: String
    var color: Color = Theme.dim
    var pulsing = false
    @State private var on = false
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 8, height: 8)
                .opacity(pulsing ? (on ? 1 : 0.35) : 1)
                .animation(pulsing ? .easeInOut(duration: 0.8).repeatForever() : .default, value: on)
            Text(text).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 11).padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .environment(\.colorScheme, .dark)
        .onAppear { on = true }
    }
}

struct Logo: View {
    var size: CGFloat = 22
    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().fill(Theme.grad).frame(width: size, height: size)
                Circle().fill(Theme.bg).frame(width: size * 0.78, height: size * 0.78).offset(x: size * 0.22, y: -size * 0.2)
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            Text("EclipseLiveCam").font(.system(size: size * 0.8, weight: .heavy)).foregroundStyle(Theme.text)
        }
    }
}

extension View {
    func screenBackground() -> some View { self.background(Theme.bg.ignoresSafeArea()) }
}
