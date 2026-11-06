import Foundation

/// A group invite link: `kordi://group-invite/<token>`, the same path on this
/// build's own scheme (`kordi-beta` for Beta), or `https://<site>/g/<token>`
/// on the public origin. Opening one asks to join the group.
struct GroupInviteLink: Equatable, Hashable {
    let token: String

    /// Nil for any URL that is not a group invite link.
    static func parse(
        _ url: URL,
        hostScheme: String? = SharedDocumentLink.hostAppScheme,
        publicOrigin: String = SharedDocumentLink.publicOrigin
    ) -> GroupInviteLink? {
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
        if customSchemes.contains(scheme), host == "group-invite", parts.count == 1 {
            token = parts[0]
        } else if scheme == "https", isPublicHost(host, port: url.port, publicOrigin: publicOrigin),
                  parts.count == 2, parts[0] == "g" {
            token = parts[1]
        } else {
            token = nil
        }
        guard let token, isValidToken(token) else { return nil }
        return GroupInviteLink(token: token)
    }

    /// `kordi_gi_` followed by 43 URL-safe base64 characters.
    static func isValidToken(_ token: String) -> Bool {
        token.range(of: "^kordi_gi_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    /// The public origin's host, with or without `www.`.
    private static func isPublicHost(_ host: String, port: Int?, publicOrigin: String) -> Bool {
        guard let origin = URL(string: publicOrigin), let originHost = origin.host?.lowercased(),
              port == origin.port else { return false }
        return host == originHost || host == "www.\(originHost)"
    }
}
