import XCTest
@testable import Kordi

final class BlockedAuthorFilterTests: XCTestCase {
    private let filter = BlockedAuthorFilter(viewerAccountId: "acct_me", blockedAccountIds: ["acct_blocked"])

    func testGroupMessageFromBlockedPersonCollapses() {
        XCTAssertTrue(filter.collapses(message(.person, "Sample Blocked"), in: conversation(.group)))
        XCTAssertFalse(filter.collapses(message(.person, "Sample Friend"), in: conversation(.group)))
    }

    func testAgentMessageCountsForItsOwner() {
        XCTAssertTrue(filter.collapses(message(.agent, "Helper", owner: "Sample Blocked"), in: conversation(.group)))
        XCTAssertFalse(filter.collapses(message(.agent, "Helper", owner: "Sample Friend"), in: conversation(.group)))
    }

    func testOwnMessagesNoticesAndDirectChatsStayVisible() {
        XCTAssertFalse(filter.collapses(message(.me, "Sample Blocked"), in: conversation(.group)))
        XCTAssertFalse(filter.collapses(message(.person, "Sample Blocked", kind: ChatMessage.groupMemberJoinMessageKind), in: conversation(.group)))
        XCTAssertFalse(filter.collapses(message(.person, "Sample Blocked"), in: conversation(.person)))
        XCTAssertFalse(BlockedAuthorFilter(viewerAccountId: "acct_me").collapses(message(.person, "Sample Blocked"), in: conversation(.group)))
    }

    @MainActor
    func testRevealOpensOnlyThatMessage() {
        let reveals = BlockedMessageReveals()
        reveals.filter = filter
        let first = message(.person, "Sample Blocked", id: "m1")
        let second = message(.person, "Sample Blocked", id: "m2")
        reveals.reveal("m1")
        XCTAssertFalse(reveals.collapses(first, in: conversation(.group)))
        XCTAssertTrue(reveals.collapses(second, in: conversation(.group)))
    }

    private func message(_ author: MessageAuthor, _ name: String, owner: String? = nil, kind: String? = nil, id: String = "m1") -> ChatMessage {
        ChatMessage(
            id: id, conversationId: "group:sample", author: author, authorName: name, senderOwnerName: owner,
            text: "Hello", createdAt: Date(), deliveryState: .read, errorMessage: nil, requestMessageId: nil,
            messageKind: kind
        )
    }

    private func conversation(_ kind: ConversationKind) -> ConversationSummary {
        ConversationSummary(
            id: "\(kind.rawValue):sample", kind: kind,
            peerAccountId: kind == .person ? "acct_blocked" : "acct_friend",
            agentId: nil, ownerDisplayName: nil, displayName: "Sample Blocked", lastMessage: "",
            lastActivityAt: Date(), unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: "session:sample",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: nil),
                CloudGroupParticipant(accountId: "acct_blocked", displayName: "Sample Blocked", avatarUrl: nil, role: nil),
                CloudGroupParticipant(accountId: "acct_friend", displayName: "Sample Friend", avatarUrl: nil, role: nil),
            ]
        )
    }
}
