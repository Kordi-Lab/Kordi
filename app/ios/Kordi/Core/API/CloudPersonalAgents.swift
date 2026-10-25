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
