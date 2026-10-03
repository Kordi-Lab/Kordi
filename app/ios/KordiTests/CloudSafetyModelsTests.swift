import Foundation
import Testing
@testable import Kordi

/// Answers safety routes from a per-test table and records every request.
private final class SafetyRouteProtocol: URLProtocol {
    struct Answer {
        let status: Int
        let body: String
    }

    struct Recorded {
        let method: String
        let path: String
        let body: Data?
    }

    private static let lock = NSLock()
    private static var answers: [String: Answer] = [:]
    private static var recorded: [Recorded] = []

    static func reset(_ table: [String: Answer]) {
        lock.lock(); defer { lock.unlock() }
        answers = table
        recorded = []
    }

    static var requests: [Recorded] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let answer: Answer
        do {
            Self.lock.lock(); defer { Self.lock.unlock() }
            Self.recorded.append(Recorded(method: method, path: path, body: Self.bodyData(request)))
            answer = Self.answers["\(method) \(path)"] ?? Answer(status: 404, body: "")
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func bodyData(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
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

private func makeClient(accountId: String = "acct_me") async -> (CloudAPIClient, URLSession) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SafetyRouteProtocol.self]
    let session = URLSession(configuration: configuration)
    let api = CloudAPIClient(session: session)
    await api.activateAccount(accountId)
    return (api, session)
}

private func jsonObject(_ data: Data?) throws -> [String: Any] {
    let data = try #require(data)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private let groupConversationId = "6f1c1e8a-3c47-4c33-9a0e-0c4f5f4f9a01"
private let groupSessionId = "session:group:safety-root"

private let bootstrapWithGroup = """
{"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[],"pinnedSessionIds":[],"mutedSessionIds":[],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]},"conversations":[{"id":"\(groupConversationId)","kind":"group","shared_title":"Team","version":3,"created_by_account_id":"acct_me","legacy_session_id":"\(groupSessionId)","group_space_id":"\(groupSessionId)","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":4,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-10-01T00:00:00Z","left_at":null},{"account_id":"acct_bea","display_name":"Bea","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-10-01T00:01:00Z","left_at":null},{"account_id":"acct_cal","display_name":"Cal","avatar_url":null,"role":"member","membership_state":"left","version":2,"last_delivered_sequence":2,"last_read_sequence":2,"joined_at":"2026-10-01T00:02:00Z","left_at":"2026-10-01T00:03:00Z"}],"preferences":{"conversation_id":"\(groupConversationId)","account_id":"acct_me","personal_title":null,"version":1}}],"latest_messages":[],"next_cursor":"1","last_stream_seq":1,"server_time":"2026-10-01T00:00:00Z"}
"""

@Suite(.serialized)
struct CloudSafetyModelsTests {
    @Test func blockListAndBlockResultDecode() async throws {
        SafetyRouteProtocol.reset([
            "GET /v1/cloud/blocks": .init(status: 200, body: #"{"blocks":[{"accountId":"acct_bea","kordiId":"123456789","displayName":"Bea","avatarUrl":null,"blockedAt":"2026-10-01T10:00:00+00:00"}]}"#),
            "PUT /v1/cloud/blocks/acct_cal": .init(status: 200, body: #"{"block":{"accountId":"acct_cal","kordiId":"987654321","displayName":null,"avatarUrl":"kordi-avatar://seed","blockedAt":"2026-10-01T11:00:00+00:00"},"removedContact":true}"#),
            "DELETE /v1/cloud/blocks/acct_cal": .init(status: 204, body: ""),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        let blocks = try await api.listBlockedAccounts(token: "synthetic")
        #expect(blocks.map(\.accountId) == ["acct_bea"])
        #expect(blocks.first?.preferredName == "Bea")

        let result = try await api.blockAccount(token: "synthetic", accountId: "acct_cal")
        #expect(result.removedContact)
        #expect(result.block.preferredName == "987654321")

        try await api.unblockAccount(token: "synthetic", accountId: "acct_cal")
        #expect(SafetyRouteProtocol.requests.map { "\($0.method) \($0.path)" } == [
            "GET /v1/cloud/blocks", "PUT /v1/cloud/blocks/acct_cal", "DELETE /v1/cloud/blocks/acct_cal",
        ])
    }

    @Test func onlyAnEmpty404MeansTheRouteIsMissing() async throws {
        SafetyRouteProtocol.reset([
            "GET /v1/cloud/blocks": .init(status: 404, body: ""),
            "POST /v1/cloud/contacts/requests/req_other/withdraw": .init(status: 404, body: #"{"errorCode":"not_found","message":"No such request."}"#),
            "DELETE /v1/cloud/contacts/acct_bea": .init(status: 404, body: #"{"error":{"code":"CHAT_ENTITY_NOT_FOUND","message":"missing"}}"#),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        await #expect(throws: CloudAPIError.self) { _ = try await api.listBlockedAccounts(token: "synthetic") }
        do {
            _ = try await api.listBlockedAccounts(token: "synthetic")
        } catch let error as CloudAPIError {
            #expect(error.isMissingRoute)
        }
        do {
            try await api.withdrawContactRequest(token: "synthetic", requestId: "req_other")
            Issue.record("Expected a 404")
        } catch let error as CloudAPIError {
            #expect(error.code == "not_found")
            #expect(!error.isMissingRoute)
        }
        do {
            try await api.removeContact(token: "synthetic", peerAccountId: "acct_bea")
            Issue.record("Expected a 404")
        } catch let error as CloudAPIError {
            #expect(error.code == "CHAT_ENTITY_NOT_FOUND")
            #expect(!error.isMissingRoute)
        }
    }

    @Test func removeAndWithdrawUseTheirRoutes() async throws {
        SafetyRouteProtocol.reset([
            "DELETE /v1/cloud/contacts/acct_bea": .init(status: 204, body: ""),
            "POST /v1/cloud/contacts/requests/req_123/withdraw": .init(status: 204, body: ""),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        try await api.removeContact(token: "synthetic", peerAccountId: "acct_bea")
        try await api.withdrawContactRequest(token: "synthetic", requestId: "req_123")
        #expect(SafetyRouteProtocol.requests.map { "\($0.method) \($0.path)" } == [
            "DELETE /v1/cloud/contacts/acct_bea", "POST /v1/cloud/contacts/requests/req_123/withdraw",
        ])
    }

    @Test func reportRequestUsesCamelCaseAndLeavesOutAbsentValues() throws {
        let request = CloudReportRequest(
            clientReportId: "0d6f3c34-6a0e-4f3e-9b1e-5a7d4a7f0c11",
            reason: .harassment,
            details: nil,
            reportedAccountId: "acct_bea",
            conversationId: nil,
            messageIds: [],
            contactRequestId: "req_123"
        )
        let object = try jsonObject(try JSONEncoder().encode(request))
        #expect(Set(object.keys) == ["clientReportId", "reason", "reportedAccountId", "messageIds", "contactRequestId"])
        #expect(object["reason"] as? String == "harassment")
        #expect((object["messageIds"] as? [String])?.isEmpty == true)
        #expect(CloudReportReason.allCases.map(\.rawValue) == [
            "spam", "harassment", "scam", "impersonation", "inappropriate", "other",
        ])
        #expect(CloudReportReason.impersonation.label == "Pretending to be someone else")
    }

    @Test func messageReportResolvesTheConversationAndDecodesTheReceipt() async throws {
        let messageId = "8b2c6f2e-1d4b-4c55-8f3a-2f6a1e9d7c10"
        SafetyRouteProtocol.reset([
            "GET /v2/chat/sync/bootstrap": .init(status: 200, body: bootstrapWithGroup),
            "POST /v1/cloud/reports": .init(status: 201, body: #"{"report":{"reportId":"rpt_0123456789abcdef0123456789abcdef","reference":"R-01234567","status":"received","reason":"spam","targetKind":"message","evidenceMessageCount":1,"reportedDisplayName":"Bea","createdAt":"2026-10-01T12:00:00.123456789Z","closedAt":null}}"#),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        let receipt = try await api.createReport(
            token: "synthetic",
            sessionId: groupSessionId,
            messageId: messageId,
            reportedAccountId: nil,
            reason: .spam,
            details: "  repeated links  ",
            contactRequestId: nil,
            clientReportId: "5b0b2f7c-7a55-4c6b-9e43-2d8b3f4a6e21"
        )
        #expect(receipt.reference == "R-01234567")
        #expect(receipt.evidenceMessageCount == 1)
        #expect(receipt.closedAt == nil)

        let sent = try #require(SafetyRouteProtocol.requests.last)
        #expect(sent.path == "/v1/cloud/reports")
        let body = try jsonObject(sent.body)
        #expect(body["conversationId"] as? String == groupConversationId)
        #expect(body["messageIds"] as? [String] == [messageId])
        #expect(body["details"] as? String == "repeated links")
        #expect(body["reportedAccountId"] == nil)
        #expect(body["clientReportId"] as? String == "5b0b2f7c-7a55-4c6b-9e43-2d8b3f4a6e21")
    }

    @Test func leaveSendsSnakeCaseWithAFreshOperationAndForgetsTheConversation() async throws {
        SafetyRouteProtocol.reset([
            "GET /v2/chat/sync/bootstrap": .init(status: 200, body: bootstrapWithGroup),
            "POST /v2/chat/conversations/\(groupConversationId)/leave": .init(status: 200, body: #"{"left_conversation_ids":["\#(groupConversationId)"],"successor_account_id":"acct_bea"}"#),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        let inactive = await api.cachedInactiveChatMemberIdsBySessionId()
        #expect(inactive.isEmpty)
        let response = try await api.leaveConversation(token: "synthetic", sessionId: groupSessionId, successorAccountId: "acct_bea")
        #expect(response.leftConversationIds == [groupConversationId])
        #expect(response.successorAccountId == "acct_bea")
        #expect(await api.cachedChatConversations().isEmpty)

        let first = try jsonObject(SafetyRouteProtocol.requests.last?.body)
        #expect(Set(first.keys) == ["client_operation_id", "successor_account_id"])
        #expect(first["successor_account_id"] as? String == "acct_bea")
        let firstOperation = try #require(first["client_operation_id"] as? String)
        #expect(UUID(uuidString: firstOperation) != nil)
        #expect(firstOperation == firstOperation.lowercased())
    }

    @Test func leaveWithoutASuccessorSendsAnExplicitNull() async throws {
        SafetyRouteProtocol.reset([
            "GET /v2/chat/sync/bootstrap": .init(status: 200, body: bootstrapWithGroup),
            "POST /v2/chat/conversations/\(groupConversationId)/leave": .init(status: 200, body: #"{"left_conversation_ids":[],"successor_account_id":null}"#),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        let response = try await api.leaveConversation(token: "synthetic", sessionId: groupSessionId, successorAccountId: nil)
        #expect(response.leftConversationIds.isEmpty)
        let body = try jsonObject(SafetyRouteProtocol.requests.last?.body)
        #expect(body.keys.contains("successor_account_id"))
        #expect(body["successor_account_id"] is NSNull)
    }

    @Test func inactiveMembersAreKnownByConversationAndSession() async throws {
        SafetyRouteProtocol.reset([
            "GET /v2/chat/sync/bootstrap": .init(status: 200, body: bootstrapWithGroup),
        ])
        let (api, session) = await makeClient()
        defer { session.invalidateAndCancel() }

        _ = try await api.bootstrapChatLatestMessages(token: "synthetic")
        let inactive = await api.cachedInactiveChatMemberIdsBySessionId()
        #expect(inactive[groupSessionId] == ["acct_cal"])
        #expect(inactive[groupConversationId] == ["acct_cal"])
        let active = await api.cachedChatParticipantsBySessionId()[groupSessionId]?.map(\.accountId)
        #expect(active == ["acct_me", "acct_bea"])
    }

    @Test func profilesDecodeWithAndWithoutBlockState() throws {
        let older = #"{"accountId":"acct_bea","kordiId":"123456789","displayName":"Bea","avatarUrl":null,"nodeId":null,"isContact":false,"isSelf":false}"#
        let newer = #"{"accountId":"acct_bea","kordiId":"123456789","displayName":"Bea","avatarUrl":null,"nodeId":null,"isContact":false,"isSelf":false,"isBlocked":true}"#
        #expect(try JSONDecoder().decode(CloudPublicProfile.self, from: Data(older.utf8)).isBlocked == nil)
        #expect(try JSONDecoder().decode(CloudPublicProfile.self, from: Data(newer.utf8)).isBlocked == true)
    }

    @Test func withdrawnRequestsAndLeaveResponsesDecode() throws {
        let request = #"{"requestId":"req_1","fromAccountId":"acct_me","toAccountId":"acct_bea","status":"withdrawn","direction":"outgoing","message":null,"createdAt":"2026-10-01T00:00:00+00:00","decidedAt":"2026-10-01T01:00:00+00:00","counterpart":null,"extra":1}"#
        let decoded = try JSONDecoder().decode(CloudContactRequest.self, from: Data(request.utf8))
        #expect(decoded.status == "withdrawn")
        #expect(!decoded.isIncoming)

        let sparse = try JSONDecoder().decode(CloudLeaveConversationResponse.self, from: Data("{}".utf8))
        #expect(sparse.leftConversationIds.isEmpty)
        #expect(sparse.successorAccountId == nil)
    }

    @Test func memberLeavesEncodeWholeMillisecondsAndOldEnvelopesStillParse() throws {
        let actor = CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "owner")
        let bea = CloudGroupParticipant(accountId: "acct_bea", displayName: "Bea", avatarUrl: nil, role: "admin")
        let leave = CloudGroupMemberLeave(
            eventId: "3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
            accountId: "acct_me",
            createdAtMs: 1_790_000_000_123
        )
        let envelope = CloudGroupControlEnvelope(
            kind: "group-update", groupId: groupSessionId, groupSpaceId: groupSessionId,
            groupTitle: "Team", createdByAccountId: "acct_me", actor: actor,
            participants: [bea], memberLeaves: [leave], message: nil
        )
        let json = String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self)
        #expect(json.contains(#""createdAtMs":1790000000123"#))
        #expect(json.contains(#""memberLeaves":[{"#))

        let body = try CloudGroupMessageCodec.encode(envelope)
        let parsed = try #require(CloudGroupMessageCodec.parse(body))
        #expect(parsed.memberLeaves == [leave])
        #expect(parsed.participants.map(\.accountId) == ["acct_bea"])
        #expect(parsed.actor.accountId == "acct_me")

        let old = CloudGroupControlEnvelope(
            kind: "group-update", groupId: "session:group:old", groupSpaceId: nil, groupTitle: nil,
            createdByAccountId: "acct_me", actor: actor, participants: [actor, bea], message: nil
        )
        let oldJSON = String(decoding: try JSONEncoder().encode(old), as: UTF8.self)
        #expect(!oldJSON.contains("memberLeaves"))
        #expect(CloudGroupMessageCodec.parse(try CloudGroupMessageCodec.encode(old))?.memberLeaves == nil)
    }

    @Test func malformedMemberLeavesNeverHideTheEnvelope() throws {
        let raw = #"{"kind":"group-update","groupId":"session:group:x","groupSpaceId":"session:group:x","groupTitle":"Team","createdByAccountId":"acct_me","actor":{"accountId":"acct_me","displayName":"Me"},"participants":[{"accountId":"acct_bea","displayName":"Bea"}],"memberLeaves":[{"eventId":"a","accountId":"acct_me","createdAtMs":1790000000123.7},{"accountId":"acct_me"},"nonsense"]}"#
        let envelope = try JSONDecoder().decode(CloudGroupControlEnvelope.self, from: Data(raw.utf8))
        #expect(envelope.participants.map(\.accountId) == ["acct_bea"])
        #expect(envelope.memberLeaves?.map(\.createdAtMs) == [1_790_000_000_123])

        let unreadable = #"{"kind":"group-update","groupId":"session:group:x","createdByAccountId":"acct_me","actor":{"accountId":"acct_me","displayName":"Me"},"participants":[{"accountId":"acct_bea","displayName":"Bea"}],"memberLeaves":"not a list"}"#
        let fallback = try JSONDecoder().decode(CloudGroupControlEnvelope.self, from: Data(unreadable.utf8))
        #expect(fallback.memberLeaves == nil)
        #expect(fallback.kind == "group-update")
    }
}
