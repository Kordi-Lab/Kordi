import XCTest
@testable import Kordi

final class ForwardLabelTests: XCTestCase {
    private func source(kind: String?, label: String = "Scout") -> MessageActionSource {
        MessageActionSource(
            sourceSessionId: "session:group:g1", sourceMessageId: "m1", sourceMessageKind: kind,
            senderLabel: label, textPreview: "Plan", attachmentCount: 0
        )
    }

    private func message(_ author: MessageAuthor) -> ChatMessage {
        ChatMessage(
            id: "m1", conversationId: "group:g1", author: author, authorName: "Scout", text: "Plan",
            createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil, requestMessageId: nil
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
}
