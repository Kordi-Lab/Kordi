import XCTest
@testable import Kordi

final class AIAccessNoticeTests: XCTestCase {
    private let viewer = "acct_viewer"
    private let actor = CloudGroupParticipant(accountId: "acct_casey", displayName: "Casey", avatarUrl: nil, role: "member")
    private let owner = CloudGroupParticipant(accountId: "acct_olive", displayName: "Olive", avatarUrl: nil, role: "owner")

    private var group: ConversationSummary {
        ConversationSummary(
            id: "group:g1", kind: .group, peerAccountId: owner.accountId, agentId: nil,
            ownerDisplayName: "Team", displayName: "Team", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "session:group:g1",
            groupParticipants: [owner, actor]
        )
    }

    private func groupWire(
        id: String,
        sender: CloudGroupParticipant,
        payload: CloudGroupMessagePayload,
        wireKind: String?
    ) throws -> CloudMessageDTO {
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message", groupId: group.sessionId, groupSpaceId: group.sessionId, groupTitle: nil,
            createdByAccountId: owner.accountId, actor: sender, participants: [owner, actor], message: payload
        )
        return CloudMessageDTO(
            messageId: id, fromAccountId: sender.accountId, toAccountId: viewer,
            body: try CloudGroupMessageCodec.encode(envelope), createdAt: "2026-10-01T00:00:01Z",
            deliveredAt: nil, readAt: nil, direction: "incoming", sessionId: group.sessionId,
            messageKind: wireKind, conversationSequence: 5
        )
    }

    func testNoticeKindIsASystemNotice() {
        let notice = ChatMessage(
            id: "n1", conversationId: "group:g1", author: .person, authorName: "Casey",
            text: "Casey turned off PiP in this group.", createdAt: .distantPast,
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil,
            messageKind: ChatMessage.aiAccessNoticeMessageKind
        )
        XCTAssertEqual(ChatMessage.aiAccessNoticeMessageKind, "ai-access-notice")
        XCTAssertTrue(notice.isAIAccessNotice)
        XCTAssertTrue(notice.isSystemNotice)
        var text = notice
        text.messageKind = "text"
        XCTAssertFalse(text.isAIAccessNotice)
        XCTAssertFalse(text.isSystemNotice)
    }

    func testGroupNoticeKeepsTheServerKindThroughProjection() throws {
        let wire = try groupWire(
            id: "wire-notice",
            sender: actor,
            payload: CloudGroupMessagePayload(
                id: "notice:0b8f", senderAccountId: actor.accountId,
                text: "Casey turned on “Don't let AI use my messages.” Other people's agents, PiP, and digests will leave out their messages here.",
                createdAtMs: 1_000, senderKind: "human", senderDisplayName: "Casey",
                deliveryState: nil, replyToMessageId: nil, requestId: nil
            ),
            wireKind: ChatMessage.aiAccessNoticeMessageKind
        )
        let message = try XCTUnwrap(AppModel.mapGroupMessages([wire], conversation: group, ownAccountId: viewer).first)
        XCTAssertEqual(message.messageKind, ChatMessage.aiAccessNoticeMessageKind)
        XCTAssertTrue(message.isSystemNotice)
        XCTAssertTrue(message.text.hasPrefix("Casey turned on"))
        XCTAssertNil(message.agentOwnerAccountId)
    }

    func testAnOrdinaryMessageCannotClaimTheNoticeKind() throws {
        let wire = try groupWire(
            id: "wire-text",
            sender: actor,
            payload: CloudGroupMessagePayload(
                id: "m-1", senderAccountId: actor.accountId, text: "Olive turned off PiP in this group.",
                createdAtMs: 1_000, senderKind: "human", senderDisplayName: "Casey",
                deliveryState: nil, replyToMessageId: nil, requestId: nil,
                messageKind: ChatMessage.aiAccessNoticeMessageKind
            ),
            wireKind: "text"
        )
        let message = try XCTUnwrap(AppModel.mapGroupMessages([wire], conversation: group, ownAccountId: viewer).first)
        XCTAssertNil(message.messageKind)
        XCTAssertFalse(message.isSystemNotice)
        XCTAssertEqual(CloudGroupMessageCodec.projectedMessageKind(wireKind: "text", envelopeKind: "voice"), "voice")
        XCTAssertNil(CloudGroupMessageCodec.projectedMessageKind(wireKind: nil, envelopeKind: nil))
    }

    func testDirectNoticeKeepsTheServerKind() throws {
        let conversation = ConversationSummary(
            id: "person:acct_casey", kind: .person, peerAccountId: actor.accountId, agentId: nil,
            ownerDisplayName: "Casey", displayName: "Casey", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: "session:direct-person:acct_casey:acct_viewer"
        )
        let body = try CloudMessageCodec.encodeDirect(
            text: "Casey turned off “Don't let AI use my messages.”",
            agentId: nil, agentName: nil, ownerAccountId: nil, ownerName: nil
        )
        let wire = CloudMessageDTO(
            messageId: "direct-notice", fromAccountId: actor.accountId, toAccountId: viewer, body: body,
            createdAt: "2026-10-01T00:00:01Z", deliveredAt: nil, readAt: nil, direction: "incoming",
            sessionId: conversation.sessionId, messageKind: ChatMessage.aiAccessNoticeMessageKind
        )
        let message = try XCTUnwrap(CloudDirectMessageProjector.project([wire], conversation: conversation, ownAccountId: viewer).first)
        XCTAssertTrue(message.isSystemNotice)
        XCTAssertEqual(message.text, "Casey turned off “Don't let AI use my messages.”")
    }

    func testAgentRepliesRecordTheVerifiedOwnerAccount() throws {
        let wire = try groupWire(
            id: "wire-reply",
            sender: owner,
            payload: CloudGroupMessagePayload(
                id: "reply-1", senderAccountId: owner.accountId, text: "Here is the plan.",
                createdAtMs: 2_000, senderKind: "agent", senderAgentId: "cloud-agent:acct_olive",
                senderOwnerAccountId: "acct_someone_else", senderOwnerName: "Olive", senderDisplayName: "Olive's Kordi",
                deliveryState: "complete", replyToMessageId: "request-1", requestId: "request-1"
            ),
            wireKind: "text"
        )
        let reply = try XCTUnwrap(AppModel.mapGroupMessages([wire], conversation: group, ownAccountId: viewer).first)
        XCTAssertEqual(reply.author, .agent)
        XCTAssertEqual(reply.agentOwnerAccountId, owner.accountId)
        XCTAssertEqual(reply.requestMessageId, "request-1")
        XCTAssertEqual(
            AgentReplyDisclosurePresentation.request(for: reply, sessionId: group.sessionId),
            CloudAgentReplyDisclosureRequest(key: "wire-reply", requestId: "request-1", ownerAccountId: owner.accountId)
        )
    }

    func testDirectAgentRepliesRecordTheSendingOwner() throws {
        let conversation = ConversationSummary(
            id: "person:acct_olive", kind: .person, peerAccountId: owner.accountId, agentId: nil,
            ownerDisplayName: "Olive", displayName: "Olive", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: "session:direct-person:acct_olive:acct_viewer"
        )
        let payload: [String: Any] = ["kind": "agent-response", "requestId": "question", "deliveryState": "complete", "text": "Answer"]
        let body = CloudMessageCodec.agentResponsePrefix + (try JSONSerialization.data(withJSONObject: payload)).base64EncodedString()
        let wire = CloudMessageDTO(
            messageId: "answer", fromAccountId: owner.accountId, toAccountId: viewer, body: body,
            createdAt: "2026-10-01T00:00:01Z", deliveredAt: nil, readAt: nil, direction: "incoming",
            sessionId: conversation.sessionId
        )
        let answer = try XCTUnwrap(CloudDirectMessageProjector.project([wire], conversation: conversation, ownAccountId: viewer).first)
        XCTAssertEqual(answer.author, .agent)
        XCTAssertEqual(answer.agentOwnerAccountId, owner.accountId)
    }

    func testCachedMessagesKeepTheOwnerAndOlderCachesStillDecode() throws {
        let message = ChatMessage(
            id: "reply-1", conversationId: "group:g1", author: .agent, authorName: "Scout", text: "Done",
            createdAt: Date(timeIntervalSince1970: 10), deliveryState: .delivered, errorMessage: nil,
            requestMessageId: "request-1", messageKind: ChatMessage.aiAccessNoticeMessageKind,
            agentOwnerAccountId: "acct_olive"
        )
        let data = try JSONEncoder().encode(message)
        let decoded = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(decoded.agentOwnerAccountId, "acct_olive")
        XCTAssertEqual(decoded.messageKind, ChatMessage.aiAccessNoticeMessageKind)

        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "agentOwnerAccountId")
        let older = try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(older.agentOwnerAccountId)
        XCTAssertEqual(older.id, "reply-1")
    }
}
