import Foundation

/// AI access settings, actions that need a person, and "About this reply".
extension CloudAPIClient {
    /// Escapes one path segment, such as a legacy session id
    /// (`session:group:…`), so it can never add segments or a query.
    nonisolated static func agentTrustPathSegment(_ value: String) -> String {
        let unreserved = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        )
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    nonisolated static func aiAccessPath(sessionId: String) -> String {
        "/v2/chat/conversations/\(agentTrustPathSegment(sessionId))/ai-access"
    }

    func aiFeatures(token: String) async throws -> CloudAIFeatures {
        try await send(
            path: "/v2/chat/ai-features",
            method: "GET",
            token: token,
            fallback: "Could not load AI features."
        )
    }

    /// The conversation's AI access as the signed-in member sees it. `nil`
    /// when the server has none for it, such as for a private agent chat.
    func aiAccess(token: String, sessionId: String) async throws -> CloudAIAccess? {
        let response: CloudAIAccessResponse = try await send(
            path: Self.aiAccessPath(sessionId: sessionId),
            method: "GET",
            token: token,
            fallback: "Couldn't load AI access."
        )
        return response.aiAccess
    }

    /// Applies one change and returns the updated AI access.
    func updateAIAccess(
        token: String,
        sessionId: String,
        change: CloudAIAccessChange,
        operationId: UUID = UUID()
    ) async throws -> CloudAIAccess? {
        let response: CloudAIAccessResponse = try await send(
            path: Self.aiAccessPath(sessionId: sessionId),
            method: "PUT",
            token: token,
            body: CloudAIAccessChangeRequest(
                clientOperationId: operationId.uuidString.lowercased(),
                change: change
            ),
            fallback: "Couldn't update AI access. Try again."
        )
        if let conversation = response.conversation { rememberChatConversation(conversation) }
        return response.aiAccess
    }

    /// Pending actions this account may decide, newest first, optionally for
    /// one conversation. Unknown kinds are left out.
    func listAgentActions(token: String, sessionId: String?) async throws -> [CloudPendingAgentAction] {
        let query = sessionId?.nonEmpty.map { [URLQueryItem(name: "sessionId", value: $0)] } ?? []
        let response: CloudPendingAgentActionList = try await send(
            path: "/v1/cloud/agent-actions",
            method: "GET",
            token: token,
            query: query,
            fallback: "Could not load what is waiting for you."
        )
        return response.actions
    }

    func decideAgentAction(
        token: String,
        id: String,
        decision: CloudAgentActionDecision
    ) async throws -> CloudPendingAgentAction? {
        let response: CloudAgentActionDecisionResponse = try await send(
            path: "/v1/cloud/agent-actions/\(Self.agentTrustPathSegment(id))/decision",
            method: "POST",
            token: token,
            body: CloudAgentActionDecisionRequest(decision: decision.rawValue),
            fallback: "Couldn't save your answer. Try again."
        )
        return response.action
    }

    /// Who wrote each reply and where it ran. Replies without a recorded run
    /// are left out of the result.
    func agentReplyDisclosures(
        token: String,
        sessionId: String,
        replies: [CloudAgentReplyDisclosureRequest]
    ) async throws -> [CloudAgentReplyDisclosure] {
        guard !replies.isEmpty else { return [] }
        let response: CloudAgentReplyDisclosureList = try await send(
            path: "/v1/cloud/agent-runs/disclosures",
            method: "POST",
            token: token,
            body: CloudAgentReplyDisclosuresRequest(
                sessionId: sessionId,
                replies: Array(replies.prefix(50))
            ),
            fallback: "Couldn't load details. Try again."
        )
        return response.disclosures
    }
}
