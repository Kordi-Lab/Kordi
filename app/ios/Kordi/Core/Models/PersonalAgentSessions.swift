import Foundation

/// Personal sessions (#2091): one always-online chat per owned agent, listed
/// under Personal agent instead of Pinned, Projects, or Recents. The server
/// marks them with `personalAgent`; clients never parse their session ids.
enum PersonalAgentSessionCatalog {
    static let emptyPreview = "No messages yet"

    /// Marks the agent sessions the server bound to an owned agent and shows
    /// them under the agent's name instead of a session title.
    static func tagged(
        _ conversations: [ConversationSummary],
        canonicalBySessionId: [String: CloudChatConversation]
    ) -> [ConversationSummary] {
        conversations.map { conversation in
            guard conversation.kind == .agent,
                  let agentId = canonicalBySessionId[conversation.sessionId]?.personalAgentId else {
                return conversation
            }
            var tagged = conversation
            tagged.personalAgentId = agentId
            tagged.displayName = conversation.agentDisplayName?.nonEmpty ?? conversation.displayName
            return tagged
        }
    }

    /// Rows for the Personal agent section: the server's order first (default
    /// agent, then owned definitions by creation time), then any other
    /// personal session that synced before the list loaded.
    static func rows(
        conversations: [ConversationSummary],
        personalAgents: [CloudPersonalAgent],
        ownAccountId: String,
        searchText: String = ""
    ) -> [ConversationSummary] {
        guard let ownAccountId = ownAccountId.nonEmpty else { return [] }
        var latestByAgentId: [String: ConversationSummary] = [:]
        for conversation in conversations {
            guard let agentId = conversation.personalAgentId else { continue }
            if let existing = latestByAgentId[agentId],
               existing.lastActivityAt >= conversation.lastActivityAt { continue }
            latestByAgentId[agentId] = conversation
        }

        var rows: [ConversationSummary] = []
        var listedAgentIds = Set<String>()
        for entry in personalAgents where listedAgentIds.insert(entry.agentId).inserted {
            if let conversation = latestByAgentId[entry.agentId]
                ?? conversations.first(where: { $0.personalAgentId != nil && $0.sessionId == entry.sessionId }) {
                rows.append(conversation)
            } else if let placeholder = placeholder(for: entry, in: conversations, ownAccountId: ownAccountId) {
                rows.append(placeholder)
            }
        }
        let defaultAgentId = CanonicalAvatarSystem.agentID(nil, ownerAccountID: ownAccountId)
        rows += latestByAgentId
            .filter { !listedAgentIds.contains($0.key) }
            .map(\.value)
            .sorted { left, right in
                let leftDefault = left.agentId == defaultAgentId
                let rightDefault = right.agentId == defaultAgentId
                if leftDefault != rightDefault { return leftDefault }
                return name(of: left).localizedCaseInsensitiveCompare(name(of: right)) == .orderedAscending
            }

        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return rows }
        return rows.filter {
            name(of: $0).localizedCaseInsensitiveContains(query)
                || $0.lastMessage.localizedCaseInsensitiveContains(query)
        }
    }

    static func name(of conversation: ConversationSummary) -> String {
        conversation.agentDisplayName?.nonEmpty ?? conversation.displayName.nonEmpty ?? "Kordi"
    }

    static func preview(of conversation: ConversationSummary) -> String {
        guard conversation.messageCount != 0 else { return emptyPreview }
        return conversation.previewText.nonEmpty ?? emptyPreview
    }

    /// A row for a session the server just created and that has not synced
    /// yet, named after the agent's existing launch template or session.
    private static func placeholder(
        for entry: CloudPersonalAgent,
        in conversations: [ConversationSummary],
        ownAccountId: String
    ) -> ConversationSummary? {
        let agentId = CanonicalAvatarSystem.agentID(entry.agentId, ownerAccountID: ownAccountId)
        let candidates = conversations.filter {
            $0.kind == .agent && $0.peerAccountId == ownAccountId && $0.agentId == agentId
        }
        guard let identity = candidates.first(where: \.isAgentLaunchTemplate) ?? candidates.first else {
            return nil
        }
        let agentName = name(of: identity)
        var placeholder = ConversationSummary(
            id: "agent-session:\(entry.sessionId)",
            kind: .agent,
            peerAccountId: ownAccountId,
            agentId: entry.agentId,
            ownerDisplayName: identity.ownerDisplayName,
            displayName: agentName,
            lastMessage: emptyPreview,
            lastActivityAt: .distantPast,
            unreadCount: 0,
            avatarSource: identity.avatarSource,
            agentActivity: .ready,
            sessionId: entry.sessionId,
            agentDisplayName: agentName,
            messageCount: 0
        )
        placeholder.personalAgentId = entry.agentId
        return placeholder
    }
}

/// The long-press menu of a Personal agent row. These sessions are never
/// renamed, pinned, moved, archived, or deleted.
enum PersonalAgentRowAction: String, CaseIterable, Hashable {
    case markRead
    case markUnread
    case mute
    case unmute

    static func available(isUnread: Bool, isMuted: Bool) -> [PersonalAgentRowAction] {
        [isUnread ? .markRead : .markUnread, isMuted ? .unmute : .mute]
    }

    var title: String {
        switch self {
        case .markRead: "Mark as read"
        case .markUnread: "Mark as unread"
        case .mute: "Mute"
        case .unmute: "Unmute"
        }
    }

    var systemImage: String {
        switch self {
        case .markRead: "checkmark.circle"
        case .markUnread: "envelope.badge"
        case .mute: "bell.slash"
        case .unmute: "bell"
        }
    }
}

enum PersonalAgentPresentation {
    static let onlineStatus = "Online"

    /// The session header status: Online, unless the agent is working.
    static func headerStatus(
        for conversation: ConversationSummary,
        activity: AgentActivity,
        fallback: @autoclosure () -> String
    ) -> String {
        guard conversation.personalAgentId != nil, activity != .replying else { return fallback() }
        return onlineStatus
    }
}
