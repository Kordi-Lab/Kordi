import Foundation

struct AgentSessionSection: Identifiable, Hashable {
    let id: String
    let agentId: String?
    let displayName: String
    let avatarSource: String?
    let template: ConversationSummary
    let sessions: [ConversationSummary]

    var latestActivityAt: Date {
        sessions.map(\.lastActivityAt).max() ?? .distantPast
    }

}

enum AgentSessionPresentationCatalog {
    static func build(
        conversations: [ConversationSummary],
        ownAccountId: String,
        searchText: String = ""
    ) -> [AgentSessionSection] {
        let available = conversations.filter {
            $0.kind == .agent && !$0.representsKordiSupport
        }
        let grouped = Dictionary(grouping: available) { conversation in
            let owner = conversation.peerAccountId.nonEmpty ?? ownAccountId
            let agent = conversation.agentId?.nonEmpty ?? "my-kordi"
            return "agent:\(owner):\(agent)"
        }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)

        return grouped.compactMap { key, sessions -> AgentSessionSection? in
            guard let template = sessions.max(by: { $0.lastActivityAt < $1.lastActivityAt }) else { return nil }
            let agentName = template.agentDisplayName?.nonEmpty ?? "My Kordi"
            let agentMatches = !query.isEmpty && agentName.localizedCaseInsensitiveContains(query)
            let visibleSessions = query.isEmpty || agentMatches
                ? sessions
                : sessions.filter { session in
                    session.displayName.localizedCaseInsensitiveContains(query)
                        || session.lastMessage.localizedCaseInsensitiveContains(query)
                }
            guard !visibleSessions.isEmpty else { return nil }

            return AgentSessionSection(
                id: key,
                agentId: template.agentId,
                displayName: agentName,
                avatarSource: template.avatarSource,
                template: template,
                sessions: visibleSessions.sorted { $0.lastActivityAt > $1.lastActivityAt }
            )
        }
        .sorted {
            $0.latestActivityAt > $1.latestActivityAt || (
                $0.latestActivityAt == $1.latestActivityAt
                    && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            )
        }
    }
}

struct AgentSessionListItem: Identifiable, Hashable {
    let conversation: ConversationSummary
    let depth: Int
    let childCount: Int

    var id: String { conversation.id }
    var isFork: Bool { depth > 0 }
}

/// Mirrors the macOS Agent sidebar: every agent session shares one activity
/// timeline, while forks remain attached to their source session instead of
/// being regrouped by agent identity.
enum AgentSessionTimelineCatalog {
    static func build(
        conversations: [ConversationSummary],
        searchText: String = "",
        collapsedForkParentIds: Set<String> = []
    ) -> [AgentSessionListItem] {
        let allSessions = conversations
            .filter { $0.kind == .agent && !$0.representsKordiSupport }
            .sorted(by: sessionSort)
        let bySessionId = Dictionary(uniqueKeysWithValues: allSessions.map { ($0.sessionId, $0) })
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)

        var visibleSessionIds = Set(allSessions.map(\.sessionId))
        if !query.isEmpty {
            visibleSessionIds = Set(allSessions.filter { matches($0, query: query) }.map(\.sessionId))
            var parentsToVisit = Array(visibleSessionIds)
            while let childId = parentsToVisit.popLast() {
                guard let parentId = bySessionId[childId]?.forkedFromSessionId?.nonEmpty,
                      bySessionId[parentId] != nil,
                      visibleSessionIds.insert(parentId).inserted else { continue }
                parentsToVisit.append(parentId)
            }
        }

        let sessions = allSessions.filter { visibleSessionIds.contains($0.sessionId) }
        let visibleBySessionId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.sessionId, $0) })
        let childrenByParent = Dictionary(grouping: sessions.compactMap { session -> ConversationSummary? in
            guard let parent = session.forkedFromSessionId?.nonEmpty,
                  visibleBySessionId[parent] != nil else { return nil }
            return session
        }, by: { $0.forkedFromSessionId ?? "" })
            .mapValues { $0.sorted(by: sessionSort) }

        let roots = sessions.filter { session in
            guard let parent = session.forkedFromSessionId?.nonEmpty else { return true }
            if visibleBySessionId[parent] != nil { return false }
            // macOS keeps a fork of a canonical contact/group session with
            // that source in Contact instead of leaking it into Agent.
            if parent.hasPrefix("session:direct-person:")
                || parent.hasPrefix("session:group:")
                || parent.hasPrefix("group:") {
                return false
            }
            // A retained fork can outlive an agent root that was never
            // uploaded or was removed before the v2 cutover. Promote the
            // oldest available agent fork to a visible root so the entire
            // remaining chain does not disappear from iOS.
            return true
        }
        .sorted(by: sessionSort)

        var output: [AgentSessionListItem] = []
        var visited = Set<String>()
        func append(_ session: ConversationSummary, depth: Int) {
            guard visited.insert(session.sessionId).inserted else { return }
            let children = childrenByParent[session.sessionId, default: []]
            output.append(AgentSessionListItem(
                conversation: session,
                depth: min(depth, 4),
                childCount: children.count
            ))
            guard !collapsedForkParentIds.contains(session.sessionId) else { return }
            for child in children { append(child, depth: depth + 1) }
        }
        for root in roots { append(root, depth: 0) }
        return output
    }

    private static func matches(_ conversation: ConversationSummary, query: String) -> Bool {
        conversation.displayName.localizedCaseInsensitiveContains(query)
            || conversation.lastMessage.localizedCaseInsensitiveContains(query)
            || conversation.agentDisplayName?.localizedCaseInsensitiveContains(query) == true
            || conversation.ownerDisplayName?.localizedCaseInsensitiveContains(query) == true
    }

    private static func sessionSort(_ left: ConversationSummary, _ right: ConversationSummary) -> Bool {
        left.lastActivityAt > right.lastActivityAt || (
            left.lastActivityAt == right.lastActivityAt
                && left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
        )
    }
}

enum AgentSessionFactory {
    static func make(
        from template: ConversationSummary,
        ownAccountId: String,
        randomId: String = UUID().uuidString.lowercased(),
        now: Date = Date()
    ) -> ConversationSummary {
        precondition(template.kind == .agent, "Agent sessions require an agent conversation template.")
        let sessionKind = template.peerAccountId == ownAccountId ? "self-agent" : "direct-agent"
        let stableId = randomId.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? UUID().uuidString.lowercased()
        let sessionId = "session:\(sessionKind):\(stableId)"
        let agentName = template.agentDisplayName?.nonEmpty ?? "My Kordi"

        return ConversationSummary(
            id: "agent-session:\(sessionId)",
            kind: .agent,
            peerAccountId: template.peerAccountId,
            agentId: template.agentId,
            ownerDisplayName: template.ownerDisplayName,
            displayName: agentName,
            lastMessage: "New session",
            lastActivityAt: now,
            unreadCount: 0,
            avatarSource: template.avatarSource,
            agentActivity: .ready,
            sessionId: sessionId,
            agentDisplayName: agentName
        )
    }
}
