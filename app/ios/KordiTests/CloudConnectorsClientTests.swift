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
          "updatedAt": "2026-10-02T09:00:00+00:00",
          "grantedScopeIds": [
            "google_calendar.events.read", "google_calendar.freebusy.read",
            "google_calendar.invitations.reply", "google_calendar.events.write"
          ],
          "settings": {},
          "lastEventAt": "2026-10-02T10:00:00+00:00"
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
          "updatedAt": "2026-09-03T09:00:00+00:00",
          "grantedScopeIds": ["github.notifications.read"],
          "settings": {},
          "lastEventAt": null
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
          "revokedAt": "2026-08-02T09:00:00+00:00",
          "grantedScopeIds": ["slack.channels.read"],
          "settings": {"channels": []},
          "lastEventAt": null
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
          "updatedAt": "2026-08-02T09:00:00+00:00",
          "grantedScopeIds": [],
          "settings": {},
          "lastEventAt": null
        }
      ],
      "agents": [
        {"agentId": "cloud-agent:acct_1", "name": "My Kordi", "isDefault": true},
        {"agentId": "agent_research", "name": "Research", "isDefault": false}
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
        XCTAssertEqual(response.agents?.map(\.agentId), ["cloud-agent:acct_1", "agent_research"])
        XCTAssertEqual(response.agents?.first?.isDefault, true)
        let calendar = try XCTUnwrap(response.connectors.first)
        XCTAssertEqual(calendar.connectorId, "conn_cal")
        XCTAssertEqual(calendar.provider, "google_calendar")
        XCTAssertEqual(calendar.status, "connected")
        XCTAssertEqual(calendar.actScopes, ["https://www.googleapis.com/auth/calendar.events"])
        XCTAssertTrue(calendar.actEnabled)
        XCTAssertEqual(calendar.agentIds, ["cloud-agent:acct_1", "agent_research"])
        XCTAssertEqual(calendar.createdAt, "2026-10-01T09:00:00+00:00")
        XCTAssertEqual(calendar.lastEventAt, "2026-10-02T10:00:00+00:00")
        XCTAssertEqual(calendar.grantedScopeIds?.count, 4)
        XCTAssertNil(response.connectors[1].lastEventAt)
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
        XCTAssertEqual(calendar.lastEventAt, "2026-10-02T10:00:00+00:00")

        let github = try XCTUnwrap(states[.github])
        XCTAssertEqual(github.status, .needsReauth)
        XCTAssertEqual(github.grantedScopeIds, ["github.notifications.read"], "The server's catalog scope ids win over the native mapping.")
        XCTAssertNil(github.lastEventAt)
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

    func testFallsBackToNativeScopesWithoutGrantedScopeIds() {
        let summary = CloudConnectorSummary(connectorId: "c", provider: "github", status: "connected", readScopes: ["read:user", "notifications"])
        XCTAssertNil(summary.grantedScopeIds)
        let state = CloudConnectorsMapping.state(.github, summary: summary)
        XCTAssertEqual(state.grantedScopeIds, ["github.notifications.read", "github.pulls.read"])
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

    private static func fragmentURL(_ payload: String) -> URL {
        let encoded = Data(payload.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "kordi-beta://oauth/callback#kordi_connector=\(encoded)")!
    }

    func testParsesPendingCompletionFragment() throws {
        let url = Self.fragmentURL(#"{"completionCode":"cc_1","provider":"google_calendar","grant":"read","status":"pending"}"#)
        let result = try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL)
        XCTAssertEqual(result, CloudConnectorGrantResult(completionCode: "cc_1", provider: "google_calendar", grant: "read", status: "pending"))
    }

    func testParsesOlderConnectorIdFragment() throws {
        let url = Self.fragmentURL(#"{"connectorId":"conn_cal","provider":"google_calendar","grant":"read","status":"connected"}"#)
        let result = try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL)
        XCTAssertEqual(result, CloudConnectorGrantResult(connectorId: "conn_cal", provider: "google_calendar", grant: "read", status: "connected"))
    }

    func testRejectsBareConnectorIdFragment() {
        let url = URL(string: "kordi-beta://oauth/callback#kordi_connector=conn_cal")!
        XCTAssertThrowsError(try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL)) { error in
            XCTAssertEqual((error as? ConnectorsClientError)?.message, CloudConnectorsMapping.invalidCallbackMessage)
        }
    }

    func testParsesErrorFragment() {
        let url = URL(string: "kordi-beta://oauth/callback#kordi_connector_error=Google%20declined%20the%20request.&kordi_connector_error_code=provider_denied")!
        XCTAssertThrowsError(try CloudConnectorsMapping.parseCallback(url, expectedCallbackURL: callbackURL)) { error in
            XCTAssertEqual(error as? ConnectorsClientError, ConnectorsClientError(message: "Google declined the request.", code: "provider_denied"))
        }
        let codeOnly = URL(string: "kordi-beta://oauth/callback#kordi_connector_error_code=state_expired")!
        XCTAssertThrowsError(try CloudConnectorsMapping.parseCallback(codeOnly, expectedCallbackURL: callbackURL)) { error in
            XCTAssertEqual((error as? ConnectorsClientError)?.code, "state_expired")
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
        let fragment = #"{"completionCode":"cc","provider":"github","grant":"act","status":"pending"}"#
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

    // MARK: - Round trips through the server client

    private static let baseURL = URL(string: "http://127.0.0.1:17081")!

    private static func summaryJSON(
        id: String = "conn_cal",
        provider: String = "google_calendar",
        status: String = "connected",
        grantedScopeIds: [String] = ["google_calendar.events.read", "google_calendar.freebusy.read"],
        agentIds: [String] = []
    ) -> String {
        let scopes = grantedScopeIds.map { "\"\($0)\"" }.joined(separator: ",")
        let agents = agentIds.map { "\"\($0)\"" }.joined(separator: ",")
        return #"{"connectorId":"\#(id)","provider":"\#(provider)","status":"\#(status)","readScopes":["r"],"actScopes":[],"actEnabled":false,"agentIds":[\#(agents)],"createdAt":"2026-10-01T09:00:00+00:00","updatedAt":"2026-10-02T09:00:00+00:00","grantedScopeIds":[\#(scopes)],"settings":{},"lastEventAt":null}"#
    }

    private static func listBody(_ summaries: [String], agents: String? = #"[{"agentId":"cloud-agent:acct_1","name":"My Kordi","isDefault":true},{"agentId":"agent_research","name":"Research","isDefault":false}]"#) -> String {
        let agentsField = agents.map { #","agents":\#($0)"# } ?? ""
        return #"{"connectors":[\#(summaries.joined(separator: ","))]\#(agentsField)}"#
    }

    private func makeClient(
        authenticate: @escaping CloudConnectorsClient.WebAuthenticator = { _ in throw CloudOAuthSessionError.cancelled }
    ) -> CloudConnectorsClient {
        ConnectorsURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectorsURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        return CloudConnectorsClient(
            api: api,
            token: { "session-value" },
            accountId: { "acct_1" },
            callbackURL: callbackURL,
            authenticate: authenticate
        )
    }

    func testListThroughServerClient() async throws {
        let client = makeClient()
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listJSON)
        let result = try await client.list()
        XCTAssertEqual(result.states.first { $0.providerId == .googleCalendar }?.status, .connected)
        XCTAssertEqual(result.agents.map(\.agentId), ["cloud-agent:acct_1", "agent_research"])
        XCTAssertTrue(ConnectorsURLProtocol.requests.contains { $0.request.value(forHTTPHeaderField: "Authorization") == "Bearer session-value" })
        XCTAssertFalse(ConnectorsURLProtocol.paths.contains("GET /v1/cloud/agents"), "Agents come from the list response.")

        do {
            _ = try await client.connect(.macCalendar, scopeIds: [])
            XCTFail("Device-local sources cannot connect through the server.")
        } catch {
            XCTAssertTrue(error is ConnectorsClientError)
        }
    }

    func testListFetchesAgentsWhenServerOmitsThem() async throws {
        let client = makeClient()
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([Self.summaryJSON()], agents: nil))
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/agents", #"{"agents":[]}"#)
        let result = try await client.list()
        XCTAssertEqual(result.agents.map(\.agentId), ["cloud-agent:acct_1"])
        XCTAssertTrue(ConnectorsURLProtocol.paths.contains("GET /v1/cloud/agents"))
    }

    func testConnectRedeemsCompletionCodeBeforeListing() async throws {
        let client = makeClient { _ in
            Self.fragmentURL(#"{"completionCode":"cc_123","provider":"google_calendar","grant":"read","status":"pending"}"#)
        }
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/google_calendar/oauth/start", #"{"authUrl":"https://accounts.example.com/o/oauth2"}"#)
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/oauth/complete", #"{"connector":\#(Self.summaryJSON())}"#)
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([Self.summaryJSON()]))

        let state = try await client.connect(.googleCalendar, scopeIds: [])
        XCTAssertEqual(state.status, .connected)
        XCTAssertEqual(state.grantedScopeIds, ["google_calendar.events.read", "google_calendar.freebusy.read"])
        XCTAssertEqual(ConnectorsURLProtocol.paths, [
            "POST /v1/cloud/connectors/google_calendar/oauth/start",
            "POST /v1/cloud/connectors/oauth/complete",
            "GET /v1/cloud/connectors",
        ])
        let complete = try XCTUnwrap(ConnectorsURLProtocol.requests.first { $0.request.url?.path == "/v1/cloud/connectors/oauth/complete" })
        XCTAssertEqual(complete.request.value(forHTTPHeaderField: "Authorization"), "Bearer session-value")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: complete.body ?? Data()) as? [String: String])
        XCTAssertEqual(body, ["completionCode": "cc_123"])
    }

    func testConnectWithOlderFragmentSkipsCompletion() async throws {
        let client = makeClient { _ in
            Self.fragmentURL(#"{"connectorId":"conn_cal","provider":"google_calendar","grant":"read","status":"connected"}"#)
        }
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/google_calendar/oauth/start", #"{"authUrl":"https://accounts.example.com/o/oauth2"}"#)
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([Self.summaryJSON()]))
        let state = try await client.connect(.googleCalendar, scopeIds: [])
        XCTAssertEqual(state.status, .connected)
        XCTAssertFalse(ConnectorsURLProtocol.paths.contains("POST /v1/cloud/connectors/oauth/complete"))
    }

    func testConnectRequiresConnectedStatus() async throws {
        let client = makeClient { _ in
            Self.fragmentURL(#"{"connectorId":"conn_cal","provider":"google_calendar","grant":"read","status":"connected"}"#)
        }
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/google_calendar/oauth/start", #"{"authUrl":"https://accounts.example.com/o/oauth2"}"#)
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([Self.summaryJSON(status: "needs_reauth")]))
        do {
            _ = try await client.connect(.googleCalendar, scopeIds: [])
            XCTFail("A read grant that is not connected must not succeed.")
        } catch {
            XCTAssertEqual((error as? ConnectorsClientError)?.message, "Kordi could not confirm the connection to Google Calendar. Try again.")
        }
    }

    func testGrantActFailsWhenActScopesAreMissing() async throws {
        let client = makeClient { _ in
            Self.fragmentURL(#"{"completionCode":"cc_act","provider":"google_calendar","grant":"act","status":"pending"}"#)
        }
        // Only one of the two act scopes came back.
        let partial = Self.summaryJSON(grantedScopeIds: [
            "google_calendar.events.read", "google_calendar.freebusy.read", "google_calendar.invitations.reply",
        ])
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/google_calendar/oauth/start", #"{"authUrl":"https://accounts.example.com/o/oauth2"}"#)
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/oauth/complete", #"{"connector":\#(partial)}"#)
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([partial]))
        do {
            _ = try await client.grantAct(.googleCalendar)
            XCTFail("A partial act grant must not count as granted.")
        } catch {
            XCTAssertEqual((error as? ConnectorsClientError)?.message, "Google Calendar did not grant act access.")
        }

        let full = Self.summaryJSON(grantedScopeIds: ConnectorsModel.definition(.googleCalendar).readScopes.map(\.id)
            + ConnectorsModel.definition(.googleCalendar).actScopes.map(\.id))
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/oauth/complete", #"{"connector":\#(full)}"#)
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([full]))
        let state = try await client.grantAct(.googleCalendar)
        XCTAssertTrue(ConnectorsModel.hasGrantedActScopes(definition: ConnectorsModel.definition(.googleCalendar), state: state))
    }

    func testAgentGrantDropsAgentsMissingFromTheList() async throws {
        let client = makeClient()
        let summary = Self.summaryJSON(agentIds: ["cloud-agent:acct_1", "agent_archived"])
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([summary]))
        ConnectorsURLProtocol.stub(
            "PUT",
            "/v1/cloud/connectors/conn_cal/agents",
            #"{"connector":\#(Self.summaryJSON(agentIds: ["cloud-agent:acct_1", "agent_research"]))}"#
        )
        _ = try await client.list()
        let state = try await client.setAgentGrant(.googleCalendar, agentId: "agent_research", granted: true)
        XCTAssertEqual(state.agentIds, ["cloud-agent:acct_1", "agent_research"])
        let put = try XCTUnwrap(ConnectorsURLProtocol.requests.first { $0.request.httpMethod == "PUT" })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: put.body ?? Data()) as? [String: [String]])
        XCTAssertEqual(body["agentIds"], ["cloud-agent:acct_1", "agent_research"], "The archived agent is not sent back.")
    }

    func testConnectorNotFoundClearsCacheAndRelists() async throws {
        let client = makeClient()
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([Self.summaryJSON()]))
        let notFound = #"{"errorCode":"connector_not_found","message":"Connector not found."}"#
        ConnectorsURLProtocol.stub("POST", "/v1/cloud/connectors/conn_cal/act", notFound, status: 404)
        ConnectorsURLProtocol.stub("PUT", "/v1/cloud/connectors/conn_cal/agents", notFound, status: 404)
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors/conn_cal/audit", notFound, status: 404)
        ConnectorsURLProtocol.stub("DELETE", "/v1/cloud/connectors/conn_cal", notFound, status: 404)
        _ = try await client.list()

        let expected = ConnectorsClientError(message: "Google Calendar is no longer connected.", code: "connector_not_found")
        let calls: [(String, @MainActor () async throws -> Void)] = [
            ("act", { _ = try await client.setActEnabled(.googleCalendar, enabled: true) }),
            ("agents", { _ = try await client.setAgentGrant(.googleCalendar, agentId: "agent_research", granted: true) }),
            ("audit", { _ = try await client.auditLog(.googleCalendar) }),
            ("delete", { try await client.disconnect(.googleCalendar) }),
        ]
        for (name, call) in calls {
            let listsBefore = ConnectorsURLProtocol.paths.filter { $0 == "GET /v1/cloud/connectors" }.count
            do {
                try await call()
                XCTFail("\(name) should fail when the connector is gone.")
            } catch {
                XCTAssertEqual(error as? ConnectorsClientError, expected, name)
            }
            let listsAfter = ConnectorsURLProtocol.paths.filter { $0 == "GET /v1/cloud/connectors" }.count
            XCTAssertEqual(listsAfter, listsBefore + 1, "\(name) re-lists after connector_not_found.")
        }

        // Once the server stops listing it, the provider reads as not connected.
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([]))
        let relisted = try await client.list()
        XCTAssertEqual(relisted.states.first { $0.providerId == .googleCalendar }, .empty(.googleCalendar))
        do {
            _ = try await client.setActEnabled(.googleCalendar, enabled: true)
            XCTFail("A vanished connector should ask to connect first.")
        } catch {
            XCTAssertEqual((error as? ConnectorsClientError)?.message, "Connect Google Calendar first.")
        }
    }

    func testDisconnectDeletesAndForgetsTheConnector() async throws {
        let client = makeClient()
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([Self.summaryJSON()]))
        ConnectorsURLProtocol.stub("DELETE", "/v1/cloud/connectors/conn_cal", #"{"deletedEvents":2}"#)
        _ = try await client.list()
        try await client.disconnect(.googleCalendar)
        XCTAssertTrue(ConnectorsURLProtocol.paths.contains("DELETE /v1/cloud/connectors/conn_cal"))

        // The cached row is gone, so the next call re-lists instead of reusing it.
        ConnectorsURLProtocol.stub("GET", "/v1/cloud/connectors", Self.listBody([]))
        let listsBefore = ConnectorsURLProtocol.paths.filter { $0 == "GET /v1/cloud/connectors" }.count
        let entries = try await client.auditLog(.googleCalendar)
        XCTAssertEqual(entries, [])
        XCTAssertEqual(ConnectorsURLProtocol.paths.filter { $0 == "GET /v1/cloud/connectors" }.count, listsBefore + 1)
    }
}

private final class ConnectorsURLProtocol: URLProtocol {
    struct Recorded {
        let request: URLRequest
        let body: Data?
    }

    private static var responses: [String: (status: Int, body: String)] = [:]
    private(set) static var requests: [Recorded] = []

    static var paths: [String] {
        requests.map { "\($0.request.httpMethod ?? "GET") \($0.request.url?.path ?? "")" }
    }

    static func reset() {
        responses = [:]
        requests = []
    }

    static func stub(_ method: String, _ path: String, _ body: String, status: Int = 200) {
        responses["\(method) \(path)"] = (status, body)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(Recorded(request: request, body: request.httpBody ?? Self.read(request.httpBodyStream)))
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let stubbed = Self.responses[key] ?? (404, #"{"errorCode":"not_found","message":"Not found."}"#)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stubbed.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(stubbed.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
