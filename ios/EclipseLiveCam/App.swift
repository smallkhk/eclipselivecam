import SafariServices
import SwiftUI

@main
struct EclipseLiveCamApp: App {
    @StateObject private var app = AppModel()
    @StateObject private var live = LiveController()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .environmentObject(live)
                .preferredColorScheme(.dark)
                .tint(Theme.brand2)
                .onAppear { live.onBalance = { [weak app] b in app?.setBalance(b) } }
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    enum Stage { case loading, offline, activate, login, studio }
    @Published var stage: Stage = .loading
    @Published var user: Account?
    @Published var error = ""

    private static let tokenKey = "deviceToken"

    init() {
        NotificationCenter.default.addObserver(forName: .eclipseLoggedOut, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.stage == .studio else { return }
                self.user = nil; self.stage = .login
            }
        }
    }

    /// Activation first (like the desktop app), then the login, then the Studio.
    func boot() async {
        stage = .loading; error = ""
        if let token = Keychain.get(Self.tokenKey) {
            do {
                try await API.shared.post("/api/activate.php?action=verify", ["device_token": token], timeout: 15)
            } catch let e as APIError where e.status != 0 {
                // the server says no: the key was revoked or the token is unknown
                Keychain.set(Self.tokenKey, nil)
                stage = .activate
                return
            } catch {
                // can't reach the server: don't lock out a paying customer, carry on
            }
        } else {
            stage = .activate
            return
        }
        await loadUser()
    }

    func activate(key: String) async throws {
        let r = try await API.shared.post("/api/activate.php?action=validate", [
            "key": key.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            "device_token": Keychain.get(Self.tokenKey) ?? "",
        ])
        guard let token = r["device_token"] as? String, !token.isEmpty else {
            throw APIError(message: "Activation could not be confirmed with the server. Please try again.", status: 0)
        }
        try await API.shared.post("/api/activate.php?action=verify", ["device_token": token])
        Keychain.set(Self.tokenKey, token)
        await loadUser()
    }

    func loadUser() async {
        do {
            let r = try await API.shared.get("/api/auth.php?action=me")
            user = Account(r["user"])
            stage = user == nil ? .login : .studio
        } catch let e as APIError where e.status == 401 {
            user = nil; stage = .login
        } catch {
            self.error = error.localizedDescription
            stage = .offline
        }
    }

    func login(email: String, password: String) async throws {
        try await API.shared.post("/api/auth.php?action=login", [
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password,
        ])
        await loadUser()
        if stage != .studio { throw APIError(message: error.isEmpty ? "Login did not stick. Please try again." : error, status: 0) }
    }

    func logout() async {
        _ = try? await API.shared.post("/api/auth.php?action=logout", [:])
        API.shared.clearCookies()
        user = nil
        stage = .login
    }

    func refreshBalance() async {
        if let r = try? await API.shared.get("/api/auth.php?action=me"), let u = Account(r["user"]) { user = u }
    }

    func setBalance(_ points: Int) { user?.points = points }
}

struct RootView: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        Group {
            switch app.stage {
            case .loading: SplashView()
            case .offline: OfflineView()
            case .activate: ActivationView()
            case .login: LoginView()
            case .studio: StudioView()
            }
        }
        .screenBackground()
        .task { await app.boot() }
    }
}

struct SplashView: View {
    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Logo(size: 34)
            ProgressView().tint(Theme.brand2)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

struct OfflineView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Logo(size: 30)
            Text("Can't reach EclipseLiveCam").font(.headline).foregroundStyle(Theme.text)
            Text(app.error).font(.footnote).foregroundStyle(Theme.dim).multilineTextAlignment(.center)
            Button("Try again") { Task { await app.boot() } }.buttonStyle(SoftButtonStyle())
            Spacer()
        }
        .padding(24)
    }
}

struct ActivationView: View {
    @EnvironmentObject var app: AppModel
    @State private var key = ""
    @State private var error = ""
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Logo(size: 30).padding(.top, 48)
                Text("Activate this device").font(.system(size: 28, weight: .bold)).foregroundStyle(Theme.text)
                Text("Enter the activation key you received (it looks like ECLPS-XXXXX-XXXXX-XXXXX).")
                    .foregroundStyle(Theme.dim)
                Field(label: "Activation key", text: $key, caps: .characters)
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Theme.bad) }
                Button {
                    Task {
                        busy = true; error = ""
                        do { try await app.activate(key: key) } catch { self.error = error.localizedDescription }
                        busy = false
                    }
                } label: {
                    if busy { ProgressView().tint(.white) } else { Text("Activate this device") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy || key.trimmingCharacters(in: .whitespaces).count < 8)
            }
            .padding(24)
        }
    }
}

struct LoginView: View {
    @EnvironmentObject var app: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var error = ""
    @State private var busy = false
    @State private var web: URL?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Logo(size: 30).padding(.top, 48)
                Text("Log in").font(.system(size: 28, weight: .bold)).foregroundStyle(Theme.text)
                Text("Live AI video, on your phone.").foregroundStyle(Theme.dim)
                Field(label: "Email", text: $email, keyboard: .emailAddress, content: .emailAddress)
                Field(label: "Password", text: $password, secure: true, content: .password)
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Theme.bad) }
                Button {
                    Task {
                        busy = true; error = ""
                        do { try await app.login(email: email, password: password); password = "" }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                } label: {
                    if busy { ProgressView().tint(.white) } else { Text("Log in") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy || email.isEmpty || password.isEmpty)
                HStack {
                    Button("Create an account") { web = Server.page("/register.html") }
                    Spacer()
                    Button("Forgot password?") { web = Server.page("/forgot.html") }
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.brand2)
            }
            .padding(24)
        }
        .sheet(item: $web) { SafariView(url: $0).ignoresSafeArea() }
    }
}

extension URL: Identifiable { public var id: String { absoluteString } }

/// The website's own pages (sign-up, password reset, top-up) inside the app.
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let vc = SFSafariViewController(url: url)
        vc.preferredBarTintColor = UIColor(Theme.bg)
        vc.preferredControlTintColor = UIColor(Theme.brand2)
        return vc
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
