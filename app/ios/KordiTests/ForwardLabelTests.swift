import XCTest
@testable import Kordi

final class ForwardLabelTests: XCTestCase {
    private func source(kind: String?, label: String = "Scout") -> MessageActionSource {
        MessageActionSource(
            sourceSessionId: "session:group:g1", sourceMessageId: "m1", sourceMessageKind: kind,
            senderLabel: label, textPreview: "Plan", attachmentCount: 0
        )
    }

    private func message(_ author: MessageAuthor, name: String = "Scout") -> ChatMessage {
        ChatMessage(
            id: "m1", conversationId: "group:g1", author: author, authorName: name, text: "Plan",
            createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil, requestMessageId: nil
        )
    }

    private func group(_ people: [String]) -> ConversationSummary {
        ConversationSummary(
            id: "group:g1", kind: .group, peerAccountId: "", agentId: nil, ownerDisplayName: nil,
            displayName: "Weekend", lastMessage: "", lastActivityAt: .distantPast, unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "session:group:g1",
            groupParticipants: people.map {
                CloudGroupParticipant(accountId: "acct_\($0.lowercased())", displayName: $0, avatarUrl: nil, role: "member")
            }
        )
    }

    func testForwardsOfAgentRepliesSayAI() {
        XCTAssertEqual(AgentMessageLabels.forwardedFrom(source(kind: "agent-turn")), "Forwarded from Scout (AI)")
        XCTAssertEqual(AgentMessageLabels.forwardedFrom(source(kind: "text", label: "Riley")), "Forwarded from Riley")
        XCTAssertEqual(AgentMessageLabels.forwardedFrom(source(kind: nil, label: "Riley")), "Forwarded from Riley")
    }

    func testQuotesPreferTheLoadedSourceMessage() {
        XCTAssertEqual(
            AgentMessageLabels.quotedSender("Scout", source: source(kind: "text"), resolvedSource: message(.agent)),
            "Scout (AI)"
        )
        XCTAssertEqual(
            AgentMessageLabels.quotedSender("Scout", source: source(kind: "agent-turn"), resolvedSource: message(.person)),
            "Scout"
        )
        XCTAssertEqual(
            AgentMessageLabels.quotedSender("Scout", source: source(kind: "agent-turn"), resolvedSource: nil),
            "Scout (AI)"
        )
        XCTAssertEqual(AgentMessageLabels.quotedSender("Riley", source: source(kind: nil), resolvedSource: nil), "Riley")
    }

    func testOutgoingQuotesAndForwardsDeclareTheSourceKind() {
        XCTAssertEqual(message(.agent).actionSource(sessionId: "session:group:g1").sourceMessageKind, "agent-turn")
        XCTAssertEqual(message(.person).actionSource(sessionId: "session:group:g1").sourceMessageKind, "text")
        XCTAssertEqual(message(.me).forwardSource(sessionId: "session:group:g1").sourceMessageKind, "text")
        // Forwarding a forwarded agent reply keeps the original declaration.
        var forwarded = message(.person)
        forwarded.messageAction = .forward(source(kind: "agent-turn"))
        XCTAssertEqual(forwarded.forwardSource(sessionId: "session:group:g2").sourceMessageKind, "agent-turn")
        XCTAssertEqual(AgentMessageLabels.forwardedFrom(forwarded.forwardSource(sessionId: "session:group:g2")), "Forwarded from Scout (AI)")
    }

    func testPiPMessagesAreDeclaredAndShownAsAI() {
        let pip = message(.person, name: "PiP")
        let chat = group(["Riley", "Olive"])
        XCTAssertTrue(AgentMessageLabels.isPip(pip, in: chat))
        XCTAssertEqual(
            pip.actionSource(sessionId: "session:group:g1", isPip: true).sourceMessageKind,
            "agent-turn"
        )
        XCTAssertEqual(
            AgentMessageLabels.forwardedFrom(pip.forwardSource(sessionId: "session:group:g1", isPip: true)),
            "Forwarded from PiP (AI)"
        )
        XCTAssertEqual(
            MessageThreadProjection.rootSource(for: pip, sessionID: "session:group:g1", isPip: true).sourceMessageKind,
            "agent-turn"
        )
        XCTAssertEqual(
            AgentMessageLabels.quotedSender(
                "PiP", source: source(kind: "text", label: "PiP"), resolvedSource: pip, resolvedSourceIsPip: true
            ),
            "PiP (AI)"
        )
        // A person who happens to be named PiP is a person, and so is anyone
        // in a direct chat.
        XCTAssertFalse(AgentMessageLabels.isPip(pip, in: group(["PiP", "Riley"])))
        XCTAssertFalse(AgentMessageLabels.isPip(message(.person, name: "Riley"), in: chat))
        XCTAssertFalse(AgentMessageLabels.isPip(message(.me, name: "PiP"), in: chat))
        XCTAssertEqual(pip.actionSource(sessionId: "session:group:g1").sourceMessageKind, "text")
    }
}
