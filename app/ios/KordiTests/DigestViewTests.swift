import XCTest
@testable import Kordi

final class DigestViewTests: XCTestCase {
    func testMainDestinationsUseTheRequestedOrderWithoutFactory() {
        XCTAssertEqual(MainTab.contentTabs, [.contacts, .chats, .digest, .account])
        XCTAssertEqual(MainTab.contentTabs, MainTab.allCases)
        XCTAssertEqual(MainTab.account.symbol, "person")
    }

    func testDigestSummarizesMessageContentAcrossEverySession() {
        let recent = conversation(id: "recent", activityAt: 100)
        let working = conversation(id: "working", activityAt: 200, activity: .replying)
        let unread = conversation(id: "unread", activityAt: 300, unreadCount: 3)
        let failed = conversation(id: "failed", activityAt: 400, unreadCount: 1, activity: .failed)
        let messages = [
            recent.id: [message(id: "recent-message", conversation: recent, text: "Release notes are complete.")],
            working.id: [message(id: "working-message", conversation: working, text: "Comparing the device results.", author: .agent)],
            unread.id: [message(id: "unread-message", conversation: unread, text: "Please review the latest numbers.", author: .person)],
            failed.id: [message(id: "failed-message", conversation: failed, text: "Upload the final build.", state: .failed)],
        ]

        let digest = DigestCatalog.snapshot(
            from: [recent, unread, working, failed],
            messagesByConversation: messages
        )

        XCTAssertEqual(digest.unreadMessageCount, 4)
        XCTAssertEqual(digest.failedSessionCount, 1)
        XCTAssertEqual(digest.activeAgentCount, 1)
        XCTAssertEqual(digest.conversationCount, 4)
        XCTAssertEqual(digest.summarizedConversationCount, 4)
        XCTAssertEqual(digest.messageCount, 4)
        XCTAssertTrue(digest.summaryText.contains("all 4 sessions"))
        XCTAssertEqual(digest.todoItems.map(\.references.first?.message.id), ["unread-message"])
        XCTAssertEqual(digest.activeAgentItems.map(\.references.first?.message.id), ["working-message"])
        XCTAssertEqual(digest.attentionItems.map(\.references.first?.message.id), ["failed-message"])
    }

    func testDigestReferencesRouteToTheExactSourceMessage() throws {
        let conversation = conversation(id: "source", activityAt: 100, unreadCount: 1)
        let older = message(id: "older", conversation: conversation, text: "Earlier context.", author: .person)
        let source = message(id: "exact-source", conversation: conversation, text: "Please approve the release.", author: .person, offset: 20)

        let digest = DigestCatalog.snapshot(
            from: [conversation],
            messagesByConversation: [conversation.id: [older, source]]
        )
        let reference = try XCTUnwrap(digest.todoItems.first?.references.first)

        XCTAssertEqual(reference.excerpt, "Please approve the release.")
        XCTAssertEqual(reference.route.conversation.id, conversation.id)
        XCTAssertEqual(reference.route.messageID, source.id)
    }

    func testDigestReferenceSectionsKeepNewestMessagesFirst() {
        let olderUnread = conversation(id: "older-unread", activityAt: 100, unreadCount: 1)
        let newerUnread = conversation(id: "newer-unread", activityAt: 200, unreadCount: 1)
        let olderWorking = conversation(id: "older-working", activityAt: 300, activity: .replying)
        let newerWorking = conversation(id: "newer-working", activityAt: 400, activity: .replying)
        let conversations = [olderUnread, newerWorking, newerUnread, olderWorking]
        let messages = Dictionary(uniqueKeysWithValues: conversations.map { conversation in
            (conversation.id, [message(
                id: "message-\(conversation.id)",
                conversation: conversation,
                text: "Update from \(conversation.id).",
                author: conversation.agentActivity == nil ? .person : .agent
            )])
        })

        let digest = DigestCatalog.snapshot(
            from: conversations,
            messagesByConversation: messages
        )

        XCTAssertEqual(
            digest.todoItems.map(\.references.first?.conversation.id),
            ["newer-unread", "older-unread"]
        )
        XCTAssertEqual(
            digest.activeAgentItems.map(\.references.first?.conversation.id),
            ["newer-working", "older-working"]
        )
    }

    private func conversation(
        id: String,
        activityAt: TimeInterval,
        unreadCount: Int = 0,
        activity: AgentActivity? = nil
    ) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: activity == nil ? .person : .agent,
            peerAccountId: "account-\(id)",
            agentId: activity == nil ? nil : "agent-\(id)",
            ownerDisplayName: "Owner",
            displayName: id,
            lastMessage: "Latest update",
            lastActivityAt: Date(timeIntervalSince1970: activityAt),
            unreadCount: unreadCount,
            avatarSource: nil,
            agentActivity: activity,
            sessionId: "session-\(id)"
        )
    }

    private func message(
        id: String,
        conversation: ConversationSummary,
        text: String,
        author: MessageAuthor = .me,
        state: MessageDeliveryState = .delivered,
        offset: TimeInterval = 0
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: conversation.id,
            author: author,
            authorName: author == .me ? "You" : conversation.displayName,
            text: text,
            createdAt: conversation.lastActivityAt.addingTimeInterval(offset),
            deliveryState: state,
            errorMessage: state == .failed ? "The message could not be delivered." : nil,
            requestMessageId: nil
        )
    }
}
