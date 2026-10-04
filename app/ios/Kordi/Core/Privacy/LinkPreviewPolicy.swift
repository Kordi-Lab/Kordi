import Foundation
import SwiftUI

/// Per-device choice of which messages may load link previews and site icons.
/// The setting is not synced; a missing or unknown value reads as `.contacts`.
enum LinkPreviewSetting: String, CaseIterable, Identifiable {
    case contacts
    case everyone
    case off

    static let storageKey = "kordi.privacy.linkPreviews"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .contacts: "From contacts"
        case .everyone: "Everyone"
        case .off: "Off"
        }
    }

    init(storedValue: String?) {
        self = storedValue.flatMap(LinkPreviewSetting.init(rawValue:)) ?? .contacts
    }

    static func current(defaults: UserDefaults = .standard) -> LinkPreviewSetting {
        LinkPreviewSetting(storedValue: defaults.string(forKey: storageKey))
    }
}

/// Decides whether rendering a message may contact the hosts its links name.
/// Loading a preview or site icon reveals the device's IP address and the time
/// the link was viewed, so it is limited to senders the user already trusts.
enum LinkPreviewPolicy {
    static func allowsNetworkFetch(
        setting: LinkPreviewSetting,
        author: MessageAuthor,
        senderAccountId: String?,
        conversationKind: ConversationKind,
        conversationPeerAccountId: String?,
        contactAccountIds: Set<String>,
        blockedAccountIds: Set<String> = []
    ) -> Bool {
        switch setting {
        case .off: return false
        case .everyone: return true
        case .contacts: break
        }
        switch author {
        case .me: return true
        case .agent: return false
        case .person: break
        }
        let senderID = senderAccountId?.nonEmpty
            ?? (conversationKind == .person ? conversationPeerAccountId?.nonEmpty : nil)
        guard let senderID else { return false }
        return contactAccountIds.contains(senderID) && !blockedAccountIds.contains(senderID)
    }

    private static let maximumLabelLength = 63
    private static let allowedHostCharacters = Set("abcdefghijklmnopqrstuvwxyz0123456789-.")
    private static let hexDigits = Set("0123456789abcdef")
    private static let nonPublicSuffixes = [
        "localhost", "local", "localdomain", "internal", "intranet",
        "lan", "home", "corp", "private", "arpa",
    ]

    /// Accepts only public HTTPS names on the default port. It rejects IP
    /// literals in every form a URL parser accepts, local and private-use
    /// names, credentials, and explicit ports, before any request is made.
    static func isPreviewableURL(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              url.port == nil || url.port == 443,
              let rawHost = url.host else { return false }
        var host = rawHost.lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty, host.allSatisfy(allowedHostCharacters.contains) else { return false }

        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2,
              labels.allSatisfy({ !$0.isEmpty && $0.count <= maximumLabelLength }),
              let last = labels.last,
              !endsInNumber(last) else { return false }

        return !nonPublicSuffixes.contains { suffix in
            host == suffix || host.hasSuffix(".\(suffix)")
        }
    }

    /// The WHATWG URL host parser treats a name whose last label is a number
    /// as an IPv4 address (`127.1`, `0x7f.1`), so such names are never names.
    private static func endsInNumber(_ label: Substring) -> Bool {
        if label.allSatisfy(\.isASCIIDigit) { return true }
        guard label.hasPrefix("0x") else { return false }
        return label.dropFirst(2).allSatisfy(hexDigits.contains)
    }
}

private extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}

/// `.task(id:)` needs a `Hashable` value; tuples are not.
struct LinkFetchTaskKey: Hashable {
    let value: String
    let allowed: Bool
}

extension EnvironmentValues {
    /// The per-message link fetch decision. `nil` means no message decided,
    /// for example on Digest, and loaders then fetch only under `.everyone`.
    @Entry var linkNetworkFetchDecision: Bool? = nil
}
