import Foundation

struct GroupSpaceSummary: Identifiable, Hashable {
    let id: String
    let displayName: String
    let lastMessage: String
    let lastActivityAt: Date
    let unreadCount: Int
    let unreadMentionCount: Int
    let participants: [CloudGroupParticipant]
    let sessions: [ConversationSummary]

    var accessibilitySummary: String {
        let sessionLabel = sessions.count == 1 ? "1 session" : "\(sessions.count) sessions"
        let unread = unreadCount > 0 ? ", \(unreadCount) unread" : ""
        let mentions = unreadMentionCount > 0
            ? ", \(unreadMentionCount) unread mention\(unreadMentionCount == 1 ? "" : "s")"
            : ""
        return "\(displayName), \(sessionLabel)\(unread)\(mentions). \(lastMessage)"
    }
}

enum ChatListOrdering {
    static func precedes(
        id leftID: String,
        displayName leftDisplayName: String,
        lastActivityAt leftLastActivityAt: Date,
        before rightID: String,
        displayName rightDisplayName: String,
        lastActivityAt rightLastActivityAt: Date
    ) -> Bool {
        if leftLastActivityAt != rightLastActivityAt {
            return leftLastActivityAt > rightLastActivityAt
        }
        let nameOrder = leftDisplayName.localizedCaseInsensitiveCompare(rightDisplayName)
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return leftID < rightID
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
                ? Array(conversations.sorted(by: conversationPrecedes).prefix(1))
                : substantive
            let sessions = visible.sorted(by: conversationPrecedes)
            let latest = sessions[0]
            let participants = mergedParticipants(from: sessions)
            let groupTitle = sessions
                .sorted {
                    let leftPriority = groupTitlePriority($0)
                    let rightPriority = groupTitlePriority($1)
                    return leftPriority != rightPriority
                        ? leftPriority > rightPriority
                        : $0.id < $1.id
                }
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
                unreadMentionCount: sessions.reduce(0) { $0 + $1.unreadMentionCount },
                participants: participants,
                sessions: sessions
            )
        }
        .sorted {
            ChatListOrdering.precedes(
                id: $0.id,
                displayName: $0.displayName,
                lastActivityAt: $0.lastActivityAt,
                before: $1.id,
                displayName: $1.displayName,
                lastActivityAt: $1.lastActivityAt
            )
        }
    }

    private static func conversationPrecedes(
        _ left: ConversationSummary,
        _ right: ConversationSummary
    ) -> Bool {
        ChatListOrdering.precedes(
            id: left.id,
            displayName: left.displayName,
            lastActivityAt: left.lastActivityAt,
            before: right.id,
            displayName: right.displayName,
            lastActivityAt: right.lastActivityAt
        )
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
                agentId: existing.agentId?.nonEmpty ?? participant.agentId,
                agentDisplayName: existing.agentDisplayName?.nonEmpty ?? participant.agentDisplayName,
                agentAvatarUrl: existing.agentAvatarUrl?.nonEmpty ?? participant.agentAvatarUrl,
                role: existing.role?.nonEmpty ?? participant.role,
                joinedAt: existing.joinedAt?.nonEmpty ?? participant.joinedAt
            )
        }
        return byAccountId.values.sorted(by: CloudGroupParticipant.canonicalPrecedes)
    }

    private static func groupTitlePriority(_ conversation: ConversationSummary) -> Int {
        conversation.sessionId == conversation.groupSpaceId ? 2 : 1
    }
}
