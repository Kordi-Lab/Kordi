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

    /// The default agent's Personal agent status; nil while signed out, in
    /// a preview without the argument, or when the server has no such route.
    func defaultPersonalAgentStatus() async -> CloudPersonalAgentStatus? {
        if isPreviewMode { return PersonalAgentStatusPreview.status() }
        guard let (api, token, accountId) = try? projectContext() else { return nil }
        return try? await api.personalAgentStatus(
            token: token,
            agentId: CloudPersonalAgentStatus.defaultAgentId(accountId: accountId)
        )
    }

    /// Turns the default agent's Proactive on or off. Without a connector the
    /// server refuses with 409; the reloaded status then shows Not set up
    /// instead of an error.
    func setDefaultPersonalAgentProactive(_ proactive: Bool) async -> Result<CloudPersonalAgentStatus?, CloudAPIError> {
        if isPreviewMode {
            guard let current = PersonalAgentStatusPreview.status() else { return .success(nil) }
            return .success(CloudPersonalAgentStatus(
                proactive: proactive && current.connected,
                connected: current.connected,
                sources: current.sources,
                checkedAt: current.checkedAt,
                recent: current.recent
            ))
        }
        guard let (api, token, accountId) = try? projectContext() else {
            return .failure(CloudAPIError(code: "signed_out", message: "Sign in to change Personal agent.", statusCode: 0))
        }
        let agentId = CloudPersonalAgentStatus.defaultAgentId(accountId: accountId)
        do {
            let status = try await api.setPersonalAgentProactive(token: token, agentId: agentId, proactive: proactive)
            await refreshPersonalAgents()
            return .success(status)
        } catch let error as CloudAPIError where error.statusCode == 409 || error.code == CloudPersonalAgentStatus.needsConnectorCode {
            return .success(try? await api.personalAgentStatus(token: token, agentId: agentId))
        } catch let error as CloudAPIError {
            return .failure(error)
        } catch {
            return .failure(CloudAPIError(code: "personal_agent_failed", message: "Could not update Personal agent.", statusCode: 0))
        }
    }
}

/// Synthetic Personal agent states for previews: `--preview-personal-agent`
/// is on and watching two sources; `--preview-personal-agent-unset` has no
/// connector yet.
enum PersonalAgentStatusPreview {
    static func status(arguments: [String] = ProcessInfo.processInfo.arguments) -> CloudPersonalAgentStatus? {
        if arguments.contains("--preview-personal-agent-unset") {
            return CloudPersonalAgentStatus(proactive: false, connected: false)
        }
        guard arguments.contains("--preview-personal-agent") else { return nil }
        let formatter = ISO8601DateFormatter()
        let now = Date()
        return CloudPersonalAgentStatus(
            proactive: true,
            connected: true,
            sources: [
                .init(connectorId: "preview-gmail", provider: "gmail", status: "active"),
                .init(connectorId: "preview-calendar", provider: "google_calendar", status: "active"),
            ],
            checkedAt: formatter.string(from: now.addingTimeInterval(-240)),
            recent: [
                .init(at: formatter.string(from: now.addingTimeInterval(-3_600)), text: "Maya moved the design review to Thursday at 3 PM."),
                .init(at: formatter.string(from: now.addingTimeInterval(-7_200)), text: "The flight confirmation for Monday arrived."),
            ]
        )
    }
}
