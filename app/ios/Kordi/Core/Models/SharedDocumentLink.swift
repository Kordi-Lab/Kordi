import Foundation

/// A shared document link (issue 1741): `kordi://document/<token>`, the same
/// path on this build's own scheme (`kordi-beta` for Beta), or
/// `https://kordi.ai/d/<token>`. Opening one shows the reader through the
/// public document route.
struct SharedDocumentLink: Equatable, Hashable, Identifiable {
    let token: String

    var id: String { token }
    var shareURL: URL? { URL(string: "\(Self.publicOrigin)/d/\(token)") }

    static var publicOrigin: String {
        #if BETA
        // Preserve Beta's existing shared-link behavior; its API remains loopback-only.
        return "https://kordi.ai"
        #else
        return KordiAppEnvironment.current.cloudBaseURL.absoluteString
        #endif
    }

    /// The app's own URL scheme from Info.plist, which differs per build channel.
    static var hostAppScheme: String? {
        (Bundle.main.object(forInfoDictionaryKey: "KordiHostAppURLScheme") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    /// Nil for any URL that is not a shared document link.
    static func parse(_ url: URL, hostScheme: String? = SharedDocumentLink.hostAppScheme) -> SharedDocumentLink? {
        guard url.user == nil, url.password == nil, url.query == nil,
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        #if BETA
        let customSchemes = Set(["kordi", hostScheme].compactMap { $0?.nonEmpty })
        #else
        let customSchemes = Set([hostScheme].compactMap { $0?.nonEmpty })
        #endif
        let token: String?
        if customSchemes.contains(scheme), host == "document", parts.count == 1 {
            token = parts[0]
        } else if scheme == "https", isPublicHost(host, port: url.port), parts.count == 2, parts[0] == "d" {
            token = parts[1]
        } else {
            token = nil
        }
        guard let token, isValidToken(token) else { return nil }
        return SharedDocumentLink(token: token)
    }

    /// The public origin's host, with or without `www.`.
    private static func isPublicHost(_ host: String, port: Int?) -> Bool {
        guard let origin = URL(string: publicOrigin), let originHost = origin.host?.lowercased(),
              port == origin.port else { return false }
        return host == originHost || host == "www.\(originHost)"
    }

    /// `kordi_ds_` followed by 43 URL-safe base64 characters.
    static func isValidToken(_ token: String) -> Bool {
        token.range(of: "^kordi_ds_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }
}
