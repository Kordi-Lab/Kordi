import Foundation

/// What a finished connector grant hands back to the app in the callback
/// URL fragment (`kordi_connector`, base64url JSON).
struct CloudConnectorGrantResult: Decodable, Equatable {
    let connectorId: String
    let provider: String
    let grant: String?
    let status: String?
}

/// Pure mapping between `/v1/cloud/connectors` wire models and the shared
/// Connectors screen model, kept separate so tests can cover it directly.
enum CloudConnectorsMapping {
    static let defaultAgentName = "My Kordi"

    static func status(_ wire: String?) -> ConnectorStatus {
        switch wire {
        case "connected": .connected
        case "needs_reauth": .needsReauth
        default: .notConnected
        }
    }

    /// The server reports provider scope strings (for example Google scope
    /// URLs), while the screens use catalog scope ids. A grant that holds any
    /// read scope counts as the catalog read scopes, and likewise for act.
    static func grantedScopeIds(definition: ConnectorDefinition, readScopes: [String], actScopes: [String]) -> [String] {
        (readScopes.isEmpty ? [] : definition.readScopes.map(\.id))
            + (actScopes.isEmpty ? [] : definition.actScopes.map(\.id))
    }

    /// The live summary for a provider. A revoked row counts as absent; when
    /// several rows exist, the most recently updated one wins.
    static func summary(for providerId: ConnectorProviderId, in summaries: [CloudConnectorSummary]) -> CloudConnectorSummary? {
        summaries
            .filter { $0.provider == providerId.rawValue && status($0.status) != .notConnected }
            .max { ($0.updatedAt ?? "") < ($1.updatedAt ?? "") }
    }

    static func state(_ providerId: ConnectorProviderId, summary: CloudConnectorSummary?) -> ConnectorState {
        let definition = ConnectorsModel.definition(providerId)
        // Device-local sources never come from the server.
        guard definition.kind == .service, let summary else { return .empty(providerId) }
        let mapped = status(summary.status)
        guard mapped != .notConnected else { return .empty(providerId) }
        return ConnectorState(
            providerId: providerId,
            status: mapped,
            connectedAt: summary.connectedAt ?? summary.createdAt,
            grantedScopeIds: grantedScopeIds(
                definition: definition,
                readScopes: summary.readScopes,
                actScopes: summary.actScopes
            ),
            actEnabled: summary.actEnabled,
            agentIds: summary.agentIds,
            lastEventAt: summary.lastEventAt
        )
    }

    static func states(from summaries: [CloudConnectorSummary]) -> [ConnectorState] {
        connectorCatalog.map { state($0.providerId, summary: summary(for: $0.providerId, in: summaries)) }
    }

    /// The account's built-in agent first, then its own active agents.
    static func agents(accountId: String?, owned: [CloudAgent]) -> [ConnectorAgent] {
        var result: [ConnectorAgent] = []
        if let accountId = accountId?.nonEmpty {
            result.append(ConnectorAgent(agentId: "cloud-agent:\(accountId)", name: defaultAgentName, isDefault: true))
        }
        for agent in owned where agent.archivedAt == nil && (agent.status ?? "active") == "active" {
            guard !result.contains(where: { $0.agentId == agent.agentId }) else { continue }
            result.append(ConnectorAgent(agentId: agent.agentId, name: agent.name.nonEmpty ?? agent.agentId, isDefault: false))
        }
        return result
    }

    static func agents(_ wire: [CloudConnectorAgent]) -> [ConnectorAgent] {
        wire.map { ConnectorAgent(agentId: $0.agentId, name: $0.name, isDefault: $0.isDefault) }
    }

    static func auditOutcome(_ wire: String) -> ConnectorAuditOutcome {
        ConnectorAuditOutcome(rawValue: wire) ?? .failed
    }

    static func auditEntries(
        _ entries: [CloudConnectorAuditEntry],
        providerId: ConnectorProviderId,
        agents: [ConnectorAgent]
    ) -> [ConnectorAuditEntry] {
        entries.map { entry in
            let agentName: String
            if let agentId = entry.agentId?.nonEmpty {
                agentName = agents.first { $0.agentId == agentId }?.name ?? agentId
            } else {
                // Entries without an agent record the owner's own changes.
                agentName = "You"
            }
            return ConnectorAuditEntry(
                id: entry.auditId,
                providerId: providerId,
                at: entry.createdAt,
                agentName: agentName,
                tool: entry.tool,
                group: ConnectorToolGroup(rawValue: entry.toolGroup) ?? .read,
                outcome: auditOutcome(entry.outcome),
                summary: entry.summary
            )
        }
    }

    /// Reads the grant result from the app callback URL fragment.
    static func parseCallback(_ url: URL, expectedCallbackURL: URL) throws -> CloudConnectorGrantResult {
        guard url.scheme?.lowercased() == expectedCallbackURL.scheme?.lowercased(),
              url.host == expectedCallbackURL.host,
              url.path == expectedCallbackURL.path,
              let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment?.nonEmpty,
              let fragmentURL = URL(string: "https://callback.invalid/?\(fragment)") else {
            throw ConnectorsClientError(message: invalidCallbackMessage)
        }
        let items = URLComponents(url: fragmentURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let message = items.first(where: { $0.name == "kordi_connector_error" })?.value?.nonEmpty {
            throw ConnectorsClientError(message: message)
        }
        guard let encoded = items.first(where: { $0.name == "kordi_connector" })?.value?.nonEmpty else {
            throw ConnectorsClientError(message: invalidCallbackMessage)
        }
        if let data = decodeBase64URL(encoded),
           let result = try? JSONDecoder().decode(CloudConnectorGrantResult.self, from: data),
           !result.connectorId.isEmpty {
            return result
        }
        // A bare connector id, as an earlier draft of the contract described.
        guard encoded.allSatisfy({ $0.isLetter || $0.isNumber || "-_:.".contains($0) }) else {
            throw ConnectorsClientError(message: invalidCallbackMessage)
        }
        return CloudConnectorGrantResult(connectorId: encoded, provider: "", grant: nil, status: nil)
    }

    static let invalidCallbackMessage = "Kordi did not receive a valid answer from the sign-in page. Try again."

    private static func decodeBase64URL(_ value: String) -> Data? {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder != 0 {
            normalized.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: normalized)
    }
}

/// Connectors client backed by `/v1/cloud/connectors`. Device-local sources
/// stay "Not connected" on the iPhone until on-device readers exist.
@MainActor
final class CloudConnectorsClient: ConnectorsClient {
    /// Opens a URL in a web authentication session and returns the callback URL.
    typealias WebAuthenticator = @MainActor (URL) async throws -> URL

    private let api: CloudAPIClient
    private let token: @MainActor () -> String?
    private let accountId: @MainActor () -> String?
    private let callbackURL: URL
    private let authenticate: WebAuthenticator
    private var summaries: [CloudConnectorSummary] = []
    private var agents: [ConnectorAgent] = []

    init(
        api: CloudAPIClient,
        token: @escaping @MainActor () -> String?,
        accountId: @escaping @MainActor () -> String?,
        callbackURL: URL = CloudOAuthCallbackParser.callbackURL,
        authenticate: @escaping WebAuthenticator
    ) {
        self.api = api
        self.token = token
        self.accountId = accountId
        self.callbackURL = callbackURL
        self.authenticate = authenticate
    }

    private func requireToken() throws -> String {
        guard let token = token()?.nonEmpty else {
            throw ConnectorsClientError(message: "Sign in to Kordi to manage connectors.")
        }
        return token
    }

    private func service(_ providerId: ConnectorProviderId) throws -> ConnectorDefinition {
        let definition = ConnectorsModel.definition(providerId)
        guard definition.availability == .available else {
            throw ConnectorsClientError(message: "\(definition.name) is not yet available.")
        }
        guard definition.kind == .service else {
            throw ConnectorsClientError(message: "\(definition.name) is not yet available on this iPhone.")
        }
        return definition
    }

    private func liveSummary(_ providerId: ConnectorProviderId) async throws -> CloudConnectorSummary {
        if let summary = CloudConnectorsMapping.summary(for: providerId, in: summaries) { return summary }
        _ = try await list()
        guard let summary = CloudConnectorsMapping.summary(for: providerId, in: summaries) else {
            throw ConnectorsClientError(message: "Connect \(ConnectorsModel.definition(providerId).name) first.")
        }
        return summary
    }

    private func store(_ summary: CloudConnectorSummary, for providerId: ConnectorProviderId) -> ConnectorState {
        summaries.removeAll { $0.connectorId == summary.connectorId }
        summaries.append(summary)
        return CloudConnectorsMapping.state(providerId, summary: CloudConnectorsMapping.summary(for: providerId, in: summaries))
    }

    func list() async throws -> ConnectorsListResult {
        let token = try requireToken()
        async let response = api.listConnectors(token: token)
        async let owned = try? api.listAgents(token: token)
        let (listed, ownedAgents) = try await (response, owned)
        summaries = listed.connectors
        if let wireAgents = listed.agents {
            agents = CloudConnectorsMapping.agents(wireAgents)
        } else {
            agents = CloudConnectorsMapping.agents(accountId: accountId(), owned: ownedAgents ?? [])
        }
        return ConnectorsListResult(states: CloudConnectorsMapping.states(from: summaries), agents: agents)
    }

    private func runGrant(_ providerId: ConnectorProviderId, grant: CloudConnectorGrant) async throws -> ConnectorState {
        let definition = try service(providerId)
        let token = try requireToken()
        let authURL = try await api.startConnectorOAuth(
            token: token,
            provider: providerId.rawValue,
            grant: grant,
            redirectAfter: callbackURL
        )
        let returnedURL: URL
        do {
            returnedURL = try await authenticate(authURL)
        } catch CloudOAuthSessionError.cancelled {
            throw ConnectorsClientError(message: "Connecting \(definition.name) was canceled.")
        }
        _ = try CloudConnectorsMapping.parseCallback(returnedURL, expectedCallbackURL: callbackURL)
        let result = try await list()
        guard let state = result.states.first(where: { $0.providerId == providerId }), state.status != .notConnected else {
            throw ConnectorsClientError(message: "Kordi could not confirm the connection to \(definition.name). Try again.")
        }
        return state
    }

    func connect(_ providerId: ConnectorProviderId, scopeIds: [String]) async throws -> ConnectorState {
        // The server requests the provider scopes for the read grant; the
        // catalog scope ids only describe them on screen.
        try await runGrant(providerId, grant: .read)
    }

    func grantAct(_ providerId: ConnectorProviderId) async throws -> ConnectorState {
        try await runGrant(providerId, grant: .act)
    }

    func setActEnabled(_ providerId: ConnectorProviderId, enabled: Bool) async throws -> ConnectorState {
        _ = try service(providerId)
        let token = try requireToken()
        let summary = try await liveSummary(providerId)
        return store(try await api.setConnectorAct(token: token, connectorId: summary.connectorId, enabled: enabled), for: providerId)
    }

    func setAgentGrant(_ providerId: ConnectorProviderId, agentId: String, granted: Bool) async throws -> ConnectorState {
        _ = try service(providerId)
        let token = try requireToken()
        let summary = try await liveSummary(providerId)
        var ids = summary.agentIds.filter { $0 != agentId }
        if granted { ids.append(agentId) }
        return store(try await api.setConnectorAgents(token: token, connectorId: summary.connectorId, agentIds: ids), for: providerId)
    }

    func disconnect(_ providerId: ConnectorProviderId) async throws {
        _ = try service(providerId)
        let token = try requireToken()
        let summary = try await liveSummary(providerId)
        _ = try await api.disconnectConnector(token: token, connectorId: summary.connectorId)
        summaries.removeAll { $0.connectorId == summary.connectorId }
    }

    func auditLog(_ providerId: ConnectorProviderId) async throws -> [ConnectorAuditEntry] {
        guard ConnectorsModel.definition(providerId).kind == .service else { return [] }
        let token = try requireToken()
        guard let summary = try? await liveSummary(providerId) else { return [] }
        let page = try await api.connectorAudit(token: token, connectorId: summary.connectorId, limit: 50)
        return CloudConnectorsMapping.auditEntries(page.entries, providerId: providerId, agents: agents)
            .sorted { $0.at > $1.at }
    }

    func recheckPermission(_ providerId: ConnectorProviderId) async throws -> ConnectorState {
        let result = try await list()
        return result.states.first { $0.providerId == providerId } ?? .empty(providerId)
    }
}
