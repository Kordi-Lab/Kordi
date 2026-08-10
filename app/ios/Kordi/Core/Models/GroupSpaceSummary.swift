import Foundation

struct GroupSpaceSummary: Identifiable, Hashable {
    let id: String
    let displayName: String
    let lastMessage: String
    let lastActivityAt: Date
    let unreadCount: Int
    let participants: [CloudGroupParticipant]
    let sessions: [ConversationSummary]

    var accessibilitySummary: String {
        let sessionLabel = sessions.count == 1 ? "1 session" : "\(sessions.count) sessions"
        let unread = unreadCount > 0 ? ", \(unreadCount) unread" : ""
        return "\(displayName), \(sessionLabel)\(unread). \(lastMessage)"
    }
}

enum GroupSpaceCatalog {
    static func build(
        conversations: [ConversationSummary],
        ownAccountId: String
    ) -> [GroupSpaceSummary] {
        // macOS presents forks in their own history surface and suppresses
        // control-only placeholder sessions once a group has real messages.
        // Apply the same projection before computing counts and unread badges.
        let groups = Dictionary(grouping: conversations.filter {
            $0.kind == .group && $0.forkedFromSessionId == nil
        }) { conversation in
            spaceKey(for: conversation)
        }

        return groups.map { key, conversations in
            let substantive = conversations.filter { conversation in
                conversation.messageCount == nil || (conversation.messageCount ?? 0) > 0
            }
            let visible = substantive.isEmpty
                ? Array(conversations.sorted { $0.lastActivityAt > $1.lastActivityAt }.prefix(1))
                : substantive
            let sessions = visible.sorted { $0.lastActivityAt > $1.lastActivityAt }
            let latest = sessions[0]
            let participants = mergedParticipants(from: sessions)
            let groupTitle = sessions
                .sorted { groupTitlePriority($0) > groupTitlePriority($1) }
                .compactMap { $0.ownerDisplayName?.nonEmpty }
                .first
            let participantTitle = participants
                .filter { $0.accountId != ownAccountId }
                .map(\.displayName)
                .filter { !$0.isEmpty }
                .prefix(3)
                .joined(separator: ", ")
            return GroupSpaceSummary(
                id: key,
                displayName: groupTitle ?? participantTitle.nonEmpty ?? "Group",
                lastMessage: latest.lastMessage,
                lastActivityAt: latest.lastActivityAt,
                unreadCount: sessions.reduce(0) { $0 + $1.unreadCount },
                participants: participants,
                sessions: sessions
            )
        }
        .sorted {
            $0.lastActivityAt > $1.lastActivityAt || (
                $0.lastActivityAt == $1.lastActivityAt
                    && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            )
        }
    }

    private static func spaceKey(for conversation: ConversationSummary) -> String {
        if let groupSpaceId = conversation.groupSpaceId?.nonEmpty {
            return "group:\(groupSpaceId)"
        }
        let participantKey = conversation.groupParticipants
            .map(\.accountId)
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "+")
        if !participantKey.isEmpty { return "group:cloud:\(participantKey)" }
        return "group:\(conversation.sessionId)"
    }

    private static func mergedParticipants(from sessions: [ConversationSummary]) -> [CloudGroupParticipant] {
        var byAccountId: [String: CloudGroupParticipant] = [:]
        for participant in sessions.flatMap(\.groupParticipants) where !participant.accountId.isEmpty {
            guard let existing = byAccountId[participant.accountId] else {
                byAccountId[participant.accountId] = participant
                continue
            }
            byAccountId[participant.accountId] = CloudGroupParticipant(
                accountId: participant.accountId,
                displayName: existing.displayName.nonEmpty ?? participant.displayName,
                avatarUrl: existing.avatarUrl?.nonEmpty ?? participant.avatarUrl,
                role: existing.role?.nonEmpty ?? participant.role
            )
        }
        return byAccountId.values.sorted { $0.accountId < $1.accountId }
    }

    private static func groupTitlePriority(_ conversation: ConversationSummary) -> Int {
        conversation.sessionId == conversation.groupSpaceId ? 2 : 1
    }
}
