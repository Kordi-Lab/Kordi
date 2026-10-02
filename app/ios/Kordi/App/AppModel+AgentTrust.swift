import Foundation

/// A group this person just created. `pipFailed` is set when they asked for
/// PiP and it could not be turned on; the group exists either way.
struct CreatedGroup: Equatable {
    let conversation: ConversationSummary
    let pipFailed: Bool
}

/// The outcome of looking up "About this reply".
enum AgentReplyDisclosureLoad: Equatable {
    case loaded(CloudAgentReplyDisclosure)
    case missing
    case failed
}

/// AI access settings, actions that need a person, and reply disclosure.
extension AppModel {
    private var agentTrustContext: (api: CloudAPIClient, token: String, accountId: String)? {
        guard let (api, token, accountId) = try? digestContext() else { return nil }
        return (api, token, accountId)
    }

    // MARK: AI features and access

    /// Whether PiP is available on this server, loaded once per session.
    @discardableResult
    func loadAIFeatures(force: Bool = false) async -> CloudAIFeatures? {
        if isPreviewMode {
            aiFeatures = CloudAIFeatures(pipAvailable: true, pipProviderLabel: "OpenAI")
            return aiFeatures
        }
        if let aiFeatures, !force { return aiFeatures }
        guard let context = agentTrustContext,
              let features = try? await context.api.aiFeatures(token: context.token) else { return aiFeatures }
        aiFeatures = features
        return features
    }

    func loadAIAccess(for conversation: ConversationSummary) async throws -> CloudAIAccess? {
        if isPreviewMode { return previewAIAccess(for: conversation) }
        guard let context = agentTrustContext else { throw CancellationError() }
        return try await context.api.aiAccess(token: context.token, sessionId: conversation.sessionId)
    }

    /// Applies one change. Returns the error text to show inline on failure.
    func updateAIAccess(
        _ change: CloudAIAccessChange,
        for conversation: ConversationSummary
    ) async -> Result<CloudAIAccess?, AIAccessUpdateFailure> {
        if isPreviewMode {
            var access = previewAIAccess(for: conversation)
            switch change {
            case .historyScope(let scope): access.historyScope = scope
            case .pipEnabled(let enabled): access.pip?.enabled = enabled
            case .excludeMyMessages(let excluded):
                access.viewerExcluded = excluded
                let me = account?.accountId ?? "acct_me"
                access.excludedMemberIds.removeAll { $0 == me }
                if excluded { access.excludedMemberIds.append(me) }
            }
            previewAIAccessBySession[conversation.sessionId] = access
            return .success(access)
        }
        guard let context = agentTrustContext else {
            return .failure(AIAccessUpdateFailure(message: AIAccessCopy.updateFailed))
        }
        do {
            let access = try await context.api.updateAIAccess(
                token: context.token,
                sessionId: conversation.sessionId,
                change: change
            )
            return .success(access)
        } catch {
            let code = (error as? CloudAPIError)?.code
            return .failure(AIAccessUpdateFailure(message: AIAccessCopy.updateErrorText(code: code)))
        }
    }

    private func previewAIAccess(for conversation: ConversationSummary) -> CloudAIAccess {
        if let stored = previewAIAccessBySession[conversation.sessionId] { return stored }
        let isGroup = conversation.kind == .group
        return CloudAIAccess(
            historyScope: isGroup ? .mentions : .recent,
            pip: isGroup ? CloudPipAccess(available: true, enabled: true, providerLabel: "OpenAI") : nil,
            excludedMemberIds: isGroup ? conversation.groupParticipants.last.map { [$0.accountId] } ?? [] : [],
            viewerExcluded: false,
            viewerCanManage: isGroup
        )
    }

    /// Turns PiP on in a group this person just created. Returns `false`
    /// when PiP could not be turned on; the group stays either way.
    func enablePipInNewGroup(sessionId: String) async -> Bool {
        guard let context = agentTrustContext else { return false }
        do {
            let access = try await context.api.updateAIAccess(
                token: context.token,
                sessionId: sessionId,
                change: .pipEnabled(true)
            )
            return access?.pip?.enabled ?? true
        } catch {
            return false
        }
    }

    /// A new channel keeps PiP when the group's first channel has it on.
    /// Best effort: failures leave PiP off, which members can change later.
    func inheritPip(from sourceSessionId: String, to sessionId: String) async {
        guard sourceSessionId != sessionId, let context = agentTrustContext else { return }
        guard let source = try? await context.api.aiAccess(token: context.token, sessionId: sourceSessionId),
              source.pip?.enabled == true else { return }
        _ = try? await context.api.updateAIAccess(
            token: context.token,
            sessionId: sessionId,
            change: .pipEnabled(true)
        )
    }

    // MARK: Actions that need a person

    func pendingAgentActions(for sessionId: String) -> [CloudPendingAgentAction] {
        pendingAgentActionsBySession[sessionId] ?? []
    }

    /// Reloads what is waiting for this person, for one conversation or, with
    /// `nil`, for every conversation.
    func refreshPendingAgentActions(sessionId: String? = nil) async {
        if isPreviewMode {
            seedPreviewAgentActionsIfRequested()
            return
        }
        guard let context = agentTrustContext else { return }
        if let sessionId, !AIAccessCopy.supportsAIAccess(sessionId: sessionId) { return }
        guard let actions = try? await context.api.listAgentActions(token: context.token, sessionId: sessionId),
              agentTrustContext?.token == context.token else { return }
        let grouped = Dictionary(grouping: actions.filter { $0.sessionId != nil }) { $0.sessionId ?? "" }
        if let sessionId {
            pendingAgentActionsBySession[sessionId] = grouped[sessionId] ?? []
        } else {
            pendingAgentActionsBySession = grouped
        }
    }

    /// `agent_action.updated` arrived through sync: reload the affected
    /// conversations, or everything when the conversation is not known yet.
    func refreshPendingAgentActions(after events: [CloudSyncEvent]) {
        let signals = events.filter { $0.eventType == CloudAPIClient.agentActionUpdatedEventType }
        guard !signals.isEmpty else { return }
        let sessionIds = Set(signals.compactMap { $0.payload?.sessionId?.nonEmpty })
        let refreshesEverything = signals.contains { $0.payload?.sessionId?.nonEmpty == nil }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if refreshesEverything {
                await self.refreshPendingAgentActions(sessionId: nil)
            } else {
                for sessionId in sessionIds.sorted() {
                    await self.refreshPendingAgentActions(sessionId: sessionId)
                }
            }
        }
    }

    /// Sends a decision. Returns `nil` on success, or the error text to show.
    func decidePendingAgentAction(
        _ action: CloudPendingAgentAction,
        decision: CloudAgentActionDecision
    ) async -> String? {
        let sessionId = action.sessionId ?? ""
        if isPreviewMode {
            pendingAgentActionsBySession[sessionId]?.removeAll { $0.actionId == action.actionId }
            return nil
        }
        guard let context = agentTrustContext else { return PendingAgentActionCopy.errorText(code: nil) }
        do {
            _ = try await context.api.decideAgentAction(token: context.token, id: action.actionId, decision: decision)
            pendingAgentActionsBySession[sessionId]?.removeAll { $0.actionId == action.actionId }
            await refreshPendingAgentActions(sessionId: sessionId)
            return nil
        } catch {
            let code = (error as? CloudAPIError)?.code
            if code == "plan_changed" || code == "agent_action_closed" || code == "agent_action_not_found" {
                // The request is no longer waiting; stop offering it.
                pendingAgentActionsBySession[sessionId]?.removeAll { $0.actionId == action.actionId }
            }
            return PendingAgentActionCopy.errorText(code: code)
        }
    }

    private func seedPreviewAgentActionsIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("--preview-agent-actions"),
              let group = conversations.first(where: { $0.kind == .group }),
              pendingAgentActionsBySession[group.sessionId] == nil else { return }
        let start = ISO8601DateFormatter().string(from: Date().addingTimeInterval(86_400))
        pendingAgentActionsBySession[group.sessionId] = [
            CloudPendingAgentAction(
                actionId: "preview-calendar",
                kind: .calendarDisclosure,
                sessionId: group.sessionId,
                proposedBy: .init(accountId: account?.accountId, displayName: "Kordi", isPip: false),
                subject: .init(agentName: "Kordi", startAt: start)
            ),
            CloudPendingAgentAction(
                actionId: "preview-rsvp",
                kind: .planRSVP,
                sessionId: group.sessionId,
                proposedBy: .init(accountId: KordiPipIdentity.accountId, displayName: "PiP", isPip: true),
                subject: .init(startAt: start, title: "Team lunch", rsvp: "yes")
            ),
        ]
    }

    // MARK: About this reply

    func replyDisclosure(
        for message: ChatMessage,
        in conversation: ConversationSummary
    ) async -> AgentReplyDisclosureLoad {
        guard let request = AgentReplyDisclosurePresentation.request(
            for: message,
            sessionId: conversation.sessionId
        ) else { return .missing }
        if let cached = agentReplyDisclosureCache[request.key] { return .loaded(cached) }
        if isPreviewMode {
            return .loaded(CloudAgentReplyDisclosure(
                key: request.key,
                agentName: message.authorName,
                ownerName: message.senderOwnerName,
                requesterName: "You",
                runtime: .kordiCloud,
                credentials: .owner,
                provider: "openai",
                providerLabel: "OpenAI"
            ))
        }
        guard let context = agentTrustContext else { return .failed }
        do {
            let disclosures = try await context.api.agentReplyDisclosures(
                token: context.token,
                sessionId: conversation.sessionId,
                replies: [request]
            )
            guard let disclosure = disclosures.first(where: { $0.key == request.key }) else { return .missing }
            agentReplyDisclosureCache[request.key] = disclosure
            return .loaded(disclosure)
        } catch {
            if let error = error as? CloudAPIError, error.statusCode == 404 { return .missing }
            return .failed
        }
    }

    /// Clears per-account AI state when the signed-in account changes.
    func resetAgentTrustState() {
        pendingAgentActionsBySession = [:]
        agentReplyDisclosureCache = [:]
        previewAIAccessBySession = [:]
        aiFeatures = nil
    }
}

struct AIAccessUpdateFailure: Error, Equatable {
    let message: String
}
