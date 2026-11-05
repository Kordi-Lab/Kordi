import CryptoKit
import Foundation

// HTTP side of browser sign-in. The contract lives in
// docs/development/browser-sign-in.md: the app opens the authorize URL in an
// ASWebAuthenticationSession, receives a one-time code on its callback, and
// exchanges it here with its PKCE verifier.

enum AppSignInIntent: Equatable, Sendable {
    case login
    case signup
}

enum BrowserSignInAvailability: Equatable, Sendable {
    case available
    case unavailable
    case unknown
}

/// PKCE (RFC 7636) and `state` values for one browser sign-in.
struct AppSignInPKCE: Equatable, Sendable {
    let verifier: String
    let challenge: String
    let state: String

    /// 48 random bytes encode to a 64-character verifier, inside the 43-128 range.
    static func make() -> AppSignInPKCE {
        let verifier = randomURLSafeString(byteCount: 48)
        return AppSignInPKCE(
            verifier: verifier,
            challenge: challenge(for: verifier),
            state: randomURLSafeString(byteCount: 32)
        )
    }

    static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// `SystemRandomNumberGenerator` is a cryptographically secure source on Apple platforms.
    static func randomURLSafeString(byteCount: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        return base64URL(Data((0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// What a browser sign-in stores so it can refresh: the access token, the
/// rotating refresh token, and the client and endpoint that issued them.
struct AppSignInCredential: Codable, Equatable, Sendable {
    let accountId: String
    let clientId: String
    let tokenEndpoint: URL
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date

    func expires(within margin: TimeInterval, now: Date) -> Bool {
        expiresAt.timeIntervalSince(now) <= margin
    }

    var expiresAtText: String { ISO8601DateFormatter().string(from: expiresAt) }
}

/// The result of a code exchange.
struct AppSignInGrant: Sendable {
    let account: CloudAccount
    let credential: AppSignInCredential
    let deviceId: String?

    var authResponse: CloudAuthResponse {
        CloudAuthResponse(
            account: account,
            session: CloudSession(token: credential.accessToken, expiresAt: credential.expiresAtText, deviceId: deviceId)
        )
    }
}

enum AppSignInRefreshError: Error, Equatable {
    /// The server refused the refresh token: the sign-in ended.
    case rejected
    /// No answer, or an answer that says nothing about the sign-in. Try again later.
    case unavailable
}

struct AppSignInClient: Sendable {
    /// Sends one request. The app uses `CloudAPIClient.transportData`, which
    /// connects loopback directly and falls back around a broken proxy.
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    static func transport(using api: CloudAPIClient) -> Transport {
        { request in try await api.transportData(for: request, fallback: "Could not reach the server.") }
    }

    static let authorizePath = "/v1/cloud/auth/app/authorize"
    static let tokenPath = "/v1/cloud/auth/app/token"
    static let revokePath = "/v1/cloud/auth/app/revoke"

    let baseURL: URL
    let clientId: String
    let redirectURI: String
    let transport: Transport

    /// Each distribution has its own callback scheme (`kordi`, `kordi-beta`,
    /// `kordi-staging`, ...) and the server registers a matching iPhone client
    /// (`kordi-ios`, `kordi-ios-beta`, `kordi-ios-staging`, ...).
    static func clientId(forCallbackScheme scheme: String) -> String {
        let scheme = scheme.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if scheme.isEmpty || scheme == "kordi" { return "kordi-ios" }
        if scheme.hasPrefix("kordi-") { return "kordi-ios-\(scheme.dropFirst("kordi-".count))" }
        return "\(scheme)-ios"
    }

    static func redirectURI(forCallbackScheme scheme: String) -> String {
        "\(scheme)://auth/callback"
    }

    static func current(environment: KordiAppEnvironment = .current, transport: @escaping Transport) -> AppSignInClient {
        let scheme = environment.oauthCallbackURL.scheme ?? "kordi"
        return AppSignInClient(
            baseURL: environment.cloudBaseURL,
            clientId: clientId(forCallbackScheme: scheme),
            redirectURI: redirectURI(forCallbackScheme: scheme),
            transport: transport
        )
    }

    var tokenEndpoint: URL { endpoint(Self.tokenPath) }

    func authorizeURL(pkce: AppSignInPKCE, intent: AppSignInIntent) -> URL {
        var fields = [
            ("response_type", "code"),
            ("client_id", clientId),
            ("redirect_uri", redirectURI),
            ("code_challenge", pkce.challenge),
            ("code_challenge_method", "S256"),
            ("state", pkce.state),
        ]
        // OpenID Connect `prompt=create` asks the page to open on account creation.
        if intent == .signup { fields.append(("prompt", "create")) }
        return endpoint(Self.authorizePath, query: fields)
    }

    /// Asks whether this server offers browser sign-in for this app. A request
    /// without a redirect URI is refused before any redirect: a server that
    /// knows the client answers `invalid_redirect_uri`; an older server has no
    /// route (404 or 405) and a server without this client answers
    /// `invalid_client`. Any other answer is `unknown`.
    func probe(timeout: TimeInterval = 6) async -> BrowserSignInAvailability {
        var request = URLRequest(url: endpoint(Self.authorizePath, query: [("client_id", clientId)]), timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await transport(request),
              let http = response as? HTTPURLResponse else { return .unknown }
        return Self.availability(status: http.statusCode, body: data)
    }

    static func availability(status: Int, body: Data) -> BrowserSignInAvailability {
        if status == 404 || status == 405 { return .unavailable }
        switch errorCode(in: body) {
        case "invalid_redirect_uri": return .available
        case "invalid_client": return .unavailable
        // Rate limits, proxies, captive portals and outages say nothing about
        // the server's support; ask again next time.
        default: return .unknown
        }
    }

    func exchange(code: String, pkce: AppSignInPKCE, device: CloudDeviceRegistration?, now: Date = Date()) async throws -> AppSignInGrant {
        var fields = [
            ("grant_type", "authorization_code"),
            ("client_id", clientId),
            ("code", code.trimmingCharacters(in: .whitespacesAndNewlines)),
            ("redirect_uri", redirectURI),
            ("code_verifier", pkce.verifier),
        ]
        if let device {
            fields += [
                ("device_public_key", device.publicKey),
                ("device_key_algorithm", device.keyAlgorithm),
                ("device_name", device.displayName),
                ("device_platform", device.platform),
                ("device_os_version", device.osVersion),
                ("device_app_version", device.appVersion),
            ]
        }
        let status: Int
        let body: Data
        do {
            (status, body) = try await Self.postForm(tokenEndpoint, fields, transport: transport)
        } catch let error as CloudAPIError {
            throw error
        } catch {
            throw CloudAPIError(code: "network_error", message: "Could not reach the server. Check your connection and try again.", statusCode: 0)
        }
        guard (200..<300).contains(status) else { throw Self.exchangeError(status: status, body: body) }
        guard let tokens = try? JSONDecoder().decode(TokenResponse.self, from: body),
              let account = tokens.account, !account.accountId.isEmpty,
              let credential = tokens.credential(accountId: account.accountId, clientId: clientId, tokenEndpoint: tokenEndpoint, now: now) else {
            throw CloudAPIError(code: "browser_sign_in_failed", message: "Could not finish signing in. Try again.", statusCode: status)
        }
        return AppSignInGrant(account: account, credential: credential, deviceId: tokens.deviceId?.nonEmpty)
    }

    /// Rotates the refresh token. Uses the client and endpoint stored with the
    /// sign-in, so a stored sign-in keeps working after an app update.
    static func refresh(_ credential: AppSignInCredential, transport: Transport, now: Date = Date()) async throws -> AppSignInCredential {
        let status: Int
        let body: Data
        do {
            (status, body) = try await postForm(credential.tokenEndpoint, [
                ("grant_type", "refresh_token"),
                ("client_id", credential.clientId),
                ("refresh_token", credential.refreshToken),
            ], transport: transport)
        } catch {
            throw AppSignInRefreshError.unavailable
        }
        guard (200..<300).contains(status) else {
            let error = errorCode(in: body)
            let refused = (status == 400 || status == 401) && (error == "invalid_grant" || error == "invalid_client")
            throw refused ? AppSignInRefreshError.rejected : AppSignInRefreshError.unavailable
        }
        guard let tokens = try? JSONDecoder().decode(TokenResponse.self, from: body),
              let next = tokens.credential(
                accountId: credential.accountId,
                clientId: credential.clientId,
                tokenEndpoint: credential.tokenEndpoint,
                now: now
              ) else { throw AppSignInRefreshError.unavailable }
        return next
    }

    /// Ends the whole sign-in on the server (RFC 7009). Best effort: a failed
    /// request still lets the caller sign out locally.
    static func revoke(_ credential: AppSignInCredential, transport: Transport) async {
        let endpoint = credential.tokenEndpoint.absoluteString
        guard endpoint.hasSuffix(tokenPath),
              let revokeURL = URL(string: String(endpoint.dropLast(tokenPath.count)) + revokePath) else { return }
        _ = try? await postForm(revokeURL, [
            ("client_id", credential.clientId),
            ("token", credential.refreshToken),
        ], transport: transport)
    }

    // MARK: Helpers

    private func endpoint(_ path: String, query: [(String, String)] = []) -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        let suffix = query.isEmpty ? "" : "?\(AppSignInForm.encode(query))"
        return URL(string: base + path + suffix)!
    }

    private static func postForm(_ url: URL, _ fields: [(String, String)], transport: Transport) async throws -> (Int, Data) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(AppSignInForm.encode(fields).utf8)
        let (data, response) = try await transport(request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    static func errorCode(in body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return (object["error"] as? String) ?? (object["errorCode"] as? String)
    }

    static func exchangeError(status: Int, body: Data) -> CloudAPIError {
        let error = errorCode(in: body)
        if status == 429 || error == "rate_limited" {
            return CloudAPIError(code: "rate_limited", message: "Too many attempts. Wait a moment, then try again.", statusCode: status)
        }
        if error == "invalid_grant" {
            return CloudAPIError(code: "sign_in_code_invalid", message: "That code expired or was already used. Log in again.", statusCode: status)
        }
        if status >= 500 {
            return CloudAPIError(code: "server_error", message: "The server hit an unexpected error. Please try again.", statusCode: status)
        }
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let message = ((object?["message"] as? String) ?? (object?["error_description"] as? String))?.nonEmpty
        return CloudAPIError(code: "browser_sign_in_failed", message: message ?? "Could not finish signing in. Try again.", statusCode: status)
    }
}

private struct TokenResponse: Decodable {
    let accessToken: String?
    let expiresIn: Double?
    let refreshToken: String?
    let deviceId: String?
    let account: CloudAccount?

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case expiresIn = "expires_in"
        case refreshToken = "refresh_token"
        case deviceId = "device_id"
        case account
    }

    func credential(accountId: String, clientId: String, tokenEndpoint: URL, now: Date) -> AppSignInCredential? {
        guard let accessToken = accessToken?.nonEmpty,
              let refreshToken = refreshToken?.nonEmpty,
              let expiresIn, expiresIn.isFinite, expiresIn > 0 else { return nil }
        return AppSignInCredential(
            accountId: accountId,
            clientId: clientId,
            tokenEndpoint: tokenEndpoint,
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: now.addingTimeInterval(expiresIn)
        )
    }
}

/// `application/x-www-form-urlencoded` with every byte outside the RFC 3986
/// unreserved set percent-encoded, for query strings and request bodies.
enum AppSignInForm {
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    static func encode(_ fields: [(String, String)]) -> String {
        fields.map { "\(escape($0.0))=\(escape($0.1))" }.joined(separator: "&")
    }

    private static func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }
}

/// Reads the callback URL the web session finished on.
enum AppSignInCallback {
    /// Returns the code, or throws the error the browser returned. `state`
    /// must match the value this app generated, exactly once.
    static func code(from url: URL, redirectURI: String, expectedState: String) throws -> String {
        let failed = CloudAPIError(code: "browser_sign_in_failed", message: "Could not finish signing in. Try again.", statusCode: 0)
        guard let expected = URL(string: redirectURI),
              url.scheme?.lowercased() == expected.scheme?.lowercased(),
              url.host == expected.host,
              url.path == expected.path,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { throw failed }
        func values(_ name: String) -> [String] { items.filter { $0.name == name }.map { $0.value ?? "" } }
        // An error carries no code, so it is reported even without a matching state.
        if let error = values("error").first {
            if error == "access_denied" {
                throw CloudAPIError(code: "access_denied", message: "Sign-in was canceled in the browser.", statusCode: 0)
            }
            let description = values("error_description").first?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw CloudAPIError(code: "browser_sign_in_failed", message: description?.nonEmpty ?? failed.message, statusCode: 0)
        }
        guard values("state") == [expectedState] else {
            throw CloudAPIError(code: "sign_in_state_mismatch", message: "This sign-in did not come from this app. Try again.", statusCode: 0)
        }
        let codes = values("code")
        guard codes.count == 1, let code = codes[0].trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else { throw failed }
        return code
    }
}
