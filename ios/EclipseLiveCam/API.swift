import Foundation
import Security

/// The EclipseLiveCam server: accounts, credits, activation, and the short-lived AI tokens.
/// The video itself goes straight between the phone and the AI provider.
enum Server {
    /// Built into the app (Info.plist, set by CI); defaults to the live site.
    static let base: URL = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "EclipseServerURL") as? String) ?? ""
        return URL(string: raw.isEmpty ? "https://eclipselivecam.online" : raw) ?? URL(string: "https://eclipselivecam.online")!
    }()
    static var origin: String {
        var c = URLComponents(); c.scheme = base.scheme; c.host = base.host; c.port = base.port
        return c.string ?? "https://eclipselivecam.online"
    }
    static func page(_ path: String) -> URL { URL(string: path, relativeTo: base)!.absoluteURL }
}

struct APIError: LocalizedError {
    let message: String
    let status: Int
    var errorDescription: String? { message }
}

extension Notification.Name {
    static let eclipseLoggedOut = Notification.Name("eclipseLoggedOut")
}

/// JSON API of the EclipseLiveCam server (the same PHP endpoints the desktop app and website use).
/// Login is the server's PHP session cookie, kept in the shared cookie store between launches.
final class API {
    static let shared = API()
    let session: URLSession

    private init() {
        let c = URLSessionConfiguration.default
        c.httpCookieStorage = .shared
        c.httpShouldSetCookies = true
        c.httpCookieAcceptPolicy = .always
        c.timeoutIntervalForRequest = 45
        session = URLSession(configuration: c)
    }

    func request(_ path: String, method: String = "GET", json: [String: Any]? = nil) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: Server.base)?.absoluteURL else {
            throw APIError(message: "Bad address", status: 0)
        }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue(Server.origin, forHTTPHeaderField: "Origin")
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    /// Sends a request and returns the JSON object. Throws the server's own error message when
    /// the status is not 2xx or the reply says `ok: false`, like the website's API helper.
    @discardableResult
    func call(_ path: String, method: String = "GET", json: [String: Any]? = nil, timeout: Double = 45) async throws -> [String: Any] {
        var req = try request(path, method: method, json: json)
        req.timeoutInterval = timeout
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) }
        catch { throw APIError(message: "Could not reach the EclipseLiveCam server. Check your internet connection.", status: 0) }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw APIError(message: "Server returned an unreadable response (HTTP \(code)).", status: code)
        }
        if !(200..<300).contains(code) || (obj["ok"] as? Bool) == false {
            if code == 401, !path.contains("action=login") {
                await MainActor.run { NotificationCenter.default.post(name: .eclipseLoggedOut, object: nil) }
            }
            throw APIError(message: (obj["error"] as? String) ?? "Request failed (HTTP \(code)).", status: code)
        }
        return obj
    }

    func get(_ path: String) async throws -> [String: Any] { try await call(path) }
    @discardableResult
    func post(_ path: String, _ body: [String: Any] = [:], timeout: Double = 45) async throws -> [String: Any] {
        try await call(path, method: "POST", json: body, timeout: timeout)
    }

    func clearCookies() {
        HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
    }
}

// MARK: - models

struct Account: Equatable {
    var id: String
    var name: String
    var email: String
    var points: Int

    init?(_ obj: Any?) {
        guard let u = obj as? [String: Any] else { return nil }
        id = String(describing: u["id"] ?? "")
        email = u["email"] as? String ?? ""
        name = (u["name"] as? String) ?? (u["username"] as? String) ?? email
        points = Account.int(u["points"]) ?? 0
    }

    static func int(_ v: Any?) -> Int? {
        if let i = v as? Int { return i }
        if let d = v as? Double { return Int(d) }
        if let s = v as? String { return Int(s) }
        return nil
    }
}

/// A live model from the server's catalog (api/job.php?action=models, realtime only).
struct StudioModel: Identifiable, Hashable {
    let id: String
    let label: String
    let perSecond: Double

    /// fal model ids look like "owner/name" (Eden Live); Decart ids don't.
    var isEden: Bool { id.contains("/") }
    var isTryOn: Bool { id.lowercased().contains("vton") }

    /// The model's native input size and frame rate (landscape).
    var spec: (width: Int, height: Int, fps: Double) {
        if isEden { return (832, 480, 16) }
        switch id {
        case "lucy-2.5", "lucy-2.6": return (1280, 720, 30)
        case "lucy-restyle-2", "lucy-restyle-latest": return (1280, 704, 30)
        case "lucy-2.1", "lucy-vton-2", "lucy-vton-3", "lucy-latest", "lucy-vton-latest", "lucy-2.1-vton-2": return (1088, 624, 30)
        default: return (1280, 720, 30)
        }
    }
}

/// Small Keychain wrapper for the activation token.
enum Keychain {
    private static let service = "online.eclipselivecam.ios"

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func set(_ key: String, _ value: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
