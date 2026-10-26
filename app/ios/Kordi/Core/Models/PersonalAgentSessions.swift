import Foundation

/// Personal sessions (#2091): one always-online chat per owned agent, listed
/// under Personal agent instead of Pinned, Projects, or Recents. The server
/// marks them with `personalAgent`; clients never parse their session ids.
enum PersonalAgentSessionCatalog {
    static let emptyPreview = "No messages yet"

    /// Marks the owner's personal sessions and shows them under the agent's
    /// name instead of a session title. The server lists and marks a session
    /// only while the agent's Proactive setting is on. A loaded list is
    /// required, and a synced snapshot without the marker means the setting
    /// was turned off; before the list loads, the marker alone decides. The
    /// agent must be the default agent or an active owned agent
    /// (`activeOwnedAgentIds` is nil until the owned agents load).
    static func tagged(
        _ conversations: [ConversationSummary],
        canonicalBySessionId: [String: CloudChatConversation],
        ownAccountId: String,
        activeOwnedAgentIds: Set<String>?,
        personalAgents: [CloudPersonalAgent]?
    ) -> [ConversationSummary] {
        let listedAgentIdBySessionId = personalAgents.map { list in
            Dictionary(list.map { ($0.sessionId, $0.agentId) }, uniquingKeysWith: { first, _ in first })
        }
        return conversations.map { conversation in
            var tagged = conversation
            tagged.personalAgentId = nil
            let snapshot = canonicalBySessionId[conversation.sessionId]
            let candidate: String?
            if let listedAgentIdBySessionId {
                candidate = snapshot == nil || snapshot?.personalAgentId != nil
                    ? listedAgentIdBySessionId[conversation.sessionId] : nil
            } else {
                candidate = snapshot?.personalAgentId
            }
            guard conversation.kind == .agent, let agentId = candidate?.nonEmpty,
                  isPersonalAgent(agentId, ownAccountId: ownAccountId, activeOwnedAgentIds: activeOwnedAgentIds) else {
                return tagged
            }
            tagged.personalAgentId = agentId
            tagged.displayName = conversation.agentDisplayName?.nonEmpty ?? conversation.displayName
            return tagged
        }
    }

    static func isPersonalAgent(_ agentId: String, ownAccountId: String, activeOwnedAgentIds: Set<String>?) -> Bool {
        guard let ownAccountId = ownAccountId.nonEmpty else { return false }
        if CanonicalAvatarSystem.agentID(agentId, ownerAccountID: ownAccountId)
            == CanonicalAvatarSystem.agentID(nil, ownerAccountID: ownAccountId) { return true }
        return activeOwnedAgentIds?.contains(agentId) ?? true
    }

    static func activeAgentIds(_ agents: [CloudAgent]) -> Set<String> {
        Set(agents.filter { ($0.status == nil || $0.status == "active") && $0.archivedAt == nil }.map(\.agentId))
    }

    /// Rows for the Personal agent section. A loaded list gives the server's
    /// order (default agent, then owned definitions by creation time) and
    /// fills sessions that have not synced yet; before it loads, the tagged
    /// sessions show with the default agent first.
    static func rows(
        conversations: [ConversationSummary],
        personalAgents: [CloudPersonalAgent]?,
        ownAccountId: String,
        activeOwnedAgentIds: Set<String>? = nil,
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
        if let personalAgents {
            var listedAgentIds = Set<String>()
            for entry in personalAgents where listedAgentIds.insert(entry.agentId).inserted
                && isPersonalAgent(entry.agentId, ownAccountId: ownAccountId, activeOwnedAgentIds: activeOwnedAgentIds) {
                if let conversation = conversations.first(where: {
                    $0.personalAgentId == entry.agentId && $0.sessionId == entry.sessionId
                }) ?? latestByAgentId[entry.agentId] {
                    rows.append(conversation)
                } else if !conversations.contains(where: { $0.sessionId == entry.sessionId }),
                          let placeholder = placeholder(for: entry, in: conversations, ownAccountId: ownAccountId) {
                    rows.append(placeholder)
                }
            }
        } else {
            let defaultAgentId = CanonicalAvatarSystem.agentID(nil, ownerAccountID: ownAccountId)
            rows = latestByAgentId.values.sorted { left, right in
                let leftDefault = left.agentId == defaultAgentId
                let rightDefault = right.agentId == defaultAgentId
                if leftDefault != rightDefault { return leftDefault }
                return name(of: left).localizedCaseInsensitiveCompare(name(of: right)) == .orderedAscending
            }
        }

        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return rows }
        return rows.filter { matches($0, query: query) }
    }

    /// The same fields the Agents tab searches in its other sections.
    static func matches(_ conversation: ConversationSummary, query: String) -> Bool {
        name(of: conversation).localizedCaseInsensitiveContains(query)
            || conversation.displayName.localizedCaseInsensitiveContains(query)
            || conversation.lastMessage.localizedCaseInsensitiveContains(query)
            || conversation.agentDisplayName?.localizedCaseInsensitiveContains(query) == true
            || conversation.ownerDisplayName?.localizedCaseInsensitiveContains(query) == true
    }

    /// Sessions that are or were just personal, so a synced change to one of
    /// them (the Mac turning Proactive on or off) reloads the list.
    static func personalSessionIds(
        personalAgents: [CloudPersonalAgent]?,
        conversations: [ConversationSummary],
        canonical: [CloudChatConversation]
    ) -> Set<String> {
        Set((personalAgents ?? []).map(\.sessionId))
            .union(conversations.filter { $0.personalAgentId != nil }.map(\.sessionId))
            .union(canonical.filter { $0.personalAgentId != nil }.map { $0.legacySessionId?.nonEmpty ?? $0.id })
    }

    static func eventsTouchPersonalSession(_ events: [CloudSyncEvent], personalSessionIds: Set<String>) -> Bool {
        events.contains { event in
            event.eventType == "session.title.updated"
                && event.payload?.sessionTitle.map { personalSessionIds.contains($0.sessionId) } == true
        }
    }

    /// A personal session already exists on the server, so its first send
    /// never names the session or saves a new runtime route.
    static func isNewAgentSession(_ conversation: ConversationSummary, existingSessionIds: Set<String>) -> Bool {
        conversation.kind == .agent && conversation.personalAgentId == nil
            && !existingSessionIds.contains(conversation.sessionId)
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
