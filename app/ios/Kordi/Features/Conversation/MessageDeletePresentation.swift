import Foundation

/// Choices, helper lines, and footnote of the message delete confirmation.
/// The storage sentence appears only when the server reports that it deletes
/// stored copies of deleted content (`content_removal_version` 1 or higher).
struct MessageDeletePresentation: Equatable {
    struct Choice: Equatable {
        let title: String
        /// Shown under the title and used as the VoiceOver hint.
        let helper: String?
        let identifier: String
    }

    let forEveryone: Choice?
    let forMe: Choice
    let footnote: String?

    static let removeFromViewHelper = "Hides it on your devices. Others in the chat still see it."
    /// Status text after a message or a photo could not be deleted.
    static let deleteFailedText = "Could not delete the message. Try again."
    static let photoDeleteFailedText = "Could not delete the photo. Try again."
    static let footnoteText = "People who already saw it may have saved a copy or taken a screenshot. "
        + "If an agent already read it, the agent's reply and what it received stay."

    static func make(
        isOwnMessage: Bool,
        isLocalFailedSend: Bool,
        isPhoto: Bool,
        isGroup: Bool,
        peerName: String,
        serverDeletesStoredCopies: Bool
    ) -> Self {
        if isLocalFailedSend {
            let remove = Choice(title: "Remove failed message", helper: nil, identifier: "message-remove-failed")
            return Self(forEveryone: nil, forMe: remove, footnote: nil)
        }
        let scope = isPhoto ? "photo" : "message"
        let forMe = Choice(
            title: isPhoto ? "Remove photo from my view" : "Remove from my view",
            helper: removeFromViewHelper,
            identifier: "\(scope)-delete-for-me"
        )
        guard isOwnMessage else { return Self(forEveryone: nil, forMe: forMe, footnote: nil) }
        let forEveryone = Choice(
            title: isPhoto ? "Delete photo for everyone" : "Delete for everyone",
            helper: deleteForEveryoneHelper(
                isPhoto: isPhoto,
                isGroup: isGroup,
                peerName: peerName,
                serverDeletesStoredCopies: serverDeletesStoredCopies
            ),
            identifier: "\(scope)-delete-for-everyone"
        )
        return Self(forEveryone: forEveryone, forMe: forMe, footnote: footnoteText)
    }

    static func deleteForEveryoneHelper(
        isPhoto: Bool,
        isGroup: Bool,
        peerName: String,
        serverDeletesStoredCopies: Bool
    ) -> String {
        if isPhoto {
            return serverDeletesStoredCopies
                ? "Removes this photo for everyone in this chat, and Kordi deletes the file from chat storage."
                : "Removes this photo for everyone in this chat. Copies may remain on the server."
        }
        guard serverDeletesStoredCopies else {
            return "Removes it for everyone in this chat. Copies may remain on the server."
        }
        let name = peerName.trimmingCharacters(in: .whitespacesAndNewlines)
        return isGroup || name.isEmpty
            ? "Removes it for everyone in this chat, and Kordi deletes its text and files from chat storage."
            : "Removes it for you and \(name), and Kordi deletes its text and files from chat storage."
    }

    /// First-frame height of the confirmation in the 238 pt menu at the
    /// default text size. The menu then uses the measured height and scrolls
    /// when larger text does not fit.
    var estimatedHeight: CGFloat {
        func lines(_ text: String, perLine: Int) -> CGFloat {
            CGFloat(max(1, (text.count + perLine - 1) / perLine))
        }
        func height(_ choice: Choice) -> CGFloat {
            guard let helper = choice.helper else { return 44 }
            return 16 + lines(choice.title, perLine: 22) * 22 + 2 + lines(helper, perLine: 30) * 18
        }
        let choices = [forEveryone, forMe].compactMap { $0 }
        let divider: CGFloat = forEveryone == nil ? 0 : 1
        let note = footnote.map { 20 + lines($0, perLine: 30) * 18 } ?? 0
        return choices.map(height).reduce(8, +) + divider + note
    }
}
