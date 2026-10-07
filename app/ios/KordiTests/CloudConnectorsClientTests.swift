import XCTest
@testable import Kordi

@MainActor
final class CloudConnectorsClientTests: XCTestCase {
    // Wire names from bridges/cloud-server/src/connectors/models.rs.
    static let listJSON = #"""
    {
      "connectors": [
        {
          "connectorId": "conn_cal",
          "provider": "google_calendar",
          "status": "connected",
          "readScopes": ["https://www.googleapis.com/auth/calendar.readonly"],
          "actScopes": ["https://www.googleapis.com/auth/calendar.events"],
          "actEnabled": true,
          "agentIds": ["cloud-agent:acct_1", "agent_research"],
          "createdAt": "2026-10-01T09:00:00+00:00",
          "updatedAt": "2026-10-02T09:00:00+00:00"
        },
        {
          "connectorId": "conn_gh",
          "provider": "github",
          "status": "needs_reauth",
          "readScopes": ["read:user", "notifications"],
          "actScopes": [],
          "actEnabled": false,
          "agentIds": [],
          "createdAt": "2026-09-01T09:00:00+00:00",
          "updatedAt": "2026-09-03T09:00:00+00:00"
        },
        {
          "connectorId": "conn_slack_old",
          "provider": "slack",
          "status": "revoked",
          "readScopes": ["channels:read"],
          "actScopes": [],
          "actEnabled": false,
          "agentIds": [],
          "createdAt": "2026-08-01T09:00:00+00:00",
          "updatedAt": "2026-08-02T09:00:00+00:00",
          "revokedAt": "2026-08-02T09:00:00+00:00"
        },
        {
          "connectorId": "conn_future",
          "provider": "some_future_provider",
          "status": "connected",
          "readScopes": ["x"],
          "actScopes": [],
          "actEnabled": false,
          "agentIds": [],
          "createdAt": "2026-08-01T09:00:00+00:00",
          "updatedAt": "2026-08-02T09:00:00+00:00"
        }
      ]
    }
    """#

    static let auditJSON = #"""
    {
      "entries": [
        {
          "auditId": "aud_2",
          "connectorId": "conn_cal",
          "runId": "run_1",
          "agentId": "agent_research",
          "tool": "calendar.list_events",
          "toolGroup": "read",
          "outcome": "completed",
          "summary": "Read events for today.",
          "createdAt": "2026-10-02T10:00:00+00:00"
        },
        {
          "auditId": "aud_1",
          "connectorId": "conn_cal",
          "agentId": "agent_gone",
          "tool": "calendar.create_event",
          "toolGroup": "act",
          "outcome": "failed",
          "summary": "Provider call failed.",
          "createdAt": "2026-10-02T09:30:00+00:00"
        },
        {
          "auditId": "aud_0",
          "connectorId": "conn_cal",
          "tool": "connector.act_on",
          "toolGroup": "act",
          "outcome": "completed",
          "summary": "Turned on acting through this connector.",
          "createdAt": "2026-10-02T09:00:00+00:00"
        }
      ],
      "nextBefore": "2026-10-02T09:00:00+00:00"
    }
    """#

    private let callbackURL = URL(string: "kordi-beta://oauth/callback")!

    private func agent(_ id: String, name: String, archivedAt: String? = nil) -> CloudAgent {
        CloudAgent(
            agentId: id,
            ownerAccountId: "acct_1",
            accessScope: "private",
            status: archivedAt == nil ? "active" : "archived",
            name: name,
            role: "Helper",
            description: nil,
            updatedAt: "2026-10-01T00:00:00Z",
            archivedAt: archivedAt,
            ownerDisplayName: nil,
            avatar: CanonicalAvatarDescriptor(
                entityType: "agent",
                entityId: id,
                source: "generated",
                style: CanonicalAvatarSystem.agentStyle,
                seed: id,
                rendererVersion: CanonicalAvatarSystem.rendererVersion,
                uploadedAsset: nil,
                version: 1,
                updatedAt: "2026-10-01T00:00:00Z"
            )
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testDecodesListResponseFromServerWireNames() throws {
        let response = try decode(CloudConnectorListResponse.self, Self.listJSON)
        XCTAssertEqual(response.connectors.count, 4)
        XCTAssertNil(response.agents)
        let calendar = try XCTUnwrap(response.connectors.first)
        XCTAssertEqual(calendar.connectorId, "conn_cal")
        XCTAssertEqual(calendar.provider, "google_calendar")
        XCTAssertEqual(calendar.status, "connected")
        XCTAssertEqual(calendar.actScopes, ["https://www.googleapis.com/auth/calendar.events"])
        XCTAssertTrue(calendar.actEnabled)
        XCTAssertEqual(calendar.agentIds, ["cloud-agent:acct_1", "agent_research"])
        XCTAssertEqual(calendar.createdAt, "2026-10-01T09:00:00+00:00")
        XCTAssertNil(calendar.lastEventAt)
        XCTAssertEqual(response.connectors[2].revokedAt, "2026-08-02T09:00:00+00:00")
    }

    func testMapsStatusAndScopes() throws {
        let summaries = try decode(CloudConnectorListResponse.self, Self.listJSON).connectors
        let states = Dictionary(uniqueKeysWithValues: CloudConnectorsMapping.states(from: summaries).map { ($0.providerId, $0) })
        XCTAssertEqual(states.count, connectorCatalog.count)

        let calendar = try XCTUnwrap(states[.googleCalendar])
        XCTAssertEqual(calendar.status, .connected)
        XCTAssertEqual(calendar.connectedAt, "2026-10-01T09:00:00+00:00")
        XCTAssertEqual(calendar.grantedScopeIds, [
            "google_calendar.events.read", "google_calendar.freebusy.read",
            "google_calendar.invitations.reply", "google_calendar.events.write",
        ])
        XCTAssertTrue(ConnectorsModel.hasGrantedActScopes(definition: ConnectorsModel.definition(.googleCalendar), state: calendar))
        XCTAssertTrue(calendar.actEnabled)

        let github = try XCTUnwrap(states[.github])
        XCTAssertEqual(github.status, .needsReauth)
        XCTAssertEqual(github.grantedScopeIds, ["github.notifications.read", "github.pulls.read"])
        XCTAssertFalse(ConnectorsModel.hasGrantedActScopes(definition: ConnectorsModel.definition(.github), state: github))

        XCTAssertEqual(states[.slack], .empty(.slack), "Revoked rows count as not connected.")
        XCTAssertEqual(states[.gmail], .empty(.gmail))
        XCTAssertEqual(states[.macCalendar], .empty(.macCalendar))
        XCTAssertEqual(states[.macContacts], .empty(.macContacts))

        XCTAssertEqual(CloudConnectorsMapping.status("connected"), .connected)
        XCTAssertEqual(CloudConnectorsMapping.status("needs_reauth"), .needsReauth)
        XCTAssertEqual(CloudConnectorsMapping.status("revoked"), .notConnected)
        XCTAssertEqual(CloudConnectorsMapping.status(nil), .notConnected)
    }

    func testMacLocalProvidersStayNotConnectedEvenIfServerListsThem() {
        let summary = CloudConnectorSummary(connectorId: "c", provider: "mac_calendar", status: "connected", readScopes: ["x"])
        XCTAssertEqual(CloudConnectorsMapping.states(from: [summary]).first { $0.providerId == .macCalendar }, .empty(.macCalendar))
    }

    func testNewestLiveRowWinsForAProvider() {
        let older = CloudConnectorSummary(connectorId: "old", provider: "gmail", status: "connected", readScopes: ["r"], updatedAt: "2026-10-01T00:00:00+00:00")
        let newer = CloudConnectorSummary(connectorId: "new", provider: "gmail", status: "needs_reauth", readScopes: ["r"], updatedAt: "2026-10-03T00:00:00+00:00")
        XCTAssertEqual(CloudConnectorsMapping.summary(for: .gmail, in: [older, newer])?.connectorId, "new")
    }

    func testAgentsListDefaultAgentFirstAndSkipArchived() {
        let agents = CloudConnectorsMapping.agents(accountId: "acct_1", owned: [
            agent("agent_research", name: "Research"),
            agent("agent_old", name: "Old", archivedAt: "2026-09-01T00:00:00Z"),
        ])
        XCTAssertEqual(agents.map(\.agentId), ["cloud-agent:acct_1", "agent_research"])
        XCTAssertTrue(agents[0].isDefault)
        XCTAssertEqual(agents[1].name, "Research")
    }

    func testMapsAuditEntriesWithAgentNames() throws {
        let page = try decode(CloudConnectorAuditPage.self, Self.auditJSON)
        XCTAssertEqual(page.nextBefore, "2026-10-02T09:00:00+00:00")
        let agents = [
            ConnectorAgent(agentId: "cloud-agent:acct_1", name: "My Kordi", isDefault: true),
            ConnectorAgent(agentId: "agent_research", name: "Research", isDefault: false),
        ]
        let entries = CloudConnectorsMapping.auditEntries(page.entries, providerId: .googleCalendar, agents: agents)
        XCTAssertEqual(entries.map(\.id), ["aud_2", "aud_1", "aud_0"])
        XCTAssertEqual(entries[0].agentName, "Research")
        XCTAssertEqual(entries[0].group, .read)
        XCTAssertEqual(entries[0].outcome, .completed)
        XCTAssertEqual(entries[1].agentName, "agent_gone", "Unknown agents fall back to their id.")
        XCTAssertEqual(entries[1].group, .act)
        XCTAssertEqual(entries[1].outcome, .failed)
        XCTAssertEqual(entries[2].agentName, "You")
        XCTAssertEqual(CloudConnectorsMapping.auditOutcome("blocked_background"), .blockedBackground)
    }

    func testParsesSuccessFragment() throws {
        let payload = #"{"connectorId":"conn_cal","provider":"google_calendar","grant":"read","status":"connected"}"#
        let encoded = Data(payload.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let url = URL(string: "kordi-beta://oauth/callback#kordi_connector=\(encoded)")!
        let result = try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL)
        XCTAssertEqual(result, CloudConnectorGrantResult(connectorId: "conn_cal", provider: "google_calendar", grant: "read", status: "connected"))
    }

    func testParsesBareConnectorIdFragment() throws {
        let url = URL(string: "kordi-beta://oauth/callback#kordi_connector=conn_cal")!
        XCTAssertEqual(try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL).connectorId, "conn_cal")
    }

    func testParsesErrorFragment() {
        let url = URL(string: "kordi-beta://oauth/callback#kordi_connector_error=Google%20declined%20the%20request.&kordi_connector_error_code=provider_denied")!
        XCTAssertThrowsError(try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL)) { error in
            XCTAssertEqual((error as? ConnectorsClientError)?.message, "Google declined the request.")
        }
    }

    func testRejectsForeignOrEmptyCallbacks() {
        for raw in [
            "kordi://oauth/callback#kordi_connector=conn_cal",
            "kordi-beta://other/callback#kordi_connector=conn_cal",
            "kordi-beta://oauth/callback",
            "kordi-beta://oauth/callback#something=else",
        ] {
            XCTAssertThrowsError(try CloudConnectorsMapping.parseCallback(URL(string: raw)!, expectedCallbackURL: callbackURL), raw)
        }
    }

    func testDecodesCapabilitiesWithAndWithoutConnectorsVersion() throws {
        let current = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":["google","github"],"connectorsVersion":1}"#)
        XCTAssertEqual(current.connectorsVersion, 1)
        XCTAssertEqual(current.oauthProviders, ["google", "github"])
        XCTAssertEqual(current.password, true)

        let older = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":["google"]}"#)
        XCTAssertNil(older.connectorsVersion)
        XCTAssertFalse(ConnectorsAvailability.isAvailable(arguments: [], connectorsVersion: older.connectorsVersion))
        XCTAssertTrue(ConnectorsAvailability.isAvailable(arguments: [], connectorsVersion: current.connectorsVersion))

        let odd = try decode(CloudAuthCapabilities.self, #"{"connectorsVersion":"one"}"#)
        XCTAssertNil(odd.connectorsVersion)
        XCTAssertEqual(odd.oauthProviders, [])
    }

    func testMakeClientUsesCloudClientOnlyWithVersion() {
        let cloud = PreviewConnectorsClient(latency: 0)
        XCTAssertNil(ConnectorsAvailability.makeClient(arguments: [], connectorsVersion: nil, cloudClient: { cloud }))
        XCTAssertTrue(ConnectorsAvailability.makeClient(arguments: [], connectorsVersion: 1, cloudClient: { cloud }) === cloud)
    }

    func testNoDecodedModelCarriesCredentialFields() throws {
        let fragment = #"{"connectorId":"c","provider":"github","grant":"act","status":"connected"}"#
        let values: [Any] = [
            try decode(CloudConnectorListResponse.self, Self.listJSON),
            try decode(CloudConnectorListResponse.self, #"{"connectors":[],"agents":[{"agentId":"a","name":"A","isDefault":true}]}"#),
            try decode(CloudConnectorAuditPage.self, Self.auditJSON),
            try decode(CloudConnectorResponse.self, #"{"connector":{"connectorId":"c","provider":"github","status":"connected"}}"#),
            try decode(CloudConnectorDisconnectResponse.self, #"{"deletedEvents":3}"#),
            try decode(CloudAuthCapabilities.self, #"{"oauthProviders":[],"connectorsVersion":1}"#),
            try decode(CloudConnectorGrantResult.self, fragment),
        ]
        let pattern = try NSRegularExpression(pattern: "token|secret", options: [.caseInsensitive])
        func scan(_ value: Any, path: String) {
            for child in Mirror(reflecting: value).children {
                let label = child.label ?? ""
                let range = NSRange(label.startIndex..., in: label)
                XCTAssertNil(pattern.firstMatch(in: label, range: range), "\(path).\(label) looks like a credential field.")
                scan(child.value, path: "\(path).\(label)")
            }
        }
        for value in values { scan(value, path: String(describing: type(of: value))) }
    }

    func testListThroughServerClient() async throws {
        ConnectorsURLProtocol.responses = [
            "/v1/cloud/connectors": Self.listJSON,
            "/v1/cloud/agents": #"{"agents":[]}"#,
        ]
        ConnectorsURLProtocol.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectorsURLProtocol.self]
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: URLSession(configuration: configuration))
        let client = CloudConnectorsClient(
            api: api,
            token: { "session-value" },
            accountId: { "acct_1" },
            callbackURL: callbackURL,
            authenticate: { _ in throw CloudOAuthSessionError.cancelled }
        )
        let result = try await client.list()
        XCTAssertEqual(result.states.first { $0.providerId == .googleCalendar }?.status, .connected)
        XCTAssertEqual(result.agents.map(\.agentId), ["cloud-agent:acct_1"])
        XCTAssertTrue(ConnectorsURLProtocol.requests.contains { $0.value(forHTTPHeaderField: "Authorization") == "Bearer session-value" })

        do {
            _ = try await client.connect(.macCalendar, scopeIds: [])
            XCTFail("Device-local sources cannot connect through the server.")
        } catch {
            XCTAssertTrue(error is ConnectorsClientError)
        }
    }
}

private final class ConnectorsURLProtocol: URLProtocol {
    static var responses: [String: String] = [:]
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        let body = Self.responses[request.url?.path ?? ""]
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: body == nil ? 404 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? #"{"errorCode":"not_found","message":"Not found."}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
