import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
final class ConversationScrollNavigationTests: XCTestCase {
    func testReceiptFilteringStillFollowsVisibleContentUpdates() {
        let original = ChatMessage(id: "fixture", conversationId: "fixture", author: .me,
            authorName: "Tester", text: "Hello", createdAt: Date(), deliveryState: .delivered,
            errorMessage: nil, requestMessageId: nil)
        var receipt = original
        receipt.deliveryState = .read; receipt.readByCount = 2; receipt.readByAccountIds = ["reader-a", "reader-b"]
        XCTAssertFalse(ConversationTimelineScrollBehavior.hasContentChange(original, receipt))
        var streamed = receipt; streamed.text += " world"
        XCTAssertTrue(ConversationTimelineScrollBehavior.hasContentChange(receipt, streamed))
        var failed = original; failed.deliveryState = .failed
        XCTAssertTrue(ConversationTimelineScrollBehavior.hasContentChange(original, failed))
    }

    func testReadReceiptDoesNotSnapTheNativeBottomOffset() async throws {
        let fixture = try await makeFixture()
        defer { fixture.close() }
        let target = ConversationTailScrollAnimator.targetOffset(in: fixture.scroll)
        fixture.scroll.setContentOffset(CGPoint(x: 0, y: target + 28), animated: false)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(fixture.scroll.contentOffset.y, target + 28, accuracy: 1)
        _ = await fixture.model.applyConversationHistoryPage(CloudConversationMessagePage(
            messages: fixture.wires(read: true), nextBeforeSequence: nil, hasMore: false),
            to: fixture.conversation, account: fixture.account,
            knownMessageIDs: fixture.model.knownHistoryMessageIDs(conversationID: fixture.conversation.id))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(ConversationTailScrollAnimator.targetOffset(in: fixture.scroll), target, accuracy: 1)
        XCTAssertEqual(fixture.scroll.contentOffset.y, target + 28, accuracy: 1,
            "A receipt must not interrupt a native bottom bounce with another tail command")
    }

    func testArrowNavigatesToLatestWithoutReversing() async throws {
        let fixture = try await makeFixture()
        defer { fixture.close() }
        fixture.scroll.setContentOffset(CGPoint(x: 0,
            y: ConversationTailScrollAnimator.targetOffset(in: fixture.scroll) / 3), animated: false)
        try await Task.sleep(for: .milliseconds(200))
        let start = fixture.scroll.contentOffset.y
        let jump = try XCTUnwrap(ConversationMotionProbeRegistry.goToLatest)
        jump()
        var intermediate = false
        var previousRows: [String: CGFloat] = [:]
        var visualReversal: CGFloat = 0
        var comparedRows = 0
        var previousCoverY: CGFloat?
        func cover(in view: UIView) -> UIView? {
            if view.accessibilityIdentifier == "conversation-jump-cover" { return view }
            return view.subviews.lazy.compactMap { cover(in: $0) }.first
        }
        for _ in 0..<120 {
            try await Task.sleep(for: .milliseconds(10))
            let displayed = fixture.scroll.layer.presentation()?.bounds.minY ?? fixture.scroll.contentOffset.y
            let target = ConversationTailScrollAnimator.targetOffset(in: fixture.scroll)
            intermediate = intermediate || (displayed > start + 1 && displayed < target - 1)
            if let snapshot = cover(in: fixture.window) {
                let opacity = snapshot.layer.presentation()?.opacity ?? Float(snapshot.alpha)
                intermediate = intermediate || (opacity > 0.01 && opacity < 0.99)
                if let image = snapshot.subviews.first, let layer = image.layer.presentation(),
                   let root = fixture.window.layer.presentation() {
                    let y = layer.convert(layer.bounds, to: root).minY
                    if let previousCoverY { visualReversal = max(visualReversal, y - previousCoverY) }
                    previousCoverY = y
                }
                // The opaque viewport intentionally covers destination measurement.
                // Compare destination rows only once they are actually revealed.
                if opacity >= 0.99 { previousRows = [:]; continue }
            }
            let viewport = fixture.scroll.convert(fixture.scroll.bounds, to: fixture.window)
                .inset(by: fixture.scroll.adjustedContentInset)
            var rows: [String: CGFloat] = [:]
            for message in fixture.model.messages(for: fixture.conversation) {
                let id = fixture.model.timelineIdentity(for: message)
                guard let frame = ConversationMotionProbeRegistry.frame(for: id, in: fixture.window),
                      frame.intersection(viewport).height > 10 else { continue }
                rows[id] = frame.minY
                if let before = previousRows[id] {
                    comparedRows += 1
                    visualReversal = max(visualReversal, frame.minY - before)
                }
            }
            previousRows = rows
        }
        XCTAssertTrue(intermediate, "The arrow should show a real transition")
        XCTAssertGreaterThan(comparedRows, 20)
        XCTAssertLessThanOrEqual(visualReversal, 1, "Visible content must not move backward")
        XCTAssertNil(cover(in: fixture.window), "Navigation must remove its temporary viewport cover")
        XCTAssertEqual(fixture.scroll.contentOffset.y,
            ConversationTailScrollAnimator.targetOffset(in: fixture.scroll), accuracy: 1)
    }

    @MainActor
    private struct Fixture {
        let model: AppModel
        let account: CloudAccount
        let conversation: ConversationSummary
        let window: UIWindow
        let previousWindow: UIWindow?
        let scroll: UIScrollView
        let directory: URL

        func wires(read: Bool) -> [CloudMessageDTO] {
            (0..<48).map { index in
                let date = Date(timeIntervalSince1970: Double(1_000 + index)).ISO8601Format()
                return CloudMessageDTO(messageId: "navigation-\(index)", clientMessageId: "navigation-client-\(index)",
                    fromAccountId: account.accountId, toAccountId: "fixture-peer",
                    body: String(repeating: "Synthetic message \(index) for scroll navigation.\n", count: 1 + index % 6),
                    createdAt: date, deliveredAt: date, readAt: read ? date : nil, direction: "outgoing",
                    sessionId: conversation.sessionId, conversationId: "canonical-navigation",
                    conversationSequence: Int64(index + 1), version: 1)
            }
        }

        func close() {
            window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil; ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
            try? FileManager.default.removeItem(at: directory)
        }
    }

    private func makeFixture() async throws -> Fixture {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = AppModel(cache: try LocalMessageStore(inMemory: true),
            wireCache: CloudWireCache(directory: directory), previewMode: true)
        let account = try XCTUnwrap(model.account)
        let conversation = ConversationSummary(id: "person:navigation-fixture", kind: .person,
            peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil, displayName: "Navigation fixture",
            lastMessage: "Latest", lastActivityAt: Date(), unreadCount: 0, avatarSource: nil,
            agentActivity: .ready, sessionId: "navigation-fixture")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let temporary = Fixture(model: model, account: account, conversation: conversation,
            window: window, previousWindow: previous, scroll: UIScrollView(), directory: directory)
        _ = await model.applyConversationHistoryPage(CloudConversationMessagePage(
            messages: temporary.wires(read: false), nextBeforeSequence: nil, hasMore: false),
            to: conversation, account: account)
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        navigation.path = [.conversation(conversation)]
        let latest = model.timelineIdentity(for: try XCTUnwrap(model.messages(for: conversation).last))
        // These cases start in an already opened chat. Cold-entry positioning
        // is covered separately; establish this fixture's native start position.
        try await Task.sleep(for: .milliseconds(500))
        func transcript(in view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, !(scroll is UITextView), scroll.contentSize.height > scroll.bounds.height { return scroll }
            return view.subviews.lazy.compactMap { transcript(in: $0) }.first
        }
        for _ in 0..<200 {
            if let scroll = transcript(in: controller.view) {
                scroll.setContentOffset(CGPoint(x: 0, y: ConversationTailScrollAnimator.targetOffset(in: scroll)), animated: false)
            }
            if let frame = ConversationMotionProbeRegistry.frame(for: latest, in: window),
               frame.intersects(window.bounds), let row = ConversationMotionProbeRegistry.views[latest]?.value {
                var ancestor = row.superview
                while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
                if let scroll = ancestor as? UIScrollView,
                   abs(scroll.contentOffset.y - ConversationTailScrollAnimator.targetOffset(in: scroll)) < 1 {
                    try await Task.sleep(for: .milliseconds(400))
                    return Fixture(model: model, account: account, conversation: conversation,
                        window: window, previousWindow: previous, scroll: scroll, directory: directory)
                }
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        temporary.close()
        XCTFail("The synthetic navigation fixture did not become visible")
        throw NSError(domain: "ScrollNavigationFixture", code: 1)
    }
}
