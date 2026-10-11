import Foundation

/// What a finished connector grant hands back to the app in the callback
/// URL fragment (`kordi_connector`, base64url JSON). Current servers send a
/// one-time `completionCode` with `status: "pending"`; the app redeems it at
/// `POST /v1/cloud/connectors/oauth/complete`. Older servers sent the
/// `connectorId` of an already connected row instead.
struct CloudConnectorGrantResult: Decodable, Equatable {
    let completionCode: String?
    let connectorId: String?
    let provider: String
    let grant: String?
    let status: String?

    init(completionCode: String? = nil, connectorId: String? = nil, provider: String, grant: String? = nil, status: String? = nil) {
        self.completionCode = completionCode
        self.connectorId = connectorId
        self.provider = provider
        self.grant = grant
        self.status = status
    }
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

    /// Catalog scope ids for a summary: the server's `grantedScopeIds` when
    /// it sends them, otherwise the coarse mapping from native scopes.
    static func grantedScopeIds(definition: ConnectorDefinition, summary: CloudConnectorSummary) -> [String] {
        if let ids = summary.grantedScopeIds { return ids }
        return grantedScopeIds(definition: definition, readScopes: summary.readScopes, actScopes: summary.actScopes)
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
            grantedScopeIds: grantedScopeIds(definition: definition, summary: summary),
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
        let errorMessage = items.first(where: { $0.name == "kordi_connector_error" })?.value?.nonEmpty
        let errorCode = items.first(where: { $0.name == "kordi_connector_error_code" })?.value?.nonEmpty
        if errorMessage != nil || errorCode != nil {
            throw ConnectorsClientError(message: errorMessage ?? grantFailedMessage, code: errorCode)
        }
        guard let encoded = items.first(where: { $0.name == "kordi_connector" })?.value?.nonEmpty,
              let data = decodeBase64URL(encoded),
              let result = try? JSONDecoder().decode(CloudConnectorGrantResult.self, from: data),
              result.completionCode?.nonEmpty != nil || result.connectorId?.nonEmpty != nil else {
            throw ConnectorsClientError(message: invalidCallbackMessage)
        }
        return result
    }

    static let invalidCallbackMessage = "Kordi did not receive a valid answer from the sign-in page. Try again."
    static let grantFailedMessage = "The sign-in page did not grant access. Try again."

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
        let listed = try await api.listConnectors(token: token)
        summaries = listed.connectors
        if let wireAgents = listed.agents {
            agents = CloudConnectorsMapping.agents(wireAgents)
        } else {
            // Servers that predate the agents field: list them separately.
            let owned = (try? await api.listAgents(token: token)) ?? []
            agents = CloudConnectorsMapping.agents(accountId: accountId(), owned: owned)
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
        let callback = try CloudConnectorsMapping.parseCallback(returnedURL, expectedCallbackURL: callbackURL)
        if let completionCode = callback.completionCode?.nonEmpty {
            // The grant is pending until the app redeems the one-time code.
            let completed = try await api.completeConnectorOAuth(token: token, completionCode: completionCode)
            _ = store(completed, for: providerId)
        }
        let result = try await list()
        let state = result.states.first { $0.providerId == providerId } ?? .empty(providerId)
        switch grant {
        case .read:
            // Connect asks for read and act together. A provider may still
            // return read-only access; that connects with acting off.
            guard state.status == .connected else {
                throw ConnectorsClientError(message: "Kordi could not confirm the connection to \(definition.name). Try again.")
            }
        case .act:
            guard state.status != .notConnected else {
                throw ConnectorsClientError(message: "Kordi could not confirm the connection to \(definition.name). Try again.")
            }
            guard ConnectorsModel.hasGrantedActScopes(definition: definition, state: state) else {
                throw ConnectorsClientError(message: "\(definition.name) did not grant act access.")
            }
        }
        return state
    }

    /// Runs a call against the provider's live connector. When the server no
    /// longer knows the connector, drops the cached row, re-lists, and says so.
    private func withLiveConnector<T>(
        _ providerId: ConnectorProviderId,
        _ body: (CloudConnectorSummary) async throws -> T
    ) async throws -> T {
        let summary = try await liveSummary(providerId)
        do {
            return try await body(summary)
        } catch let error as CloudAPIError where error.code == Self.connectorNotFoundCode {
            summaries.removeAll { $0.provider == providerId.rawValue }
            _ = try? await list()
            throw ConnectorsClientError(
                message: "\(ConnectorsModel.definition(providerId).name) is no longer connected.",
                code: Self.connectorNotFoundCode
            )
        }
    }

    static let connectorNotFoundCode = "connector_not_found"

    func connect(_ providerId: ConnectorProviderId, scopeIds: [String]) async throws -> ConnectorState {
        // The server requests the provider's read and act scopes for the
        // connect grant; the catalog scope ids only describe them on screen.
        try await runGrant(providerId, grant: .read)
    }

    func grantAct(_ providerId: ConnectorProviderId) async throws -> ConnectorState {
        try await runGrant(providerId, grant: .act)
    }

    func setActEnabled(_ providerId: ConnectorProviderId, enabled: Bool) async throws -> ConnectorState {
        _ = try service(providerId)
        let token = try requireToken()
        let updated = try await withLiveConnector(providerId) { summary in
            try await api.setConnectorAct(token: token, connectorId: summary.connectorId, enabled: enabled)
        }
        return store(updated, for: providerId)
    }

    func setAgentGrant(_ providerId: ConnectorProviderId, agentId: String, granted: Bool) async throws -> ConnectorState {
        _ = try service(providerId)
        let token = try requireToken()
        if agents.isEmpty { _ = try await list() }
        let updated = try await withLiveConnector(providerId) { summary in
            // Only send agents that still exist, so a grant left on an
            // archived agent cannot make every change fail validation.
            let known = Set(agents.map(\.agentId))
            var ids = summary.agentIds.filter { $0 != agentId && known.contains($0) }
            if granted { ids.append(agentId) }
            return try await api.setConnectorAgents(token: token, connectorId: summary.connectorId, agentIds: ids)
        }
        return store(updated, for: providerId)
    }

    func disconnect(_ providerId: ConnectorProviderId) async throws {
        _ = try service(providerId)
        let token = try requireToken()
        let connectorId = try await withLiveConnector(providerId) { summary in
            _ = try await api.disconnectConnector(token: token, connectorId: summary.connectorId)
            return summary.connectorId
        }
        summaries.removeAll { $0.connectorId == connectorId }
    }

    func auditLog(_ providerId: ConnectorProviderId) async throws -> [ConnectorAuditEntry] {
        guard ConnectorsModel.definition(providerId).kind == .service else { return [] }
        let token = try requireToken()
        guard (try? await liveSummary(providerId)) != nil else { return [] }
        let page = try await withLiveConnector(providerId) { summary in
            try await api.connectorAudit(token: token, connectorId: summary.connectorId, limit: 50)
        }
        return CloudConnectorsMapping.auditEntries(page.entries, providerId: providerId, agents: agents)
            .sorted { $0.at > $1.at }
    }

    func recheckPermission(_ providerId: ConnectorProviderId) async throws -> ConnectorState {
        let result = try await list()
        return result.states.first { $0.providerId == providerId } ?? .empty(providerId)
    }
}
