import XCTest
import Testing
@testable import Kordi

@MainActor struct GroupWaitingProjectionTests {
    let now = Date(timeIntervalSince1970: 2_000)
    var conversation: ConversationSummary {
        ConversationSummary(
            id: "group:team", kind: .group, peerAccountId: "acct_owner", agentId: nil,
            ownerDisplayName: "Team", displayName: "Team", lastMessage: "", lastActivityAt: now,
            unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:group:team",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_owner", displayName: "Owner", avatarUrl: nil, role: "member"),
                CloudGroupParticipant(accountId: "acct_sender", displayName: "Sender", avatarUrl: nil, role: "owner")
            ]
        )
    }
    func request(author: MessageAuthor = .me, sourceHostID: String? = nil) -> ChatMessage {
        ChatMessage(
            id: "request", conversationId: conversation.id, conversationSequence: 10,
            author: author, authorName: "Sender", text: "@Researcher hello", createdAt: now.addingTimeInterval(-1),
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil,
            mentions: [MessageMention(label: "Researcher", targetKind: "agent", targetIdentityId: "agent:cloud-agent:acct_owner",
                sourceHostId: sourceHostID, humanId: "acct_owner", agentId: "cloud-agent:acct_owner", displayLabel: "Researcher")]
        )
    }

    @Test(arguments: [nil, "", "cloud", " cloud ", "another-host"] as [String?])
    func waitingPreservesExplicitHostScope(sourceHostID: String?) {
        let request = request(sourceHostID: sourceHostID)
        let rows = CloudGroupAgentLifecycleProjector.withPendingRequests([request], conversation: conversation, now: now)
        #expect(rows.count == (sourceHostID == "another-host" ? 1 : 2))
    }

    @Test(arguments: [MessageAuthor.me, .person])
    func syncedRequestsShowOneWaitingBubbleForSenderAndOtherMembers(author: MessageAuthor) throws {
        let request = request(author: author)
        let rows = CloudGroupAgentLifecycleProjector.withPendingRequests([request], conversation: conversation, now: now)
        let pending = try #require(rows.last)
        #expect(rows.count == 2 && rows.first?.id == request.id)
        #expect(pending.authorName == "Researcher" && pending.senderOwnerName == "Owner")
        #expect(pending.requestMessageId == request.id && pending.quotedReplyMessageId == request.id)
        let execution = try #require(pending.agentExecution)
        #expect(MessageBubble.showsAgentWaitingIndicator(execution: execution, responseText: pending.text))
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests(rows, conversation: conversation, now: now) == rows)
    }

    @Test(arguments: [CloudAgentLifecycleState.processing, .complete, .failed, .cancelled])
    func realResponseReplacesWaitingWithoutRegressingAfterPartialSync(state: CloudAgentLifecycleState) throws {
        let request = request()
        let response = ChatMessage(id: "response", conversationId: conversation.id, author: .agent,
            authorName: "Researcher", text: state == .processing ? "" : "Done", createdAt: now,
            deliveryState: state == .failed ? .failed : state == .cancelled ? .cancelled : .delivered,
            errorMessage: nil, requestMessageId: request.id,
            agentExecution: CloudMessageCodec.agentWaitingExecution(deliveryState: state, updatedAtMs: 2_000_000))
        let stored = [request, response]
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests(stored, conversation: conversation, now: now) == stored)
        let partial = AppModel.mergePartialProjection([request], preserving: stored)
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests(partial, conversation: conversation, now: now).count == 2)
    }

    @Test func oldFailedForwardedAndUntargetedMessagesNeverCreateWaiting() {
        let original = request()
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests([original], conversation: conversation, now: now.addingTimeInterval(601)) == [original])
        var failed = original
        failed.deliveryState = .failed
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests([failed], conversation: conversation, now: now) == [failed])
        var forwarded = original
        forwarded.messageAction = MessageActionMetadata(schemaVersion: 1, kind: "forward", source: original.actionSource)
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests([forwarded], conversation: conversation, now: now) == [forwarded])
        var plain = original
        plain.mentions = []
        #expect(CloudGroupAgentLifecycleProjector.withPendingRequests([plain], conversation: conversation, now: now) == [plain])
    }
}

final class CloudMessageStateProjectorTests: XCTestCase {
    func testAuthoritativeHistoryPagePrunesOnlyMissingMessagesInItsWindow() {
        let sessionId = "session:group:one"
        let earlier = wire(
            id: "earlier",
            from: "acct_me",
            to: "acct_peer",
            sessionId: sessionId,
            conversationSequence: 40
        )
        let live = wire(
            id: "live",
            from: "acct_me",
            to: "acct_peer",
            sessionId: sessionId,
            conversationSequence: 41
        )
        let deleted = wire(
            id: "deleted",
            from: "acct_me",
            to: "acct_peer",
            sessionId: sessionId,
            conversationSequence: 42
        )
        let otherSession = wire(
            id: "other-session",
            from: "acct_me",
            to: "acct_peer",
            sessionId: "session:group:other",
            conversationSequence: 42
        )

        let missing = AppModel.cloudMessageIDsMissingFromHistoryPage(
            [earlier, live, deleted, otherSession],
            page: CloudConversationMessagePage(
                messages: [live],
                nextBeforeSequence: 41,
                hasMore: true
            ),
            sessionId: sessionId,
            beforeSequence: nil
        )

        XCTAssertEqual(missing, ["deleted"])
    }

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

    func testGroupReceiptUsesCanonicalReadersInsteadOfTheFirstPeer() throws {
        let body = try groupBody(messageId: "group-message")
        let message = wire(
            id: "canonical-message",
            from: "acct_me",
            to: "acct_a",
            body: body,
            readAt: "2026-08-08T10:01:00Z",
            readByAccountIds: ["acct_b"]
        )

        let summary = CloudMessageStateProjector.groupDeliverySummary(
            messageId: "group-message",
            messages: [message],
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(summary?.state, .read)
        XCTAssertEqual(summary?.readByAccountIds, ["acct_b"])
    }

    func testLocalReadProjectionOnlyMarksTheOpenedSession() {
        let target = wire(
            id: "target",
            clientMessageId: "client-target",
            from: "acct_peer",
            to: "acct_me",
            sessionId: "session:one",
            conversationId: "conversation-one",
            conversationSequence: 42
        )
        let other = wire(id: "other", from: "acct_peer", to: "acct_me", sessionId: "session:two")

        let projected = CloudMessageStateProjector.markingIncomingRead(
            ["acct_peer": [target, other]],
            ownAccountId: "acct_me",
            scope: .session("session:one"),
            readAt: "2026-08-08T10:02:00Z"
        )["acct_peer"]

        XCTAssertEqual(projected?.first(where: { $0.messageId == "target" })?.readAt, "2026-08-08T10:02:00Z")
        XCTAssertEqual(projected?.first(where: { $0.messageId == "target" })?.clientMessageId, "client-target")
        XCTAssertEqual(projected?.first(where: { $0.messageId == "target" })?.conversationId, "conversation-one")
        XCTAssertEqual(projected?.first(where: { $0.messageId == "target" })?.conversationSequence, 42)
        XCTAssertNil(projected?.first(where: { $0.messageId == "other" })?.readAt)
    }

    func testLocalReadProjectionStopsAtPresentedMentionSequence() {
        let first = wire(
            id: "first",
            from: "acct_peer",
            to: "acct_me",
            sessionId: "session:one",
            conversationId: "conversation-one",
            conversationSequence: 41
        )
        let later = wire(
            id: "later",
            from: "acct_peer",
            to: "acct_me",
            sessionId: "session:one",
            conversationId: "conversation-one",
            conversationSequence: 42
        )

        let projected = CloudMessageStateProjector.markingIncomingRead(
            ["acct_peer": [first, later]],
            ownAccountId: "acct_me",
            scope: .session("session:one"),
            readAt: "2026-08-08T10:02:00Z",
            throughSequence: 41
        )["acct_peer"]

        XCTAssertNotNil(projected?.first(where: { $0.messageId == "first" })?.readAt)
        XCTAssertNil(projected?.first(where: { $0.messageId == "later" })?.readAt)
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
        clientMessageId: String? = nil,
        from: String,
        to: String,
        body: String = "Hello",
        deliveredAt: String? = "2026-08-08T10:00:01Z",
        readAt: String? = nil,
        readByAccountIds: [String]? = nil,
        sessionId: String = "session:one",
        messageKind: String? = nil,
        conversationId: String? = nil,
        conversationSequence: Int64? = nil
    ) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            clientMessageId: clientMessageId,
            fromAccountId: from,
            toAccountId: to,
            body: body,
            createdAt: "2026-08-08T10:00:00Z",
            deliveredAt: deliveredAt,
            readAt: readAt,
            readByAccountIds: readByAccountIds,
            direction: from == "acct_me" ? "outgoing" : "incoming",
            sessionId: sessionId,
            messageKind: messageKind,
            conversationId: conversationId,
            conversationSequence: conversationSequence
        )
    }
}
