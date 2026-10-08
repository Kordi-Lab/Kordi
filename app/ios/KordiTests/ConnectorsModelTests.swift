import XCTest
@testable import Kordi

@MainActor
final class ConnectorsModelTests: XCTestCase {
    private func state(
        _ providerId: ConnectorProviderId = .googleCalendar,
        status: ConnectorStatus = .connected,
        actEnabled: Bool = false,
        grantedScopeIds: [String] = [],
        agentIds: [String] = []
    ) -> ConnectorState {
        ConnectorState(
            providerId: providerId,
            status: status,
            connectedAt: "2026-10-01T00:00:00.000Z",
            grantedScopeIds: grantedScopeIds,
            actEnabled: actEnabled,
            agentIds: agentIds,
            lastEventAt: nil
        )
    }

    private let agents = [
        ConnectorAgent(agentId: "a", name: "My Kordi", isDefault: true),
        ConnectorAgent(agentId: "b", name: "Research", isDefault: false),
        ConnectorAgent(agentId: "c", name: "Ops", isDefault: false),
    ]

    func testCatalogIdsMatchDesktop() {
        XCTAssertEqual(connectorCatalog.map(\.providerId.rawValue), [
            "google_calendar",
            "gmail",
            "github",
            "slack",
            "outlook",
            "mac_calendar",
            "mac_contacts",
            "mac_notification_center",
        ])
        XCTAssertEqual(ConnectorProviderId.allCases.count, connectorCatalog.count)
    }

    func testIPhoneCatalogDropsNotificationCenter() {
        let ids = ConnectorsModel.iPhoneCatalog.map(\.providerId)
        XCTAssertFalse(ids.contains(.macNotificationCenter))
        XCTAssertEqual(ids.filter { ConnectorsModel.definition($0).kind == .macLocal }, [.macCalendar, .macContacts])
        XCTAssertFalse(ConnectorsModel.iPhoneCatalog.contains { $0.summary.contains("Mac") })
    }

    func testBackgroundRunsOnlyRead() {
        let connected = state(actEnabled: true)
        XCTAssertEqual(ConnectorsModel.toolGroupsForRun(state: connected, startedByPerson: true), [.read, .act])
        XCTAssertEqual(ConnectorsModel.toolGroupsForRun(state: connected, startedByPerson: false), [.read])
    }

    func testDisabledActOnlyReads() {
        XCTAssertEqual(ConnectorsModel.toolGroupsForRun(state: state(actEnabled: false), startedByPerson: true), [.read])
        XCTAssertEqual(ConnectorsModel.toolGroupsForRun(state: state(status: .needsReauth, actEnabled: true), startedByPerson: true), [])
    }

    func testDisconnectConsequences() {
        let lines = ConnectorsModel.disconnectConsequences(ConnectorsModel.definition(.github))
        XCTAssertEqual(lines.count, 3)
        let text = lines.joined(separator: " ")
        XCTAssertTrue(text.contains("token"))
        XCTAssertTrue(text.contains("events"))
        XCTAssertTrue(text.contains("Copies"))
        XCTAssertTrue(text.contains("Memory"))
        XCTAssertEqual(lines[0], "Kordi removes the sign-in token for GitHub.")
    }

    func testListValues() {
        let calendar = ConnectorsModel.definition(.googleCalendar)
        XCTAssertEqual(ConnectorsModel.listValue(definition: calendar, state: nil), "Not connected")
        XCTAssertEqual(ConnectorsModel.listValue(definition: calendar, state: state(actEnabled: false)), "Connected · Read only")
        XCTAssertEqual(ConnectorsModel.listValue(definition: calendar, state: state(actEnabled: true)), "Connected · Can act")
        XCTAssertEqual(ConnectorsModel.listValue(definition: calendar, state: state(status: .needsReauth)), "Sign in again")
        XCTAssertEqual(ConnectorsModel.listValue(definition: ConnectorsModel.definition(.outlook), state: nil), "Coming later")
        XCTAssertEqual(
            ConnectorsModel.listValue(definition: ConnectorsModel.definition(.macNotificationCenter), state: state(.macNotificationCenter, status: .permissionMissing)),
            "Needs Full Disk Access"
        )
        XCTAssertEqual(
            ConnectorsModel.listValue(definition: ConnectorsModel.definition(.macContacts), state: state(.macContacts, status: .permissionMissing)),
            "Needs permission"
        )
    }

    func testStatusLabels() {
        let calendar = ConnectorsModel.definition(.googleCalendar)
        XCTAssertEqual(ConnectorsModel.statusLabel(definition: calendar, state: nil, agents: agents), "Not connected")
        XCTAssertEqual(ConnectorsModel.statusLabel(definition: ConnectorsModel.definition(.outlook), state: nil, agents: agents), "Not yet available")
        XCTAssertEqual(
            ConnectorsModel.statusLabel(definition: calendar, state: state(actEnabled: true, agentIds: ["a", "b", "c"]), agents: agents),
            "Connected · Can act · All agents"
        )
        XCTAssertEqual(
            ConnectorsModel.statusLabel(definition: calendar, state: state(agentIds: ["a"]), agents: agents),
            "Connected · Read only · 1 agent"
        )
        XCTAssertEqual(
            ConnectorsModel.statusLabel(definition: calendar, state: state(agentIds: ["a", "b"]), agents: agents),
            "Connected · Read only · 2 agents"
        )
        XCTAssertEqual(
            ConnectorsModel.statusLabel(definition: calendar, state: state(agentIds: []), agents: agents),
            "Connected · Read only · No agents"
        )
    }

    func testPreviewClientConnectGrantDisconnect() async throws {
        let client = PreviewConnectorsClient(latency: 0)
        let gmail = ConnectorsModel.definition(.gmail)

        let connected = try await client.connect(.gmail, scopeIds: gmail.readScopes.map(\.id))
        XCTAssertEqual(connected.status, .connected)
        XCTAssertEqual(connected.grantedScopeIds, gmail.readScopes.map(\.id))
        XCTAssertFalse(connected.actEnabled)
        XCTAssertEqual(connected.agentIds, ["agent-default"])

        do {
            _ = try await client.setActEnabled(.gmail, enabled: true)
            XCTFail("Service connectors need the act grant first")
        } catch let error as ConnectorsClientError {
            XCTAssertEqual(error.message, "Grant act access to Gmail first.")
        }

        let granted = try await client.grantAct(.gmail)
        XCTAssertTrue(granted.actEnabled)
        XCTAssertTrue(ConnectorsModel.hasGrantedActScopes(definition: gmail, state: granted))

        try await client.disconnect(.gmail)
        let list = try await client.list()
        XCTAssertEqual(list.states.first { $0.providerId == .gmail }, .empty(.gmail))
    }

    func testPreviewClientDisconnectDropsAuditAndSortsNewestFirst() async throws {
        let client = PreviewConnectorsClient(latency: 0)
        let entries = try await client.auditLog(.googleCalendar)
        XCTAssertEqual(entries.map(\.id), ["audit-1", "audit-2", "audit-3", "audit-4"])
        try await client.disconnect(.googleCalendar)
        let afterDisconnect = try await client.auditLog(.googleCalendar)
        XCTAssertTrue(afterDisconnect.isEmpty)
    }

    func testLocalConnectorActTurnsOnDirectly() async throws {
        let client = PreviewConnectorsClient(latency: 0)
        let state = try await client.setActEnabled(.macCalendar, enabled: true)
        XCTAssertTrue(state.actEnabled)
        XCTAssertTrue(state.grantedScopeIds.contains("mac_calendar.reminders.write"))
    }

    func testEncodedStateAndAuditCarryNoSecretKeys() async throws {
        let client = PreviewConnectorsClient(latency: 0)
        let list = try await client.list()
        var audit: [ConnectorAuditEntry] = []
        for providerId in ConnectorProviderId.allCases {
            audit += try await client.auditLog(providerId)
        }
        XCTAssertFalse(audit.isEmpty)
        let encoder = JSONEncoder()
        let payloads = try list.states.map { try encoder.encode($0) } + audit.map { try encoder.encode($0) }
        for payload in payloads {
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
            for key in object.keys {
                XCTAssertNil(key.range(of: "token|secret", options: [.regularExpression, .caseInsensitive]), "Unexpected key \(key)")
            }
        }
    }
}
