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
}
