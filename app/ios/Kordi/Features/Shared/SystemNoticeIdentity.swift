import SwiftUI
import UIKit

/// Server notices, such as a group's introduction and "joined" lines or the
/// plan card in a direct chat. They carry this message kind and come from the
/// hidden System account, PiP, or a member (a plan card stays the organizer's);
/// the app always shows them from "System" with a gray Kordi bird.
enum KordiSystemIdentity {
    static let messageKind = "system-notice"
    static let displayName = "System"
    static let seed = "kordi_system"
    static let accountId = "acct_kordi_system"

    static let avatar = ConversationAvatarIdentity(name: displayName, source: nil, seed: seed)

    static func isSystemNotice(_ message: ChatMessage) -> Bool {
        isSystemNotice(kind: message.messageKind)
    }

    static func isSystemNotice(kind: String?) -> Bool {
        kind?.trimmingCharacters(in: .whitespacesAndNewlines) == messageKind
    }

    static func matches(seed: String?) -> Bool {
        seed?.trimmingCharacters(in: .whitespacesAndNewlines) == Self.seed
    }

    static func isSystem(accountId: String?) -> Bool {
        accountId?.trimmingCharacters(in: .whitespacesAndNewlines) == Self.accountId
    }

    /// PiP and the System account are server-managed: never listed, counted,
    /// pictured, or synchronized as members.
    static func isServiceAccount(_ accountId: String?) -> Bool {
        KordiPipIdentity.isPip(accountId: accountId) || isSystem(accountId: accountId)
    }

    /// A notice is never the viewer's own bubble, even when the viewer's
    /// account sent it.
    static func author(messageKind: String?, fromAccountId: String, ownAccountId: String) -> MessageAuthor {
        if isSystemNotice(kind: messageKind) || isSystem(accountId: fromAccountId) { return .person }
        return fromAccountId == ownAccountId ? .me : .person
    }

    /// The name on a direct-chat message from someone other than the viewer.
    static func directAuthorName(messageKind: String?, fromAccountId: String, fallback: String) -> String {
        isSystemNotice(kind: messageKind) || isSystem(accountId: fromAccountId) ? displayName : fallback
    }

    /// The name on a group message that has no envelope: "System" for a
    /// notice, then the member's name, PiP, or the conversation's name.
    static func groupAuthorName(
        messageKind: String?,
        fromAccountId: String,
        participantNames: [String: String],
        fallback: String
    ) -> String {
        if isSystemNotice(kind: messageKind) || isSystem(accountId: fromAccountId) { return displayName }
        if let name = participantNames[fromAccountId] { return name }
        return KordiPipIdentity.isPip(accountId: fromAccountId) ? KordiPipIdentity.displayName : fallback
    }
}

/// The Kordi bird in gray, matching the development app icon.
struct KordiSystemAvatar: View {
    /// Bird #6e6e73 and beak #a1a1a6, from the shared icon generator.
    static let tint = KordiBirdTint(
        body: Color(red: 0x6E / 255, green: 0x6E / 255, blue: 0x73 / 255),
        beak: Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xA6 / 255)
    )
    private static let background = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x2C / 255, green: 0x2C / 255, blue: 0x2E / 255, alpha: 1)
            : UIColor(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xEA / 255, alpha: 1)
    })

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                Self.background
                KordiMark(size: side * 0.86, tint: Self.tint)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }
}
