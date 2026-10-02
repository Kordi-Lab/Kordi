import XCTest
@testable import Kordi

final class AgentActionEventDecodingTests: XCTestCase {
    private static let actionPayload = #"""
    {"agentAction":{"actionId":"7b6f0e0a-0000-4000-8000-000000000001","kind":"plan_rsvp",
      "sessionId":"session:group:g1","conversationId":"8b2a4d0e-0000-4000-8000-000000000001",
      "status":"pending","createdAt":"2026-10-01T00:00:00Z","expiresAt":"2026-10-02T00:00:00Z",
      "proposedBy":{"accountId":"acct_kordi_pip","displayName":"PiP","kind":"pip"},
      "subject":{"eventId":"evt_1","title":"Lunch","rsvp":"yes"}}}
    """#

    private static func event(critical: Bool, conversationId: String = "8b2a4d0e-0000-4000-8000-000000000001") -> String {
        #"""
        {"stream_seq":44,"event_id":"evt_agent_action","protocol_version":2,"type":"agent_action.updated",
         "critical":\#(critical),"conversation_id":"\#(conversationId)","entity_id":null,"entity_version":null,
         "occurred_at":"2026-10-01T00:00:00Z","payload":\#(actionPayload)}
        """#
    }

    func testAgentActionEventDecodesWithoutThrowing() throws {
        for critical in [false, true] {
            let event = try JSONDecoder().decode(CloudChatEvent.self, from: Data(Self.event(critical: critical).utf8))
            XCTAssertEqual(event.eventType, "agent_action.updated")
            XCTAssertEqual(event.critical, critical)
            XCTAssertNil(event.payload.conversation)
            XCTAssertNil(event.payload.message)
        }
    }

    private static let conversationUpdated = #"""
    {"stream_seq":43,"event_id":"evt_conversation","protocol_version":2,"type":"conversation.updated","critical":true,
     "conversation_id":"8b2a4d0e-0000-4000-8000-000000000001","entity_id":null,"entity_version":null,
     "occurred_at":"2026-10-01T00:00:00Z","payload":{"conversation":{
       "id":"8b2a4d0e-0000-4000-8000-000000000001","kind":"group","shared_title":"Team","version":3,
       "created_by_account_id":"acct_owner","legacy_session_id":"session:group:g1",
       "latest_message_sequence":12,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z",
       "members":[],"preferences":{"conversation_id":"8b2a4d0e-0000-4000-8000-000000000001","account_id":"acct_owner","version":1},
       "ai_access":{"history_scope":"mentions"}}}}
    """#

    func testSyncTurnsAgentActionUpdatesIntoARefreshSignal() async throws {
        AgentActionSyncURLProtocol.body = #"""
        {"protocol_version":2,"events":[\#(Self.conversationUpdated),\#(Self.event(critical: false)),
          \#(Self.event(critical: true, conversationId: "unknown-conversation"))],
         "next_cursor":"45","last_stream_seq":45,"has_more":false,"server_time":"2026-10-01T00:00:00Z"}
        """#
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentActionSyncURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        let response = try await client.sync(token: "synthetic", cursor: "43")

        XCTAssertEqual(response.cursor, "45")
        let signals = response.events.filter { $0.eventType == CloudAPIClient.agentActionUpdatedEventType }
        XCTAssertEqual(signals.count, 2)
        // A known conversation refreshes its own session; an unknown one refreshes everything.
        XCTAssertEqual(signals.map { $0.payload?.sessionId }, ["session:group:g1", nil])
        XCTAssertTrue(signals.allSatisfy { $0.payload?.message == nil })
    }

    func testActionListKeepsOnlyPendingActionsOfKnownKinds() throws {
        let list = try JSONDecoder().decode(CloudPendingAgentActionList.self, from: Data(#"""
        {"actions":[
          {"actionId":"a1","kind":"calendar_disclosure","sessionId":"session:group:g1","status":"pending",
           "proposedBy":{"accountId":"acct_owner","displayName":"Scout","kind":"agent"},
           "subject":{"agentName":"Scout","startAt":"2026-10-03","endAt":null,"conversationTitle":"Team"}},
          {"actionId":"a2","kind":"plan_teleport","sessionId":"session:group:g1","status":"pending"},
          {"actionId":"","kind":"plan_vote","status":"pending"},
          {"actionId":"a3","kind":"plan_vote","status":"applied"},
          "not an object",
          {"actionId":"a4","kind":"plan_confirm","sessionId":"session:group:g1",
           "subject":{"title":"Dinner","revision":"three","location":42}}
        ]}
        """#.utf8))
        XCTAssertEqual(list.actions.map(\.actionId), ["a1", "a4"])
        let calendar = list.actions[0]
        XCTAssertEqual(calendar.kind, .calendarDisclosure)
        XCTAssertEqual(calendar.subject.agentName, "Scout")
        XCTAssertEqual(calendar.subject.startAt, "2026-10-03")
        XCTAssertNil(calendar.subject.endAt)
        XCTAssertFalse(calendar.proposedBy.isPip)
        let confirm = list.actions[1]
        XCTAssertEqual(confirm.status, "pending")
        XCTAssertNil(confirm.subject.revision)
        XCTAssertNil(confirm.subject.location)
    }

    func testMissingOrMalformedActionListsAreEmpty() throws {
        for json in [#"{}"#, #"{"actions":null}"#, #"{"actions":"none"}"#, #"[]"#] {
            XCTAssertEqual(try JSONDecoder().decode(CloudPendingAgentActionList.self, from: Data(json.utf8)).actions, [])
        }
    }

    func testDecisionResponseReadsTheActionLeniently() throws {
        let decided = try JSONDecoder().decode(CloudAgentActionDecisionResponse.self, from: Data(
            #"{"action":{"actionId":"a1","kind":"plan_rsvp","status":"applied","proposedBy":{"kind":"pip"}},"planCard":{"eventId":"evt_1"}}"#.utf8
        ))
        XCTAssertEqual(decided.action?.status, "applied")
        XCTAssertEqual(decided.action?.proposedBy.isPip, true)
        XCTAssertNil(try JSONDecoder().decode(CloudAgentActionDecisionResponse.self, from: Data(#"{"action":null}"#.utf8)).action)
    }
}

private final class AgentActionSyncURLProtocol: URLProtocol {
    static var body = "{}"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
