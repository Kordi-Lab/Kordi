import XCTest
@testable import Kordi

final class MessageAccessibilityLabelTests: XCTestCase {
    private func message(_ author: MessageAuthor, name: String, owner: String? = nil) -> ChatMessage {
        ChatMessage(
            id: "m1", conversationId: "group:g1", author: author, authorName: name, senderOwnerName: owner,
            text: "Lunch is at noon.", createdAt: .distantPast, deliveryState: .delivered,
            errorMessage: nil, requestMessageId: nil
        )
    }

    func testAgentMessagesReadAsTheirOwnersAIAgent() {
        XCTAssertEqual(
            AgentMessageLabels.accessibilityAuthor(for: message(.agent, name: "Scout", owner: "Olive"), isPip: false),
            "Scout, AI agent of Olive"
        )
        XCTAssertEqual(
            AgentMessageLabels.accessibilityAuthor(for: message(.agent, name: "Kordi", owner: "  "), isPip: false),
            "Kordi, AI agent"
        )
    }

    func testPiPReadsAsKordisBuiltInAIAgent() {
        XCTAssertEqual(
            AgentMessageLabels.accessibilityAuthor(for: message(.person, name: "PiP"), isPip: true),
            "PiP, Kordi's built-in AI agent"
        )
    }

    func testPeopleKeepTheirNames() {
        XCTAssertEqual(AgentMessageLabels.accessibilityAuthor(for: message(.person, name: "Riley"), isPip: false), "Riley")
        XCTAssertEqual(AgentMessageLabels.accessibilityAuthor(for: message(.me, name: "You"), isPip: false), "You")
        // A person who happens to be called PiP is not labeled as AI without PiP's identity.
        XCTAssertEqual(AgentMessageLabels.accessibilityAuthor(for: message(.person, name: "PiP"), isPip: false), "PiP")
    }

    func testPiPIsRecognizedByItsAccountBeforeItsName() {
        let pip = message(.person, name: "PiP")
        XCTAssertTrue(AgentMessageLabels.isPip(pip, avatarSeed: KordiPipIdentity.accountId))
        XCTAssertTrue(AgentMessageLabels.isPip(message(.person, name: "Plan helper"), avatarSeed: KordiPipIdentity.accountId))
        XCTAssertTrue(AgentMessageLabels.isPip(pip, avatarSeed: nil))
        // A member who named themselves PiP keeps their own account seed.
        XCTAssertFalse(AgentMessageLabels.isPip(pip, avatarSeed: "acct_member"))
        XCTAssertFalse(AgentMessageLabels.isPip(message(.me, name: "PiP"), avatarSeed: KordiPipIdentity.accountId))
        XCTAssertFalse(AgentMessageLabels.isPip(message(.agent, name: "PiP"), avatarSeed: KordiPipIdentity.accountId))
    }

    func testTheThreadsHeaderShowsTheSameMarksAsTheChatLayout() {
        XCTAssertEqual(ThreadMessageHeader.mark(for: message(.agent, name: "Scout", owner: "Olive"), avatarSeed: "cloud_agent_scout"), .ai)
        XCTAssertEqual(ThreadMessageHeader.mark(for: message(.agent, name: "PiP"), avatarSeed: KordiPipIdentity.agentId), .ai)
        XCTAssertEqual(ThreadMessageHeader.mark(for: message(.person, name: "Plan helper"), avatarSeed: KordiPipIdentity.accountId), .pip)
        XCTAssertEqual(ThreadMessageHeader.mark(for: message(.person, name: "PiP"), avatarSeed: nil), .pip)
        XCTAssertNil(ThreadMessageHeader.mark(for: message(.person, name: "Riley"), avatarSeed: "acct_riley"))
        // A member who named themselves PiP gets no mark, as in the Chat layout.
        XCTAssertNil(ThreadMessageHeader.mark(for: message(.person, name: "PiP"), avatarSeed: "acct_member"))
        XCTAssertNil(ThreadMessageHeader.mark(for: message(.me, name: "You"), avatarSeed: KordiPipIdentity.accountId))
    }

    func testTheChipNeverReliesOnColor() {
        XCTAssertEqual(AgentMessageLabels.chipText, "AI")
        XCTAssertEqual(AgentMessageLabels.chipAccessibilityLabel, "AI agent, about this reply")
        XCTAssertEqual(KordiPipIdentity.tag, "Built-in AI agent")
    }
}
