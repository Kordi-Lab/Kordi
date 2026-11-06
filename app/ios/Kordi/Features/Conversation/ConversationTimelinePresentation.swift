import SwiftUI

struct ConversationMessagePresentation: Equatable {
    let showsTimestamp: Bool
    let showsDateDivider: Bool
    let groupedWithPrevious: Bool
    let groupedWithNext: Bool
    let showsAvatar: Bool
    let outgoingAvatarGroupID: String?
    /// The row above is the same agent, so its avatar is not repeated.
    var continuesAgentRun = false

    var rowTopPadding: CGFloat { 2 }
    var rowBottomPadding: CGFloat { groupedWithNext ? 0 : 2 }
}

enum ConversationTimelinePresentation {
    static let timestampGap: TimeInterval = 5 * 60

    static func make(
        messages: [ChatMessage],
        selfAccountId: String?,
        participants: [CloudGroupParticipant],
        calendar: Calendar = .current
    ) -> [ConversationMessagePresentation] {
        let participantIdsByName = Dictionary(
            participants.map { ($0.displayName.lowercased(), $0.accountId) },
            uniquingKeysWith: { first, _ in first }
        )
        let groupKeys = messages.map { message -> String? in
            if message.isSystemNotice { return nil }
            switch message.author {
            case .agent:
                return nil
            case .me:
                return "own:\(selfAccountId?.nonEmpty ?? "me")"
            case .person:
                let normalizedName = message.authorName
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                return "peer:\(participantIdsByName[normalizedName]?.nonEmpty ?? normalizedName)"
            }
        }
        let agentRunKeys = messages.map { message -> String? in
            guard !message.isSystemNotice, message.author == .agent else { return nil }
            let name = message.authorName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let owner = message.senderOwnerName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            return "agent:\(name)|\(owner)"
        }
        let timestampVisibility = messages.indices.map { index in
            if messages[index].isSystemNotice { return true }
            guard index > messages.startIndex else { return true }
            let current = messages[index].createdAt
            let previous = messages[index - 1].createdAt
            return !calendar.isDate(current, inSameDayAs: previous)
                || current.timeIntervalSince(previous) >= timestampGap
        }

        var outgoingAvatarGroupID: String?
        return messages.indices.map { index in
            let key = groupKeys[index]
            let groupedWithPrevious = index > messages.startIndex
                && !timestampVisibility[index]
                && key != nil
                && key == groupKeys[index - 1]
            let nextIndex = index + 1
            let groupedWithNext = nextIndex < messages.endIndex
                && !timestampVisibility[nextIndex]
                && key != nil
                && key == groupKeys[nextIndex]
            if messages[index].author == .me, key != nil {
                if !groupedWithPrevious {
                    outgoingAvatarGroupID = messages[index].clientMessageId ?? messages[index].id
                }
            } else {
                outgoingAvatarGroupID = nil
            }
            return ConversationMessagePresentation(
                showsTimestamp: timestampVisibility[index],
                showsDateDivider: index == messages.startIndex
                    || !calendar.isDate(messages[index].createdAt, inSameDayAs: messages[index - 1].createdAt),
                groupedWithPrevious: groupedWithPrevious,
                groupedWithNext: groupedWithNext,
                showsAvatar: key != nil && !groupedWithNext,
                outgoingAvatarGroupID: outgoingAvatarGroupID,
                continuesAgentRun: index > messages.startIndex
                    && !timestampVisibility[index]
                    && agentRunKeys[index] != nil
                    && agentRunKeys[index] == agentRunKeys[index - 1]
            )
        }
    }
}
