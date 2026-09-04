import Foundation

func normalizedGroupSpaceId(_ value: String?) -> String? {
    guard var result = value?.nonEmpty else { return nil }
    while result.hasPrefix("group:") {
        result.removeFirst("group:".count)
    }
    return result.nonEmpty
}

struct GroupSpaceSummary: Identifiable, Hashable {
    let id: String
    let displayName: String
    let lastMessage: String
    let lastActivityAt: Date
    let unreadCount: Int
    let unreadMentionCount: Int
    let participants: [CloudGroupParticipant]
    let sessions: [ConversationSummary]
    /// Includes every canonical session used for group membership fanout.
    let membershipSessions: [ConversationSummary]

    var preferenceId: String {
        normalizedGroupSpaceId(id) ?? id
    }

    var fullyJoinedParticipantAccountIds: Set<String> {
        guard let first = membershipSessions.first else { return [] }
        return membershipSessions.dropFirst().reduce(
            into: Set(first.groupParticipants.map(\.accountId).filter { !$0.isEmpty })
        ) { accountIds, session in
            accountIds.formIntersection(
                session.groupParticipants.map(\.accountId).filter { !$0.isEmpty }
            )
        }
    }

    func canManage(accountId: String?) -> Bool {
        sessions.contains { $0.canManageGroup(accountId: accountId) }
    }

    var accessibilitySummary: String {
        let sessionLabel = sessions.count == 1 ? "1 session" : "\(sessions.count) sessions"
        let unread = unreadCount > 0 ? ", \(unreadCount) unread" : ""
        let mentions = unreadMentionCount > 0
            ? ", \(unreadMentionCount) unread mention\(unreadMentionCount == 1 ? "" : "s")"
            : ""
        return "\(displayName), \(sessionLabel)\(unread)\(mentions). \(BlobEmojiComposerText.plainText(lastMessage))"
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
        ownAccountId: String,
        pinnedSessionIds: Set<String> = []
    ) -> [GroupSpaceSummary] {
        let candidates = conversations.filter { $0.kind == .group }
        let groups = Dictionary(grouping: candidates) { conversation in
            spaceKey(for: conversation)
        }

        return groups.map { key, conversations in
            let membershipSessions = conversations.sorted(by: conversationPrecedes)
            let sessions = membershipSessions.sorted {
                let leftPinned = pinnedSessionIds.contains($0.sessionId)
                let rightPinned = pinnedSessionIds.contains($1.sessionId)
                if leftPinned != rightPinned { return leftPinned }
                return conversationPrecedes($0, $1)
            }
            let latest = membershipSessions[0]
            let participants = mergedParticipants(from: membershipSessions)
            let groupTitle = membershipSessions
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
                sessions: sessions,
                membershipSessions: membershipSessions
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
        if let groupSpaceId = normalizedGroupSpaceId(conversation.groupSpaceId) {
            return "group:\(groupSpaceId)"
        }
        let participantKey = participantKey(for: conversation)
        if !participantKey.isEmpty { return "group:cloud:\(participantKey)" }
        return "group:\(conversation.sessionId)"
    }

    private static func participantKey(for conversation: ConversationSummary) -> String {
        conversation.groupParticipants
            .map(\.accountId)
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "+")
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
