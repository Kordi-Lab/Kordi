import Foundation

/// The owner's personal session with one of their agents (#2091). Listing
/// them also makes the server create any session that is still missing.
struct CloudPersonalAgent: Codable, Hashable, Identifiable, Sendable {
    let agentId: String
    let conversationId: String
    let sessionId: String
    /// Whether the agent may message its owner first in this session.
    let proactive: Bool

    var id: String { agentId }

    init(agentId: String, conversationId: String, sessionId: String, proactive: Bool = false) {
        self.agentId = agentId
        self.conversationId = conversationId
        self.sessionId = sessionId
        self.proactive = proactive
    }

    enum CodingKeys: String, CodingKey {
        case agentId, conversationId, sessionId, proactive
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try container.decode(String.self, forKey: .agentId)
        conversationId = try container.decode(String.self, forKey: .conversationId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        proactive = try container.decodeIfPresent(Bool.self, forKey: .proactive) ?? false
    }
}

struct CloudPersonalAgentsResponse: Decodable {
    let agents: [CloudPersonalAgent]
}

/// `personal_agent` on a conversation snapshot: the owned agent whose personal
/// session this conversation is. Snapshots use snake_case keys.
struct CloudPersonalAgentBinding: Codable, Hashable, Sendable {
    let agentId: String

    enum CodingKeys: String, CodingKey {
        case agentId = "agent_id"
    }
}

extension CloudChatConversation {
    var personalAgentId: String? { personalAgent?.agentId.nonEmpty }
}

extension CloudAPIClient {
    /// Default agent first, then owned definitions by creation time.
    func listPersonalAgents(token: String) async throws -> [CloudPersonalAgent] {
        let response: CloudPersonalAgentsResponse = try await send(
            path: "/v1/cloud/personal-agents",
            method: "GET",
            token: token,
            fallback: "Could not load your personal agents."
        )
        return response.agents.filter {
            $0.agentId.nonEmpty != nil && $0.sessionId.nonEmpty != nil
        }
    }
}

/// `GET|PUT /v1/cloud/agents/{agent_id}/personal-agent`: whether Proactive is
/// on, whether a live connector is granted to the agent, what it watches, and
/// what it shared recently. Proactive can be on only with a connector.
struct CloudPersonalAgentStatus: Decodable, Hashable, Sendable {
    struct Source: Decodable, Hashable, Sendable {
        let connectorId: String
        let provider: String
        let status: String?
    }

    struct Share: Decodable, Hashable, Sendable {
        let at: String
        let text: String
    }

    let proactive: Bool
    /// Older servers omit it and need no connector.
    let connected: Bool
    let sources: [Source]
    let checkedAt: String?
    let recent: [Share]

    init(proactive: Bool, connected: Bool, sources: [Source] = [], checkedAt: String? = nil, recent: [Share] = []) {
        self.proactive = proactive
        self.connected = connected
        self.sources = sources
        self.checkedAt = checkedAt
        self.recent = recent
    }

    enum CodingKeys: String, CodingKey {
        case proactive, connected, sources, checkedAt, recent
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        proactive = (try? container.decodeIfPresent(Bool.self, forKey: .proactive)) ?? false
        connected = (try? container.decodeIfPresent(Bool.self, forKey: .connected)) ?? true
        sources = (try? container.decodeIfPresent([Source].self, forKey: .sources)) ?? []
        checkedAt = try? container.decodeIfPresent(String.self, forKey: .checkedAt)
        recent = (try? container.decodeIfPresent([Share].self, forKey: .recent)) ?? []
    }

    /// The line under "Personal agent": Not set up, Off, or what it watches.
    var statusLine: String {
        if !connected { return "Not set up" }
        if !proactive { return "Off" }
        return "Watching \(sources.count) \(sources.count == 1 ? "source" : "sources")"
    }

    /// The default agent's id on these routes.
    static func defaultAgentId(accountId: String) -> String { "cloud-agent:\(accountId)" }

    static let needsConnectorCode = "personal_agent_needs_connector"
}

private struct PersonalAgentSettingRequest: Encodable {
    let proactive: Bool
}

extension CloudAPIClient {
    func personalAgentStatus(token: String, agentId: String) async throws -> CloudPersonalAgentStatus {
        try await send(
            path: "/v1/cloud/agents/\(Self.groupInvitePathSegment(agentId))/personal-agent",
            method: "GET",
            token: token,
            fallback: "Could not load Personal agent."
        )
    }

    /// `409 personal_agent_needs_connector` when turning it on without a connector.
    func setPersonalAgentProactive(token: String, agentId: String, proactive: Bool) async throws -> CloudPersonalAgentStatus {
        try await send(
            path: "/v1/cloud/agents/\(Self.groupInvitePathSegment(agentId))/personal-agent",
            method: "PUT",
            token: token,
            body: PersonalAgentSettingRequest(proactive: proactive),
            fallback: "Could not update Personal agent."
        )
    }
}
