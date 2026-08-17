import XCTest
@testable import Kordi

final class CloudMessageStateProjectorTests: XCTestCase {
    func testLatestAgentModelChangeUsesConversationSequenceInsteadOfArrivalOrder() {
        let latest = wire(
            id: "latest",
            from: "acct_me",
            to: "acct_me",
            body: "Switched model to openai/gpt-5.6-luna",
            sessionId: "session:agent",
            messageKind: ChatMessage.agentModelChangeMessageKind,
            conversationSequence: 154
        )
        let stale = wire(
            id: "stale",
            from: "acct_me",
            to: "acct_me",
            body: "Switched model to anthropic/claude-opus-4-6",
            sessionId: "session:agent",
            messageKind: ChatMessage.agentModelChangeMessageKind,
            conversationSequence: 143
        )

        let result = CloudMessageStateProjector.latestAgentModelChanges(
            in: ["acct_me": [latest, stale]]
        )

        XCTAssertEqual(result.map(\.messageId), ["latest"])
    }

    func testLatestAgentModelChangeIgnoresAnotherOwnersRoute() {
        let own = wire(
            id: "own-route",
            from: "acct_me",
            to: "acct_peer",
            body: "Switched model to openai/gpt-5.6-sol",
            sessionId: "session:group:route",
            messageKind: ChatMessage.agentModelChangeMessageKind,
            conversationSequence: 10
        )
        let remote = wire(
            id: "remote-route",
            from: "acct_peer",
            to: "acct_me",
            body: "Switched model to anthropic/claude-opus-4-6",
            sessionId: "session:group:route",
            messageKind: ChatMessage.agentModelChangeMessageKind,
            conversationSequence: 11
        )

        let result = CloudMessageStateProjector.latestAgentModelChanges(
            in: ["acct_peer": [own, remote]],
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(result.map(\.messageId), ["own-route"])
    }

    func testLatestAgentModelChangeRecoversLegacyTextKindFromRuntimeRouteEnvelope() throws {
        var route = CloudModelRouting.empty
        route.defaultModel = "anthropic/claude-fable-5"
        route.defaultAuthProvider = "anthropic"
        route.defaultAuthChoice = "local-active-oauth"
        let body = try CloudMessageCodec.encodeDirect(
            text: "Switched model to anthropic/claude-fable-5",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil,
            agentRuntimeRoute: route
        )
        let legacy = wire(
            id: "legacy-route",
            from: "acct_me",
            to: "acct_me",
            body: body,
            sessionId: "session:agent",
            messageKind: "text",
            conversationSequence: 155
        )

        let result = CloudMessageStateProjector.latestAgentModelChanges(
            in: ["acct_me": [legacy]],
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(result.map(\.messageId), ["legacy-route"])
    }

    func testSuccessfulOutgoingMessagesMatchMacDeliveredAndReadStates() {
        let delivered = wire(id: "delivered", from: "acct_me", to: "acct_peer", deliveredAt: nil, readAt: nil)
        let read = wire(id: "read", from: "acct_me", to: "acct_peer", deliveredAt: nil, readAt: "2026-08-08T10:01:00Z")

        XCTAssertEqual(CloudMessageStateProjector.deliveryState(for: delivered, ownAccountId: "acct_me"), .delivered)
        XCTAssertEqual(CloudMessageStateProjector.deliveryState(for: read, ownAccountId: "acct_me"), .read)
    }

    func testGroupReceiptAggregatesFanoutCopiesLikeMac() throws {
        let body = try groupBody(messageId: "group-message")
        let messages = [
            wire(id: "to-a", from: "acct_me", to: "acct_a", body: body, readAt: "2026-08-08T10:01:00Z"),
            wire(id: "to-b", from: "acct_me", to: "acct_b", body: body, readAt: nil)
        ]

        let summary = CloudMessageStateProjector.groupDeliverySummary(
            messageId: "group-message",
            messages: messages,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(summary?.state, .read)
        XCTAssertEqual(summary?.readByAccountIds, ["acct_a"])
    }

    func testLocalReadProjectionOnlyMarksTheOpenedSession() {
        let target = wire(id: "target", from: "acct_peer", to: "acct_me", sessionId: "session:one")
        let other = wire(id: "other", from: "acct_peer", to: "acct_me", sessionId: "session:two")

        let projected = CloudMessageStateProjector.markingIncomingRead(
            ["acct_peer": [target, other]],
            ownAccountId: "acct_me",
            scope: .session("session:one"),
            readAt: "2026-08-08T10:02:00Z"
        )["acct_peer"]

        XCTAssertEqual(projected?.first(where: { $0.messageId == "target" })?.readAt, "2026-08-08T10:02:00Z")
        XCTAssertNil(projected?.first(where: { $0.messageId == "other" })?.readAt)
    }

    func testLocalReadProjectionIgnoresOutgoingCopies() {
        let outgoing = wire(
            id: "outgoing",
            from: "acct_me",
            to: "acct_peer",
            sessionId: "session:one"
        )

        let projected = CloudMessageStateProjector.markingIncomingRead(
            ["acct_peer": [outgoing]],
            ownAccountId: "acct_me",
            scope: .session("session:one"),
            readAt: "2026-08-08T10:02:00Z"
        )["acct_peer"]

        XCTAssertNil(projected?.first?.readAt)
    }

    private func groupBody(messageId: String) throws -> String {
        let me = CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "self")
        let peer = CloudGroupParticipant(accountId: "acct_a", displayName: "A", avatarUrl: nil, role: "person")
        return try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:one",
            groupSpaceId: "session:group:one",
            groupTitle: "Group",
            createdByAccountId: "acct_me",
            actor: me,
            participants: [me, peer],
            message: CloudGroupMessagePayload(
                id: messageId,
                senderAccountId: "acct_me",
                text: "Hello",
                createdAtMs: 1_786_180_800_000,
                senderKind: "human",
                senderDisplayName: "Me",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        ))
    }

    private func wire(
        id: String,
        from: String,
        to: String,
        body: String = "Hello",
        deliveredAt: String? = "2026-08-08T10:00:01Z",
        readAt: String? = nil,
        sessionId: String = "session:one",
        messageKind: String? = nil,
        conversationSequence: Int64? = nil
    ) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: from,
            toAccountId: to,
            body: body,
            createdAt: "2026-08-08T10:00:00Z",
            deliveredAt: deliveredAt,
            readAt: readAt,
            direction: from == "acct_me" ? "outgoing" : "incoming",
            sessionId: sessionId,
            messageKind: messageKind,
            conversationSequence: conversationSequence
        )
    }
}
