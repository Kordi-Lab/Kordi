import XCTest
@testable import Kordi

final class PinnedMessageStackTests: XCTestCase {
    func testLegacyPinsAndExplicitEmptyArraysDecode() throws {
        let legacy = try JSONDecoder().decode(CloudSessionPin.self, from: Data(#"{"sessionId":"chat","sharedMessageId":"one","privateMessageId":null,"effectiveMessageId":"one","updatedAt":null}"#.utf8))
        XCTAssertEqual(legacy.messageIDs(scope: "shared"), ["one"])
        var cleared = legacy
        cleared.sharedMessageIds = []
        XCTAssertEqual(cleared.visibleMessageIDs, [])
        XCTAssertEqual(cleared.recording(nil).sharedMessageIds, [])
    }

    @MainActor
    func testTargetedUnpinSyncKeepsRemainingPinsAndItsActionTarget() throws {
        let initial = CloudSessionPin(sessionId: "chat", sharedMessageId: "three", privateMessageId: "personal",
            effectiveMessageId: "personal", updatedAt: "2026-09-15T10:00:00Z",
            sharedMessageIds: ["one", "two", "three"], privateMessageIds: ["personal"])
        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: Data(#"{"eventId":"remove-two","eventType":"session.pin.updated","messageId":"three","occurredAt":"2026-09-15T10:01:00Z","payload":{"sessionId":"chat","scope":"shared","messageId":"three","messageIds":["one","three"],"targetMessageId":"two","kind":"unpinned","updatedAt":"2026-09-15T10:01:00Z","updatedByAccountId":"owner"}}"#.utf8))
        let updated = try XCTUnwrap(AppModel.applyingSessionPinEvents([event], to: ["chat": initial])["chat"])
        XCTAssertEqual(updated.sharedMessageIds, ["one", "three"])
        XCTAssertEqual(updated.privateMessageIds, ["personal"])
        XCTAssertEqual(updated.lastAction?.kind, "unpinned")
        XCTAssertEqual(updated.lastAction?.messageId, "two")
        XCTAssertEqual(updated.history?.first?.messageId, "two")
        XCTAssertEqual(try JSONDecoder().decode(CloudSessionPin.self, from: JSONEncoder().encode(updated)), updated)
    }

    func testUnloadedPinsStayNavigableAndDuplicateScopesAppearOnce() {
        let pin = CloudSessionPin(sessionId: "chat", sharedMessageId: "shared", privateMessageId: "personal",
            effectiveMessageId: "personal", updatedAt: nil, sharedMessageIds: ["shared"], privateMessageIds: ["shared", "personal"])
        let items = PinnedMessageItem.make(pin: pin, conversationID: "conversation", messagesByID: [:])
        XCTAssertEqual(items.map(\.message.id), ["shared", "personal"])
        XCTAssertEqual(items.map(\.scope), ["shared", "private"])
        XCTAssertEqual(items.first?.message.text, "Pinned message")
    }

    @MainActor
    func testPreviewLimitsFivePinsAndUnpinsOnlyOne() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(model.conversations.first(where: { $0.kind == .group }))
        let messages = (0..<6).map { index in
            ChatMessage(id: "stack-\(index)", conversationId: conversation.id, author: .person,
                authorName: "Peer", text: "Message \(index)", createdAt: .distantPast,
                deliveryState: .sent, errorMessage: nil, requestMessageId: nil)
        }
        for message in messages.prefix(5) {
            let pinned = await model.pin(message, in: conversation, shared: true)
            XCTAssertTrue(pinned)
        }
        let sixth = await model.pin(messages[5], in: conversation, shared: false)
        XCTAssertFalse(sixth)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.visibleMessageIDs.count, 5)
        let removed = await model.unpin(messages[2], in: conversation, scope: "shared")
        XCTAssertTrue(removed)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.messageIDs(scope: "shared"), ["stack-0", "stack-1", "stack-3", "stack-4"])
        let added = await model.pin(messages[5], in: conversation, shared: false)
        XCTAssertTrue(added)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.visibleMessageIDs.count, 5)
    }
}
