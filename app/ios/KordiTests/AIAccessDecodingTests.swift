import XCTest
@testable import Kordi

final class AIAccessDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder.decode(T.self, from: Data(json.utf8))
    }

    private func conversationJSON(aiAccess: String?) -> String {
        let aiAccessField = aiAccess.map { #","ai_access":\#($0)"# } ?? ""
        return #"""
        {"id":"8b2a4d0e-0000-4000-8000-000000000001","kind":"group","shared_title":"Team","version":3,
         "created_by_account_id":"acct_owner","legacy_session_id":"session:group:g1",
         "latest_message_sequence":12,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z",
         "members":[{"account_id":"acct_owner","role":"owner","membership_state":"active","version":1,
                     "last_delivered_sequence":12,"last_read_sequence":12,"joined_at":"2026-10-01T00:00:00Z"}],
         "preferences":{"conversation_id":"8b2a4d0e-0000-4000-8000-000000000001","account_id":"acct_owner","version":1}\#(aiAccessField)}
        """#
    }

    func testValidGroupAccessDecodesEveryField() throws {
        let response = try decode(CloudAIAccessResponse.self, #"""
        {"conversation_id":"c1","ai_access":{"history_scope":"recent",
          "pip":{"available":true,"enabled":true,"provider_label":"OpenAI"},
          "excluded_member_ids":["acct_c","acct_d"],"viewer_excluded":true,"viewer_can_manage":true}}
        """#)
        let access = try XCTUnwrap(response.aiAccess)
        XCTAssertEqual(access.historyScope, .recent)
        XCTAssertEqual(access.pip, CloudPipAccess(available: true, enabled: true, providerLabel: "OpenAI"))
        XCTAssertEqual(access.excludedMemberIds, ["acct_c", "acct_d"])
        XCTAssertTrue(access.viewerExcluded)
        XCTAssertTrue(access.viewerCanManage)
    }

    func testMissingAccessIsNil() throws {
        XCTAssertNil(try decode(CloudAIAccessResponse.self, #"{"conversation_id":"c1"}"#).aiAccess)
        XCTAssertNil(try decode(CloudAIAccessResponse.self, #"{"conversation_id":"c1","ai_access":null}"#).aiAccess)
        XCTAssertNil(try decode(CloudAIAccessResponse.self, #"[]"#).aiAccess)
    }

    func testMalformedAccessNeverThrowsAndFallsBackPerField() throws {
        XCTAssertNil(try decode(CloudAIAccessResponse.self, #"{"ai_access":"recent"}"#).aiAccess)
        let access = try XCTUnwrap(decode(CloudAIAccessResponse.self, #"""
        {"ai_access":{"history_scope":7,"pip":"yes","excluded_member_ids":["acct_c",3,"","acct_c",null,"acct_d"],
                      "viewer_excluded":"true","viewer_can_manage":null}}
        """#).aiAccess)
        XCTAssertEqual(access.historyScope, .mentions)
        XCTAssertNil(access.pip)
        XCTAssertEqual(access.excludedMemberIds, ["acct_c", "acct_d"])
        XCTAssertFalse(access.viewerExcluded)
        XCTAssertFalse(access.viewerCanManage)
        // An unknown scope is never shown as broader access than the server stated.
        XCTAssertEqual(try decode(CloudAIAccess.self, #"{"history_scope":"everything"}"#).historyScope, .mentions)
        XCTAssertEqual(try decode([CloudAIAccess].self, #"[42, "x"]"#), [CloudAIAccess(), CloudAIAccess()])
    }

    func testUpdateResponseReadsAccessFromTheConversationSnapshot() throws {
        let response = try decode(CloudAIAccessResponse.self, #"{"conversation":\#(conversationJSON(aiAccess: #"{"history_scope":"recent","pip":null,"excluded_member_ids":[],"viewer_excluded":false,"viewer_can_manage":true}"#))}"#)
        XCTAssertEqual(response.conversation?.legacySessionId, "session:group:g1")
        XCTAssertEqual(response.aiAccess?.historyScope, .recent)
        XCTAssertEqual(response.aiAccess?.viewerCanManage, true)
    }

    func testExistingConversationDecodingIgnoresAccessOfAnyShape() throws {
        for aiAccess in [
            nil,
            #"{"history_scope":"mentions","pip":{"available":true,"enabled":false,"provider_label":null},"excluded_member_ids":["acct_c"],"viewer_excluded":false,"viewer_can_manage":false}"#,
            #""malformed""#,
            #"[1,2,3]"#,
            "null",
        ] {
            let conversation = try decode(CloudChatConversation.self, conversationJSON(aiAccess: aiAccess))
            XCTAssertEqual(conversation.legacySessionId, "session:group:g1")
            XCTAssertEqual(conversation.members.count, 1)
        }
    }

    func testConversationUpdatedEventWithMalformedAccessStillDecodes() throws {
        let event = try decode(CloudChatEvent.self, #"""
        {"stream_seq":7,"event_id":"evt","protocol_version":2,"type":"conversation.updated","critical":true,
         "conversation_id":"8b2a4d0e-0000-4000-8000-000000000001","entity_id":null,"entity_version":null,
         "occurred_at":"2026-10-01T00:00:00Z",
         "payload":{"conversation":\#(conversationJSON(aiAccess: #"{"history_scope":["recent"]}"#))}}
        """#)
        XCTAssertEqual(event.payload.conversation?.legacySessionId, "session:group:g1")
    }

    func testAIFeaturesDecodeLeniently() throws {
        let available = try decode(CloudAIFeatures.self, #"{"pip":{"available":true,"provider_label":"Anthropic"}}"#)
        XCTAssertEqual(available, CloudAIFeatures(pipAvailable: true, pipProviderLabel: "Anthropic"))
        XCTAssertEqual(try decode(CloudAIFeatures.self, #"{}"#), CloudAIFeatures(pipAvailable: false))
        XCTAssertEqual(try decode(CloudAIFeatures.self, #"{"pip":true}"#), CloudAIFeatures(pipAvailable: false))
        XCTAssertEqual(
            try decode(CloudAIFeatures.self, #"{"pip":{"available":"yes","provider_label":""}}"#),
            CloudAIFeatures(pipAvailable: false)
        )
    }

    func testChangeRequestsCarryExactlyOneSetting() throws {
        let cases: [(CloudAIAccessChange, String, Any)] = [
            (.historyScope(.recent), "history_scope", "recent"),
            (.historyScope(.mentions), "history_scope", "mentions"),
            (.pipEnabled(true), "pip_enabled", true),
            (.excludeMyMessages(false), "exclude_my_messages", false),
        ]
        for (change, key, value) in cases {
            let data = try JSONEncoder().encode(CloudAIAccessChangeRequest(clientOperationId: "op-1", change: change))
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(Set(object.keys), ["client_operation_id", key])
            XCTAssertEqual(object["client_operation_id"] as? String, "op-1")
            XCTAssertEqual(object[key] as? NSObject, value as? NSObject)
        }
    }

    func testOnlySyncedGroupsAndDirectChatsHaveAIAccess() {
        XCTAssertTrue(AIAccessCopy.supportsAIAccess(sessionId: "session:group:g1"))
        XCTAssertTrue(AIAccessCopy.supportsAIAccess(sessionId: "session:direct-person:acct_a:acct_b"))
        XCTAssertFalse(AIAccessCopy.supportsAIAccess(sessionId: "session:agent:private"))
        XCTAssertFalse(AIAccessCopy.supportsAIAccess(sessionId: ""))
    }

    func testAccessCopyMatchesTheSettingAndErrors() {
        XCTAssertEqual(AIAccessCopy.scopeTitle(.mentions), "Only messages sent to them")
        XCTAssertEqual(AIAccessCopy.scopeTitle(.recent), "Recent messages")
        XCTAssertTrue(AIAccessCopy.scopeHelp(.mentions).hasPrefix("When someone asks an agent here, it gets that message"))
        XCTAssertTrue(AIAccessCopy.scopeHelp(.recent).hasSuffix("search this conversation's history."))
        XCTAssertEqual(AIAccessCopy.updateErrorText(code: "PIP_UNAVAILABLE"), "PiP isn't available on this server.")
        XCTAssertEqual(AIAccessCopy.updateErrorText(code: "CHAT_FORBIDDEN"), "Only group owners and admins can change this.")
        XCTAssertEqual(AIAccessCopy.updateErrorText(code: "INVALID_AI_ACCESS"), "Couldn't update AI access. Try again.")
        XCTAssertEqual(AIAccessCopy.updateErrorText(code: nil), "Couldn't update AI access. Try again.")
        XCTAssertTrue(AIAccessCopy.pipHelp(provider: "OpenAI").contains("It uses OpenAI through Kordi's account."))
        XCTAssertTrue(AIAccessCopy.createPipHelp(provider: nil).contains("using an AI provider through Kordi's account"))
    }

    func testTurnedOnByNamesMembersAndTheViewer() {
        let names = ["acct_c": "Casey", "acct_d": "Dana"]
        XCTAssertEqual(AIAccessCopy.turnedOnByText(excludedMemberIds: [], names: names, currentAccountId: "acct_me"), "No one")
        XCTAssertEqual(
            AIAccessCopy.turnedOnByText(excludedMemberIds: ["acct_me", "acct_c", "acct_x"], names: names, currentAccountId: "acct_me"),
            "You, Casey, A member"
        )
    }
}

final class AgentTrustAPITests: XCTestCase {
    override func tearDown() {
        AgentTrustURLProtocol.reset()
        super.tearDown()
    }

    private func client() -> CloudAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentTrustURLProtocol.self]
        return CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
    }

    func testSessionIdsAreOneEscapedPathSegment() {
        XCTAssertEqual(
            CloudAPIClient.aiAccessPath(sessionId: "session:group:g1"),
            "/v2/chat/conversations/session%3Agroup%3Ag1/ai-access"
        )
        XCTAssertEqual(
            CloudAPIClient.aiAccessPath(sessionId: "a/../b?c#d"),
            "/v2/chat/conversations/a%2F..%2Fb%3Fc%23d/ai-access"
        )
    }

    func testReadAndUpdateUseTheSessionAndSendOneChange() async throws {
        AgentTrustURLProtocol.responseBody = #"{"conversation_id":"c1","ai_access":{"history_scope":"recent","viewer_can_manage":true}}"#
        let api = client()
        let access = try await api.aiAccess(token: "synthetic", sessionId: "session:group:g1")
        XCTAssertEqual(access?.historyScope, .recent)

        AgentTrustURLProtocol.responseBody = #"{"conversation":{"ai_access":{"history_scope":"mentions","pip":{"available":true,"enabled":true}}}}"#
        let updated = try await api.updateAIAccess(token: "synthetic", sessionId: "session:group:g1", change: .pipEnabled(true))
        XCTAssertEqual(updated?.pip?.enabled, true)

        let requests = AgentTrustURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["GET", "PUT"])
        XCTAssertEqual(requests.map(\.path), [
            "/v2/chat/conversations/session%3Agroup%3Ag1/ai-access",
            "/v2/chat/conversations/session%3Agroup%3Ag1/ai-access",
        ])
        let body = try XCTUnwrap(requests.last?.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["client_operation_id", "pip_enabled"])
        XCTAssertNotNil(UUID(uuidString: object["client_operation_id"] as? String ?? ""))
        XCTAssertEqual(requests.first?.authorization, "Bearer synthetic")
    }

    func testActionsAndDisclosuresUseTheirRoutes() async throws {
        let api = client()
        AgentTrustURLProtocol.responseBody = #"{"actions":[{"actionId":"a1","kind":"plan_vote","sessionId":"session:group:g1","status":"pending","subject":{"title":"Lunch","optionLabel":"Noon"}}]}"#
        let actions = try await api.listAgentActions(token: "synthetic", sessionId: "session:group:g1")
        XCTAssertEqual(actions.map(\.actionId), ["a1"])

        AgentTrustURLProtocol.responseBody = #"{"action":{"actionId":"a1","kind":"plan_vote","status":"applied"},"planCard":null}"#
        let decided = try await api.decideAgentAction(token: "synthetic", id: "a1", decision: .approve)
        XCTAssertEqual(decided?.status, "applied")

        AgentTrustURLProtocol.responseBody = #"{"disclosures":[{"key":"m1","runtime":"owner_device","ownerName":"Olive"}]}"#
        let disclosures = try await api.agentReplyDisclosures(
            token: "synthetic",
            sessionId: "session:group:g1",
            replies: [CloudAgentReplyDisclosureRequest(key: "m1", requestId: "r1", ownerAccountId: "acct_owner")]
        )
        XCTAssertEqual(disclosures.first?.runtime, .ownerDevice)

        let requests = AgentTrustURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["GET", "POST", "POST"])
        XCTAssertEqual(requests[0].path, "/v1/cloud/agent-actions")
        XCTAssertEqual(requests[0].query, "sessionId=session:group:g1")
        XCTAssertEqual(requests[1].path, "/v1/cloud/agent-actions/a1/decision")
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: XCTUnwrap(requests[1].body)) as? [String: String],
            ["decision": "approve"]
        )
        XCTAssertEqual(requests[2].path, "/v1/cloud/agent-runs/disclosures")
        let disclosureBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[2].body)) as? [String: Any])
        XCTAssertEqual(disclosureBody["sessionId"] as? String, "session:group:g1")
        XCTAssertEqual(
            disclosureBody["replies"] as? [[String: String]],
            [["key": "m1", "requestId": "r1", "ownerAccountId": "acct_owner"]]
        )
    }

    func testServerErrorsKeepTheirCodes() async {
        AgentTrustURLProtocol.statusCode = 409
        AgentTrustURLProtocol.responseBody = #"{"error":{"code":"PIP_UNAVAILABLE","message":"PiP isn't available on this server."}}"#
        do {
            _ = try await client().updateAIAccess(token: "synthetic", sessionId: "session:group:g1", change: .pipEnabled(true))
            XCTFail("A refused change must throw")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "PIP_UNAVAILABLE")
            XCTAssertEqual(AIAccessCopy.updateErrorText(code: error.code), "PiP isn't available on this server.")
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    func testDecisionErrorsKeepTheirLowercaseCodes() async {
        for (status, code, text) in [
            (409, "plan_changed", "This plan changed. Check the card and try again."),
            (409, "agent_action_closed", "This request is no longer waiting. Ask again if you still need it."),
            (403, "plan_card_forbidden", "Couldn't save your answer. Try again."),
        ] {
            AgentTrustURLProtocol.reset()
            AgentTrustURLProtocol.statusCode = status
            AgentTrustURLProtocol.responseBody = #"{"errorCode":"\#(code)","message":"Refused."}"#
            do {
                _ = try await client().decideAgentAction(token: "synthetic", id: "a1", decision: .decline)
                XCTFail("A refused decision must throw")
            } catch let error as CloudAPIError {
                XCTAssertEqual(error.code, code)
                XCTAssertEqual(error.statusCode, status)
                XCTAssertEqual(PendingAgentActionCopy.errorText(code: error.code), text)
            } catch {
                XCTFail("Unexpected error \(error)")
            }
        }
    }

    func testAnOlderServerWithoutTheRoutesFailsQuietly() async {
        AgentTrustURLProtocol.statusCode = 404
        AgentTrustURLProtocol.responseBody = ""
        do {
            _ = try await client().aiFeatures(token: "synthetic")
            XCTFail("A missing route must throw so the app hides the PiP switch")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.statusCode, 404)
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }
}

private final class AgentTrustURLProtocol: URLProtocol {
    struct Recorded {
        let method: String
        let path: String
        let query: String?
        let body: Data?
        let authorization: String?
    }

    private static let lock = NSLock()
    private static var recorded: [Recorded] = []
    static var responseBody = "{}"
    static var statusCode = 200

    static var requests: [Recorded] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        recorded = []
        responseBody = "{}"
        statusCode = 200
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        Self.lock.lock()
        Self.recorded.append(Recorded(
            method: request.httpMethod ?? "GET",
            path: components?.percentEncodedPath ?? url.path,
            query: components?.query,
            body: request.httpBody ?? request.httpBodyStream.map(Self.read),
            authorization: request.value(forHTTPHeaderField: "Authorization")
        ))
        let body = Self.responseBody
        let status = Self.statusCode
        Self.lock.unlock()
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
