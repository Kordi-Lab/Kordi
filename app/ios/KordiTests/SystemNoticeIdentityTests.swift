import XCTest
@testable import Kordi

final class SystemNoticeIdentityTests: XCTestCase {
    func testSystemNoticeFromPipProjectsAsSystem() throws {
        let conversation = makeGroup()
        let notice = makeWire(id: "notice", kind: KordiSystemIdentity.messageKind, body: "Maya joined.")
        let reply = makeWire(id: "reply", kind: nil, body: "Here is the plan.")

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [notice, reply]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first { $0.id == "notice" })
        let pipReply = try XCTUnwrap(projected.first { $0.id == "reply" })

        XCTAssertEqual(message.authorName, "System")
        XCTAssertEqual(message.text, "Maya joined.")
        XCTAssertFalse(message.isSystemNotice, "Notices keep the normal bubble layout")
        XCTAssertEqual(pipReply.authorName, KordiSystemIdentity.displayName, "The plan agent shows as System")
    }

    func testSystemNoticeResolvesToSystemNotPip() {
        let conversation = makeGroup()
        let notice = ChatMessage(
            id: "notice", conversationId: conversation.id, author: .person, authorName: "PiP",
            text: "Welcome", createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil,
            requestMessageId: nil, messageKind: KordiSystemIdentity.messageKind
        )

        let identity = MessageAuthorIdentity.resolve(notice, in: conversation, account: nil, mentionTargets: [])

        XCTAssertEqual(identity.name, "System")
        XCTAssertNil(identity.source)
        XCTAssertEqual(identity.seed, KordiSystemIdentity.seed)
        XCTAssertFalse(KordiPipIdentity.matches(name: identity.name, seed: identity.seed))
        XCTAssertTrue(KordiSystemIdentity.matches(seed: identity.seed))
        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: conversation, message: notice, selfAccountID: "acct_me",
            contacts: [], conversations: []
        ))
    }

    func testPlanAgentMessageWithoutTheKindShowsAsSystem() {
        let conversation = makeGroup()
        for authorName in ["System", "PiP"] {
            let message = ChatMessage(
                id: "pip", conversationId: conversation.id, author: .person, authorName: authorName,
                text: "Plan", createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil,
                requestMessageId: nil
            )

            let identity = MessageAuthorIdentity.resolve(message, in: conversation, account: nil, mentionTargets: [])

            XCTAssertEqual(identity, KordiSystemIdentity.avatar, authorName)
        }
    }

    private func makeGroup() -> ConversationSummary {
        ConversationSummary(
            id: "group:mobile", kind: .group, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Mobile builders", displayName: "Mobile builders", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:group:mobile", groupSpaceId: "session:group:mobile",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Shu Yang", avatarUrl: nil, role: "owner"),
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "member")
            ]
        )
    }

    private func makeWire(id: String, kind: String?, body: String) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: KordiPipIdentity.accountId,
            toAccountId: "acct_me",
            body: body,
            createdAt: "2026-10-21T10:00:00Z",
            deliveredAt: "2026-10-21T10:00:01Z",
            readAt: nil,
            direction: "incoming",
            sessionId: "session:group:mobile",
            messageKind: kind
        )
    }
}
