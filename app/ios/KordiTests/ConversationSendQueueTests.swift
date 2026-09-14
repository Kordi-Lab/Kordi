import XCTest
@testable import Kordi

@MainActor
final class ConversationSendQueueTests: XCTestCase {
    func testDeliveryWaitsOnlyForItsConversation() async {
        let queue = ConversationSendQueue()
        await queue.acquire("a")
        var acquiredSecond = false
        let waiting = Task { @MainActor in
            await queue.acquire("a")
            acquiredSecond = true
            queue.release("a")
        }
        await queue.acquire("b")
        XCTAssertFalse(acquiredSecond)
        queue.release("b")
        queue.release("a")
        await waiting.value
        XCTAssertTrue(acquiredSecond)
        await queue.acquire("a")
        queue.release("a")
    }

    func testInvalidSendReleasesComposerExactlyOnce() async {
        let model = AppModel(previewMode: true)
        let conversation = model.conversations.first!
        var callbacks = 0
        await model.send("", to: conversation, onStaged: { id in
            XCTAssertNil(id)
            callbacks += 1
        })
        XCTAssertEqual(callbacks, 1)
    }

    func testStagingExposesOptimisticMessageBeforeDelivery() async {
        let model = AppModel(previewMode: true)
        let conversation = model.conversations.first { $0.kind == .person }!
        var callbacks = 0
        await model.send("Rapid send fixture", to: conversation, onStaged: { id in
            callbacks += 1
            XCTAssertNotNil(id)
            let message = model.messagesByConversation[conversation.id]?.first { $0.clientMessageId == id }
            XCTAssertEqual(message?.deliveryState, .sending)
            XCTAssertEqual(message?.text, "Rapid send fixture")
        })
        XCTAssertEqual(callbacks, 1)
    }

    func testPendingSendsStayAfterConfirmedMessagesWithAnOlderDeviceClock() {
        let model = AppModel(previewMode: true)
        let conversation = orderingConversation()
        let confirmed = orderingMessage("confirmed", sequence: 40, time: 100, state: .delivered)
        let first = orderingMessage("draft-first", clientID: "first", time: 1, state: .sending)
        let second = orderingMessage("draft-second", clientID: "second", time: 2, state: .sending)
        [confirmed, first, second].forEach(model.upsertPreviewMessage)

        XCTAssertEqual(model.messages(for: conversation).map(\.id), ["confirmed", "draft-first", "draft-second"])

        let acknowledged = orderingMessage("server-first", clientID: "first", sequence: 41, time: 101, state: .delivered)
        let reconciled = AppModel.mergePartialProjection([acknowledged], preserving: [confirmed, first, second])
        let acknowledgedModel = AppModel(previewMode: true)
        reconciled.forEach(acknowledgedModel.upsertPreviewMessage)
        XCTAssertEqual(acknowledgedModel.messages(for: conversation).map(\.id), ["confirmed", "server-first", "draft-second"])
        XCTAssertEqual(acknowledgedModel.messages(for: conversation).last?.deliveryState, .sending)
    }

    func testPendingTailKeepsImportedHistoryInItsOriginalChronology() {
        let model = AppModel(previewMode: true)
        let conversation = orderingConversation()
        let history = orderingMessage("imported-history", sequence: 90, time: 50, state: .read)
        let confirmed = orderingMessage("confirmed", sequence: 40, time: 100, state: .delivered)
        let pending = orderingMessage("draft", time: 1, state: .sending)
        [confirmed, pending, history].forEach(model.upsertPreviewMessage)

        let displayed = model.messages(for: conversation)
        XCTAssertEqual(displayed.map(\.id), ["imported-history", "confirmed", "draft"])
        XCTAssertEqual(displayed.first?.createdAt, history.createdAt)
    }

    func testPendingAgentPresentationRemainsAfterItsUnconfirmedRequest() {
        for kind in [ConversationKind.group, .agent] {
            let model = AppModel(previewMode: true)
            let conversation = orderingConversation(kind: kind)
            let confirmed = orderingMessage("confirmed", sequence: 40, time: 100, state: .delivered)
            let pending = orderingMessage("draft", clientID: "draft-client", time: 1, state: .sending)
            let progress = orderingMessage("progress", time: 1.001, state: .delivered,
                author: .agent, requestID: "draft-client")
            [pending, progress, confirmed].forEach(model.upsertPreviewMessage)

            XCTAssertEqual(model.messages(for: conversation).map(\.id), ["confirmed", "draft", "progress"])
        }
    }

    func testOlderFailureDoesNotMoveAfterNewAcknowledgedMessages() {
        let failed = orderingMessage("failed", time: 2, state: .failed)
        let later = orderingMessage("later", sequence: 41, time: 3, state: .delivered)
        XCTAssertEqual(ConversationMessageOrdering.displayMessages([later, failed]).map(\.id), ["failed", "later"])
    }

    func testAnchoredFailureRetainsItsPlaceAcrossRetryAndAcknowledgement() {
        let confirmed = orderingMessage("confirmed", sequence: 40, time: 100, state: .delivered)
        var draft = orderingMessage("draft", clientID: "draft-client", time: 1, state: .failed)
        draft.localTimelineAnchorID = "confirmed"
        var newer = orderingMessage("new", clientID: "new-client", time: 2, state: .sending)
        newer.localTimelineAnchorID = "draft-client"
        for state in [MessageDeliveryState.failed, .sending] {
            draft.deliveryState = state
            XCTAssertEqual(ConversationMessageOrdering.displayMessages([newer, draft, confirmed]).map(\.id), ["confirmed", "draft", "new"])
        }
        let accepted = orderingMessage("server-new", clientID: "new-client", sequence: 41, time: 101, state: .delivered)
        XCTAssertEqual(ConversationMessageOrdering.displayMessages([accepted, draft, confirmed]).map(\.id), ["confirmed", "draft", "server-new"])
    }

    func testAnchorFollowsAcknowledgedClientIdentityAndSurvivesCacheRoundTrip() throws {
        let accepted = orderingMessage("server-first", clientID: "first-client", sequence: 41, time: 101, state: .delivered)
        var pending = orderingMessage("pending", time: 1, state: .sending)
        pending.localTimelineAnchorID = "first-client"
        let restored = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(pending))
        XCTAssertEqual(restored.localTimelineAnchorID, pending.localTimelineAnchorID)
        XCTAssertEqual(ConversationMessageOrdering.displayMessages([restored, accepted]).map(\.id), ["server-first", "pending"])
    }

    func testMissingAndCyclicAnchorsDoNotHideMessages() {
        var first = orderingMessage("first", time: 1, state: .failed)
        var second = orderingMessage("second", time: 2, state: .failed)
        first.localTimelineAnchorID = "second"
        second.localTimelineAnchorID = "first"
        XCTAssertEqual(Set(ConversationMessageOrdering.displayMessages([first, second]).map(\.id)), ["first", "second"])
        first.localTimelineAnchorID = "not-loaded"
        XCTAssertEqual(ConversationMessageOrdering.displayMessages([first]).map(\.id), ["first"])
    }

    func testFailedSendCanBeRemovedLocallyWithoutDeletingOtherMessages() async {
        let model = AppModel(previewMode: true)
        let conversation = orderingConversation()
        let failed = orderingMessage("failed", time: 1, state: .failed)
        let later = orderingMessage("later", sequence: 42, time: 2, state: .delivered)
        [failed, later].forEach(model.upsertPreviewMessage)
        let sharedDelete = await model.deleteMessage(failed, forEveryone: true, in: conversation)
        XCTAssertFalse(sharedDelete)
        let removed = await model.deleteMessage(failed, forEveryone: false, in: conversation)
        XCTAssertTrue(removed)
        XCTAssertEqual(model.messages(for: conversation).map(\.id), ["later"])
    }

    func testRemovingFailureReanchorsLaterPendingSends() async {
        let model = AppModel(previewMode: true)
        let confirmed = orderingMessage("confirmed", sequence: 40, time: 100, state: .delivered)
        var failed = orderingMessage("failed", clientID: "failed-client", time: 1, state: .failed)
        failed.localTimelineAnchorID = "confirmed"
        var pending = orderingMessage("pending", time: 2, state: .sending)
        pending.localTimelineAnchorID = "failed-client"
        [confirmed, failed, pending].forEach(model.upsertPreviewMessage)
        let removed = await model.deleteMessage(failed, forEveryone: false, in: orderingConversation())
        XCTAssertTrue(removed)
        XCTAssertEqual(model.messages(for: orderingConversation()).map(\.id), ["confirmed", "pending"])
        XCTAssertEqual(model.messages(for: orderingConversation()).last?.localTimelineAnchorID, "confirmed")
    }

    func testStaleFailedMessageCannotRemoveAnActiveRetry() async {
        let model = AppModel(previewMode: true)
        let failed = orderingMessage("retry", time: 1, state: .failed)
        var retry = failed
        retry.deliveryState = .sending
        model.upsertPreviewMessage(retry)
        let removed = await model.deleteMessage(failed, forEveryone: false, in: orderingConversation())
        XCTAssertFalse(removed)
        XCTAssertEqual(model.messages(for: orderingConversation()).first?.deliveryState, .sending)
    }

    private func orderingConversation(kind: ConversationKind = .person) -> ConversationSummary {
        ConversationSummary(id: "ordering-fixture", kind: kind, peerAccountId: "fixture-peer",
            agentId: nil, ownerDisplayName: nil, displayName: "Ordering fixture", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 100), unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "ordering-fixture")
    }

    private func orderingMessage(
        _ id: String, clientID: String? = nil, sequence: Int64? = nil, time: TimeInterval,
        state: MessageDeliveryState, author: MessageAuthor = .me, requestID: String? = nil
    ) -> ChatMessage {
        ChatMessage(id: id, clientMessageId: clientID, conversationId: "ordering-fixture",
            conversationSequence: sequence, author: author, authorName: "Fixture",
            text: "Synthetic ordering fixture", createdAt: Date(timeIntervalSince1970: time),
            deliveryState: state, errorMessage: nil, requestMessageId: requestID)
    }
}
