import Foundation

/// Keeps the Personal agent section in step with the server, which lists an
/// agent only while its Proactive setting is on (#2091).
extension AppModel {
    /// Reloads the list when a synced change touches a personal session, such
    /// as the Mac turning Proactive on or off.
    func refreshPersonalAgentsIfNeeded(after events: [CloudSyncEvent]) async {
        guard !isPreviewMode, let (api, _, _) = try? projectContext() else { return }
        let sessionIds = PersonalAgentSessionCatalog.personalSessionIds(
            personalAgents: personalAgents,
            conversations: conversations,
            canonical: await api.cachedChatConversations()
        )
        guard PersonalAgentSessionCatalog.eventsTouchPersonalSession(events, personalSessionIds: sessionIds) else { return }
        await refreshPersonalAgents()
    }

    /// A failed request keeps the current list and tags.
    func refreshPersonalAgents() async {
        guard !isPreviewMode,
              let (api, token, accountId) = try? projectContext(),
              let listed = try? await api.listPersonalAgents(token: token),
              (try? projectContext().1) == token,
              account?.accountId == accountId,
              listed != personalAgents else { return }
        personalAgents = listed
        await rebuildConversationCatalog()
        await persistCloudSnapshot(accountId: accountId)
    }
}
