import Foundation

// Typed calls for `/v1/cloud/connectors` and the capability flag that
// announces it. Wire names follow bridges/cloud-server/src/connectors/models.rs.
// None of these models carries a credential: the server keeps provider
// sign-ins to itself and only returns connector metadata.

/// `GET /v1/cloud/auth/capabilities`. Decoded leniently so older servers,
/// which omit `connectorsVersion`, still parse.
struct CloudAuthCapabilities: Decodable, Equatable {
    let password: Bool?
    let oauthProviders: [String]
    /// Present when the server serves `/v1/cloud/connectors`.
    let connectorsVersion: Int?

    private enum CodingKeys: String, CodingKey {
        case password, oauthProviders, connectorsVersion
    }

    init(password: Bool? = nil, oauthProviders: [String] = [], connectorsVersion: Int? = nil) {
        self.password = password
        self.oauthProviders = oauthProviders
        self.connectorsVersion = connectorsVersion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        password = try? container.decodeIfPresent(Bool.self, forKey: .password)
        oauthProviders = (try? container.decodeIfPresent([String].self, forKey: .oauthProviders)) ?? []
        connectorsVersion = try? container.decodeIfPresent(Int.self, forKey: .connectorsVersion)
    }
}

/// One connector as `GET /v1/cloud/connectors` reports it.
struct CloudConnectorSummary: Decodable, Equatable {
    let connectorId: String
    /// Provider id, matching `ConnectorProviderId` raw values.
    let provider: String
    /// `connected`, `needs_reauth`, or `revoked`.
    let status: String
    /// Provider scope strings, for example Google scope URLs.
    let readScopes: [String]
    let actScopes: [String]
    let actEnabled: Bool
    let agentIds: [String]
    let createdAt: String?
    let updatedAt: String?
    let revokedAt: String?
    /// Not sent by the first server version; read when a later one adds it.
    let connectedAt: String?
    /// Not sent by the first server version; read when a later one adds it.
    let lastEventAt: String?

    private enum CodingKeys: String, CodingKey {
        case connectorId, provider, status, readScopes, actScopes, actEnabled, agentIds
        case createdAt, updatedAt, revokedAt, connectedAt, lastEventAt
    }

    init(
        connectorId: String,
        provider: String,
        status: String,
        readScopes: [String] = [],
        actScopes: [String] = [],
        actEnabled: Bool = false,
        agentIds: [String] = [],
        createdAt: String? = nil,
        updatedAt: String? = nil,
        revokedAt: String? = nil,
        connectedAt: String? = nil,
        lastEventAt: String? = nil
    ) {
        self.connectorId = connectorId
        self.provider = provider
        self.status = status
        self.readScopes = readScopes
        self.actScopes = actScopes
        self.actEnabled = actEnabled
        self.agentIds = agentIds
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.revokedAt = revokedAt
        self.connectedAt = connectedAt
        self.lastEventAt = lastEventAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorId = try container.decode(String.self, forKey: .connectorId)
        provider = try container.decode(String.self, forKey: .provider)
        status = try container.decode(String.self, forKey: .status)
        readScopes = try container.decodeIfPresent([String].self, forKey: .readScopes) ?? []
        actScopes = try container.decodeIfPresent([String].self, forKey: .actScopes) ?? []
        actEnabled = try container.decodeIfPresent(Bool.self, forKey: .actEnabled) ?? false
        agentIds = try container.decodeIfPresent([String].self, forKey: .agentIds) ?? []
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        revokedAt = try container.decodeIfPresent(String.self, forKey: .revokedAt)
        connectedAt = try container.decodeIfPresent(String.self, forKey: .connectedAt)
        lastEventAt = try container.decodeIfPresent(String.self, forKey: .lastEventAt)
    }
}

/// An agent the server lists next to the connectors, when it does.
struct CloudConnectorAgent: Decodable, Equatable {
    let agentId: String
    let name: String
    let isDefault: Bool

    private enum CodingKeys: String, CodingKey {
        case agentId, name, isDefault
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try container.decode(String.self, forKey: .agentId)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? agentId
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }
}

struct CloudConnectorListResponse: Decodable, Equatable {
    let connectors: [CloudConnectorSummary]
    /// The first server version does not send agents; the client then lists
    /// them from `/v1/cloud/agents`.
    let agents: [CloudConnectorAgent]?

    private enum CodingKeys: String, CodingKey {
        case connectors, agents
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectors = try container.decodeIfPresent([CloudConnectorSummary].self, forKey: .connectors) ?? []
        agents = try container.decodeIfPresent([CloudConnectorAgent].self, forKey: .agents)
    }
}

struct CloudConnectorResponse: Decodable, Equatable {
    let connector: CloudConnectorSummary
}

struct CloudConnectorAuditEntry: Decodable, Equatable {
    let auditId: String
    let connectorId: String?
    let runId: String?
    let agentId: String?
    let tool: String
    /// `read` or `act`.
    let toolGroup: String
    /// `completed`, `approved`, `denied`, `blocked_background`, or `failed`.
    let outcome: String
    let summary: String
    let createdAt: String
}

struct CloudConnectorAuditPage: Decodable, Equatable {
    let entries: [CloudConnectorAuditEntry]
    let nextBefore: String?
}

struct CloudConnectorDisconnectResponse: Decodable, Equatable {
    let deletedEvents: Int
}

enum CloudConnectorGrant: String, Encodable {
    case read
    case act
}

private struct CloudConnectorOAuthStartRequest: Encodable {
    let grant: CloudConnectorGrant
    let redirectAfter: String?
}

private struct CloudConnectorOAuthStartResponse: Decodable {
    let authUrl: String
}

private struct CloudConnectorSetActRequest: Encodable {
    let enabled: Bool
}

private struct CloudConnectorSetAgentsRequest: Encodable {
    let agentIds: [String]
}

extension CloudAPIClient {
    private static let connectorPathAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~:"))

    private func connectorPath(_ id: String, _ suffix: String = "") -> String {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.connectorPathAllowed) ?? id
        return "/v1/cloud/connectors/\(encoded)\(suffix)"
    }

    func authCapabilities() async throws -> CloudAuthCapabilities {
        try await send(
            path: "/v1/cloud/auth/capabilities",
            method: "GET",
            fallback: "Could not load Kordi Cloud capabilities."
        )
    }

    func listConnectors(token: String) async throws -> CloudConnectorListResponse {
        try await send(
            path: "/v1/cloud/connectors",
            method: "GET",
            token: token,
            fallback: "Could not load connectors."
        )
    }

    /// Starts a connector grant and returns the provider sign-in page.
    func startConnectorOAuth(
        token: String,
        provider: String,
        grant: CloudConnectorGrant,
        redirectAfter: URL?
    ) async throws -> URL {
        let response: CloudConnectorOAuthStartResponse = try await send(
            path: connectorPath(provider, "/oauth/start"),
            method: "POST",
            token: token,
            body: CloudConnectorOAuthStartRequest(grant: grant, redirectAfter: redirectAfter?.absoluteString),
            fallback: "Could not start connecting."
        )
        guard let authURL = URL(string: response.authUrl), authURL.scheme?.lowercased() == "https" else {
            throw CloudAPIError(
                code: "invalid_oauth_response",
                message: "Kordi Cloud returned an invalid sign-in page.",
                statusCode: 0
            )
        }
        return authURL
    }

    func setConnectorAct(token: String, connectorId: String, enabled: Bool) async throws -> CloudConnectorSummary {
        let response: CloudConnectorResponse = try await send(
            path: connectorPath(connectorId, "/act"),
            method: "POST",
            token: token,
            body: CloudConnectorSetActRequest(enabled: enabled),
            fallback: "Could not update this connector."
        )
        return response.connector
    }

    func setConnectorAgents(token: String, connectorId: String, agentIds: [String]) async throws -> CloudConnectorSummary {
        let response: CloudConnectorResponse = try await send(
            path: connectorPath(connectorId, "/agents"),
            method: "PUT",
            token: token,
            body: CloudConnectorSetAgentsRequest(agentIds: agentIds),
            fallback: "Could not update this connector."
        )
        return response.connector
    }

    func connectorAudit(
        token: String,
        connectorId: String,
        limit: Int? = nil,
        before: String? = nil
    ) async throws -> CloudConnectorAuditPage {
        var query: [URLQueryItem] = []
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        if let before = before?.nonEmpty { query.append(URLQueryItem(name: "before", value: before)) }
        return try await send(
            path: connectorPath(connectorId, "/audit"),
            method: "GET",
            token: token,
            query: query,
            fallback: "Could not load connector activity."
        )
    }

    func disconnectConnector(token: String, connectorId: String) async throws -> CloudConnectorDisconnectResponse {
        try await send(
            path: connectorPath(connectorId),
            method: "DELETE",
            token: token,
            fallback: "Could not disconnect this connector."
        )
    }
}
