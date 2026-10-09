import Foundation

struct ConnectorsClientError: LocalizedError, Equatable {
    let message: String
    /// A stable server error code, such as `kordi_connector_error_code` from
    /// the grant callback or `connector_not_found`, when one is known.
    var code: String? = nil
    var errorDescription: String? { message }
}

struct ConnectorsListResult: Equatable {
    let states: [ConnectorState]
    let agents: [ConnectorAgent]
}

/// The operations the Connectors settings screens use. Mirrors the desktop
/// `ConnectorsClient` in app/desktop/src/features/connectors/connectorsClient.ts.
@MainActor
protocol ConnectorsClient: AnyObject {
    func list() async throws -> ConnectorsListResult
    func connect(_ providerId: ConnectorProviderId, scopeIds: [String]) async throws -> ConnectorState
    func grantAct(_ providerId: ConnectorProviderId) async throws -> ConnectorState
    func setActEnabled(_ providerId: ConnectorProviderId, enabled: Bool) async throws -> ConnectorState
    func setAgentGrant(_ providerId: ConnectorProviderId, agentId: String, granted: Bool) async throws -> ConnectorState
    func disconnect(_ providerId: ConnectorProviderId) async throws
    func auditLog(_ providerId: ConnectorProviderId) async throws -> [ConnectorAuditEntry]
    func recheckPermission(_ providerId: ConnectorProviderId) async throws -> ConnectorState
}

/// In-memory connectors client with sample data. It never holds anything that
/// looks like a credential; it only models what the settings page shows.
@MainActor
final class PreviewConnectorsClient: ConnectorsClient {
    private static let minute: TimeInterval = 60
    private static let hour: TimeInterval = 60 * minute
    private static let day: TimeInterval = 24 * hour

    private let latency: TimeInterval
    private let now: () -> Date
    private let agents: [ConnectorAgent] = [
        ConnectorAgent(agentId: "agent-default", name: "My Kordi", isDefault: true),
        ConnectorAgent(agentId: "agent-research", name: "Research", isDefault: false),
        ConnectorAgent(agentId: "agent-ops", name: "Ops", isDefault: false),
    ]
    private var states: [ConnectorProviderId: ConnectorState]
    private var audit: [ConnectorAuditEntry]

    /// - Parameters:
    ///   - latency: Simulated network latency in seconds.
    ///   - now: Clock used for seeded and new timestamps.
    init(latency: TimeInterval = 0.4, now: @escaping () -> Date = Date.init) {
        self.latency = latency
        self.now = now
        let seededAt = now()
        func ago(_ interval: TimeInterval) -> String {
            Self.timestamp(seededAt.addingTimeInterval(-interval))
        }
        let minute = Self.minute, hour = Self.hour, day = Self.day

        var states = Dictionary(uniqueKeysWithValues: connectorCatalog.map { ($0.providerId, ConnectorState.empty($0.providerId)) })
        states[.googleCalendar] = ConnectorState(
            providerId: .googleCalendar,
            status: .connected,
            connectedAt: ago(12 * day),
            grantedScopeIds: Self.readScopeIds(.googleCalendar) + Self.actScopeIds(.googleCalendar),
            actEnabled: true,
            agentIds: ["agent-default"],
            lastEventAt: ago(20 * minute)
        )
        states[.github] = ConnectorState(
            providerId: .github,
            status: .connected,
            connectedAt: ago(30 * day),
            grantedScopeIds: Self.readScopeIds(.github),
            actEnabled: false,
            agentIds: ["agent-default", "agent-research"],
            lastEventAt: ago(4 * minute)
        )
        states[.slack] = ConnectorState(
            providerId: .slack,
            status: .needsReauth,
            connectedAt: ago(60 * day),
            grantedScopeIds: Self.readScopeIds(.slack),
            actEnabled: false,
            agentIds: ["agent-default"],
            lastEventAt: ago(3 * day)
        )
        states[.macCalendar] = ConnectorState(
            providerId: .macCalendar,
            status: .connected,
            connectedAt: ago(5 * day),
            grantedScopeIds: Self.readScopeIds(.macCalendar),
            actEnabled: false,
            agentIds: agents.map(\.agentId),
            lastEventAt: ago(2 * hour)
        )
        var notificationCenter = ConnectorState.empty(.macNotificationCenter)
        notificationCenter.status = .permissionMissing
        states[.macNotificationCenter] = notificationCenter
        self.states = states

        audit = [
            ConnectorAuditEntry(
                id: "audit-1", providerId: .googleCalendar, at: ago(18 * minute), agentName: "My Kordi",
                tool: "calendar.list_events", group: .read, outcome: .completed,
                summary: "Read events for today and tomorrow."
            ),
            ConnectorAuditEntry(
                id: "audit-2", providerId: .googleCalendar, at: ago(2 * hour), agentName: "My Kordi",
                tool: "calendar.reply_invitation", group: .act, outcome: .approved,
                summary: "Accepted \"Design review\" on Thursday after you approved it."
            ),
            ConnectorAuditEntry(
                id: "audit-3", providerId: .googleCalendar, at: ago(6 * hour), agentName: "My Kordi",
                tool: "calendar.create_event", group: .act, outcome: .blockedBackground,
                summary: "Background digest asked for calendar.create_event and was given read tools only."
            ),
            ConnectorAuditEntry(
                id: "audit-4", providerId: .googleCalendar, at: ago(day + 3 * hour), agentName: "My Kordi",
                tool: "calendar.create_event", group: .act, outcome: .denied,
                summary: "Proposed a 30 minute focus block on Friday. You declined."
            ),
            ConnectorAuditEntry(
                id: "audit-5", providerId: .github, at: ago(5 * minute), agentName: "Research",
                tool: "github.list_notifications", group: .read, outcome: .completed,
                summary: "Read 7 unread notifications."
            ),
            ConnectorAuditEntry(
                id: "audit-6", providerId: .github, at: ago(3 * hour), agentName: "My Kordi",
                tool: "github.get_pull_request", group: .read, outcome: .completed,
                summary: "Checked review state on a pull request you follow."
            ),
            ConnectorAuditEntry(
                id: "audit-7", providerId: .github, at: ago(2 * day), agentName: "My Kordi",
                tool: "github.create_comment", group: .act, outcome: .blockedBackground,
                summary: "Scheduled task asked for github.create_comment and was given read tools only."
            ),
        ]
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func readScopeIds(_ providerId: ConnectorProviderId) -> [String] {
        ConnectorsModel.definition(providerId).readScopes.map(\.id)
    }

    private static func actScopeIds(_ providerId: ConnectorProviderId) -> [String] {
        ConnectorsModel.definition(providerId).actScopes.map(\.id)
    }

    private func wait() async {
        guard latency > 0 else { return }
        try? await Task.sleep(nanoseconds: UInt64(latency * 1_000_000_000))
    }

    private func current(_ providerId: ConnectorProviderId) throws -> ConnectorState {
        guard let state = states[providerId] else {
            throw ConnectorsClientError(message: "This connector is not available.")
        }
        return state
    }

    @discardableResult
    private func store(_ state: ConnectorState) -> ConnectorState {
        states[state.providerId] = state
        return state
    }

    private var defaultAgentIds: [String] {
        agents.filter(\.isDefault).map(\.agentId)
    }

    private func union(_ ids: [String], _ more: [String]) -> [String] {
        var result = ids
        for id in more where !result.contains(id) { result.append(id) }
        return result
    }

    func list() async throws -> ConnectorsListResult {
        await wait()
        return ConnectorsListResult(
            states: try connectorCatalog.map { try current($0.providerId) },
            agents: agents
        )
    }

    func connect(_ providerId: ConnectorProviderId, scopeIds: [String]) async throws -> ConnectorState {
        await wait()
        let definition = ConnectorsModel.definition(providerId)
        guard definition.availability == .available else {
            throw ConnectorsClientError(message: "\(definition.name) is not yet available.")
        }
        let allowed = Self.readScopeIds(providerId)
        let requested = scopeIds.filter { allowed.contains($0) }
        let previous = try current(providerId)
        if definition.requiresFullDiskAccess {
            // Full Disk Access cannot be requested in-app; the person grants it in System Settings.
            var state = ConnectorState.empty(providerId)
            state.status = .permissionMissing
            return store(state)
        }
        // Device-local sources resolve as if the system permission prompt was allowed.
        return store(ConnectorState(
            providerId: providerId,
            status: .connected,
            connectedAt: Self.timestamp(now()),
            grantedScopeIds: requested.isEmpty ? allowed : requested,
            actEnabled: false,
            agentIds: previous.agentIds.isEmpty ? defaultAgentIds : previous.agentIds,
            lastEventAt: previous.lastEventAt
        ))
    }

    func grantAct(_ providerId: ConnectorProviderId) async throws -> ConnectorState {
        await wait()
        var state = try current(providerId)
        guard state.status == .connected else {
            throw ConnectorsClientError(message: "Connect first, then let your agent act here.")
        }
        state.grantedScopeIds = union(state.grantedScopeIds, Self.actScopeIds(providerId))
        state.actEnabled = true
        return store(state)
    }

    func setActEnabled(_ providerId: ConnectorProviderId, enabled: Bool) async throws -> ConnectorState {
        await wait()
        var state = try current(providerId)
        if enabled {
            let definition = ConnectorsModel.definition(providerId)
            let missing = definition.actScopes.contains { !state.grantedScopeIds.contains($0.id) }
            if definition.kind == .service && missing {
                throw ConnectorsClientError(message: "Grant act access to \(definition.name) first.")
            }
            if definition.kind == .macLocal && missing {
                state.grantedScopeIds = union(state.grantedScopeIds, Self.actScopeIds(providerId))
            }
        }
        state.actEnabled = enabled
        return store(state)
    }

    func setAgentGrant(_ providerId: ConnectorProviderId, agentId: String, granted: Bool) async throws -> ConnectorState {
        await wait()
        var state = try current(providerId)
        var ids = Set(state.agentIds)
        if granted { ids.insert(agentId) } else { ids.remove(agentId) }
        state.agentIds = agents.map(\.agentId).filter { ids.contains($0) }
        return store(state)
    }

    func disconnect(_ providerId: ConnectorProviderId) async throws {
        await wait()
        states[providerId] = .empty(providerId)
        audit.removeAll { $0.providerId == providerId }
    }

    func auditLog(_ providerId: ConnectorProviderId) async throws -> [ConnectorAuditEntry] {
        await wait()
        return audit
            .filter { $0.providerId == providerId }
            .sorted { $0.at > $1.at }
    }

    func recheckPermission(_ providerId: ConnectorProviderId) async throws -> ConnectorState {
        await wait()
        var state = try current(providerId)
        if providerId == .macNotificationCenter && state.status == .permissionMissing {
            // Simulates the person granting Full Disk Access in System Settings.
            state.status = .connected
            state.connectedAt = Self.timestamp(now())
            state.grantedScopeIds = Self.readScopeIds(providerId)
            if state.agentIds.isEmpty { state.agentIds = defaultAgentIds }
            return store(state)
        }
        return state
    }
}
