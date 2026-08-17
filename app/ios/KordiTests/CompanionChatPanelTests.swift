import XCTest
@testable import Kordi

final class CompanionChatPanelTests: XCTestCase {
    func testEmojiInsertionUsesTheCurrentUTF16Caret() {
        let replacement = replacingComposerText(
            "Hi world",
            selection: ComposerTextSelection(location: 3, length: 0),
            with: "👋"
        )

        XCTAssertEqual(replacement.text, "Hi 👋world")
        XCTAssertEqual(replacement.selection, ComposerTextSelection(location: 5, length: 0))
    }

    func testEmojiInsertionReplacesTheSelectedText() {
        let replacement = replacingComposerText(
            "Ship later",
            selection: ComposerTextSelection(location: 5, length: 5),
            with: "🚀"
        )

        XCTAssertEqual(replacement.text, "Ship 🚀")
        XCTAssertEqual(replacement.selection, ComposerTextSelection(location: 7, length: 0))
    }

    func testEmojiInsertionClampsAStaleSelectionAfterTextIsCleared() {
        let replacement = replacingComposerText(
            "",
            selection: ComposerTextSelection(location: 20, length: 4),
            with: "✨"
        )

        XCTAssertEqual(replacement.text, "✨")
        XCTAssertEqual(replacement.selection, ComposerTextSelection(location: 1, length: 0))
    }

    func testContactChatSuggestsTheMostRecentAgentSession() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let olderAgent = conversation(
            id: "older-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 10)
        )
        let newerAgent = conversation(
            id: "newer-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 20)
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source, olderAgent, newerAgent],
            ownAccountID: "acct_me"
        )

        XCTAssertEqual(suggestion?.id, newerAgent.id)
    }

    func testAgentChatStartsAFreshSessionForTheSameAgent() {
        let source = conversation(
            id: "active-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 20)
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source],
            ownAccountID: "acct_me",
            randomID: "companion-test",
            now: Date(timeIntervalSince1970: 40)
        )

        XCTAssertEqual(suggestion?.id, "agent-session:session:self-agent:companion-test")
        XCTAssertEqual(suggestion?.agentId, source.agentId)
        XCTAssertNotEqual(suggestion?.sessionId, source.sessionId)
    }

    func testContactChatStartsAFreshSessionWhenOnlyAnAgentTemplateExists() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let template = ConversationSummary(
            id: "agent-template:session:self-agent:default",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "My Kordi",
            lastMessage: "Your private cloud agent",
            lastActivityAt: Date(timeIntervalSince1970: 20),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:self-agent:default",
            agentDisplayName: "My Kordi"
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source, template],
            ownAccountID: "acct_me",
            randomID: "empty-state",
            now: Date(timeIntervalSince1970: 40)
        )
        let existing = CompanionPanelCatalog.existingSessions(
            excluding: source,
            conversations: [source, template],
            ownAccountID: "acct_me"
        )

        XCTAssertEqual(suggestion?.id, "agent-session:session:self-agent:empty-state")
        XCTAssertEqual(suggestion?.displayName, "My Kordi")
        XCTAssertEqual(existing, [])
    }

    func testContactChatStartsDefaultAgentSessionWithoutExistingAgentData() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source],
            ownAccountID: "acct_me",
            randomID: "provider-only",
            now: Date(timeIntervalSince1970: 40)
        )

        XCTAssertEqual(suggestion?.id, "agent-session:session:self-agent:provider-only")
        XCTAssertEqual(suggestion?.displayName, "My Kordi")
        XCTAssertEqual(suggestion?.peerAccountId, "acct_me")
    }

    func testExistingSessionMenuExcludesTheSourceAndOrdersByRecentActivity() {
        let source = conversation(
            id: "source",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let olderAgent = conversation(
            id: "older-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 10)
        )
        let newerAgent = conversation(
            id: "newer-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 20)
        )

        let sessions = CompanionPanelCatalog.existingSessions(
            excluding: source,
            conversations: [source, olderAgent, newerAgent],
            ownAccountID: "acct_me"
        )

        XCTAssertEqual(sessions.map(\.id), [newerAgent.id, olderAgent.id])
    }

    func testContextIncludesOnlyTheSixMostRecentReferenceLines() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 20)
        )
        let messages = (1...7).map { index in
            message(
                id: "message-\(index)",
                text: index == 7 ? String(repeating: "a", count: 260) : "Message \(index)",
                author: index.isMultiple(of: 2) ? .me : .person
            )
        }

        let context = CompanionChatContextBuilder.make(
            source: source,
            messages: messages,
            selfName: "Alex"
        )

        XCTAssertTrue(context.referenceText.contains("Reference: Current chat"))
        XCTAssertTrue(context.referenceText.contains("Session id: session:contact"))
        XCTAssertTrue(context.referenceText.contains("Participants: Alex, Contact"))
        XCTAssertFalse(context.referenceText.contains("Message 1"))
        XCTAssertTrue(context.referenceText.contains("Message 2"))
        XCTAssertTrue(context.referenceText.contains(String(repeating: "a", count: 239) + "…"))
    }

    func testAgentPromptCompositionDoesNotChangeTheVisibleRequestText() {
        let request = "Summarize the decisions"
        let context = "Reference: Current chat\nSession: Maya Chen"

        XCTAssertEqual(
            AgentPromptContext.compose(userText: request, referenceText: context),
            "\(context)\n\nRequest:\n\(request)"
        )
        XCTAssertEqual(
            AgentPromptContext.compose(userText: request, referenceText: nil),
            request
        )
    }

    private func conversation(
        id: String,
        kind: ConversationKind,
        date: Date
    ) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: kind,
            peerAccountId: kind == .agent ? "acct_me" : "acct_contact",
            agentId: kind == .agent ? "agent_research" : nil,
            ownerDisplayName: kind == .agent ? "Alex" : "Contact",
            displayName: kind == .agent ? "Research session" : "Contact",
            lastMessage: "Latest message",
            lastActivityAt: date,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: kind == .agent ? .ready : nil,
            sessionId: "session:\(id)",
            agentDisplayName: kind == .agent ? "Research Agent" : nil
        )
    }

    private func message(
        id: String,
        text: String,
        author: MessageAuthor
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: "contact",
            author: author,
            authorName: author == .me ? "You" : "Contact",
            text: text,
            createdAt: Date(),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil
        )
    }
}
