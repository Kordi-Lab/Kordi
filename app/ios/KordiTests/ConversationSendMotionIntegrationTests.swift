import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
private final class SendMotionNavigation: ObservableObject {
    @Published var path: [MainNavigationRoute] = []
}

private struct SendMotionHost: View {
    @ObservedObject var navigation: SendMotionNavigation
    let model: AppModel
    let calls: KordiCallCoordinator
    let notifications: KordiNotificationCoordinator

    var body: some View {
        MainNavigationHost(path: $navigation.path) {
            Text("Conversations")
        } destination: { route in
            MainNavigationDestination(path: $navigation.path, route: route, selectedTab: .chats)
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .environmentObject(model)
        .environmentObject(calls)
        .environmentObject(notifications)
    }
}

@MainActor
final class ConversationSendMotionIntegrationTests: XCTestCase {
    func testShortChatSendDoesNotReverseDirection() async throws { try await checkSend(count: 2) }
    func testLongChatSendDoesNotReverseDirection() async throws { try await checkSend(count: 40) }

    func testMultilineSendDoesNotReverseDirection() async throws {
        try await checkSend(count: 40, draft: Array(repeating: "A longer line for the composer", count: 6).joined(separator: "\n"))
    }

    func testRapidSendStartsAtItsFinalVisiblePosition() async throws {
        try await checkSend(count: 40, draft: "Second message", rapid: true)
    }

    func testSendDuringKeyboardOpeningKeepsTheBubbleWithItsComposer() async throws {
        try await checkSend(count: 40, waitForKeyboard: false)
    }

    private func checkSend(count: Int, draft: String = "New message", rapid: Bool = false, waitForKeyboard: Bool = true) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "motion-chat", kind: .person, peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil,
            displayName: "Motion fixture", lastMessage: "Ready", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "motion-chat")
        let seed = (0..<count).map { index in
            ChatMessage(id: "fixture-\(index)", conversationId: conversation.id, author: .me, authorName: "You",
                text: "Fixture message \(index)", createdAt: Date().addingTimeInterval(Double(index - count)),
                deliveryState: .read, errorMessage: nil, requestMessageId: nil)
        }
        store.saveMessages(seed, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true; window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        controller.view.layoutIfNeeded()
        navigation.path = [.conversation(conversation)]
        let lastSeedID = model.timelineIdentity(for: seed[count - 1])
        for _ in 0..<250 {
            if ConversationMotionProbeRegistry.frame(for: lastSeedID, in: window) != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        _ = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: lastSeedID, in: window), "Wait for the real history to finish its initial reveal")
        func editor(in view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        ConversationMotionProbeRegistry.setDraft?(draft)
        let composer = try XCTUnwrap(editor(in: controller.view))
        composer.becomeFirstResponder()
        func presentedEditorFrame() -> CGRect? {
            guard let layer = composer.layer.presentation(), let root = window.layer.presentation(),
                  !layer.bounds.isEmpty else { return nil }
            return layer.convert(layer.bounds, to: root)
        }
        var previousEditorTop: CGFloat?
        var stableKeyboardFrames = 0
        if waitForKeyboard {
            for _ in 0..<250 {
                try await Task.sleep(for: .milliseconds(20))
                guard let frame = presentedEditorFrame() else { continue }
                if frame.maxY < window.bounds.maxY - 120, let previousEditorTop,
                   abs(previousEditorTop - frame.minY) < 0.1 {
                    stableKeyboardFrames += 1
                } else {
                    stableKeyboardFrames = 0
                }
                previousEditorTop = frame.minY
                if stableKeyboardFrames >= 6 { break }
            }
            XCTAssertGreaterThanOrEqual(stableKeyboardFrames, 6, "The software keyboard must finish opening before measuring send motion")
        }
        XCTAssertNotNil(ConversationMotionProbeRegistry.send)
        if rapid {
            ConversationMotionProbeRegistry.setDraft?("First message")
            ConversationMotionProbeRegistry.send?()
            try await Task.sleep(for: .milliseconds(40))
            ConversationMotionProbeRegistry.setDraft?(draft)
        }
        let sendTime = CACurrentMediaTime()
        ConversationMotionProbeRegistry.send?()
        var firstVisibleTime: CFTimeInterval?
        var positions: [CGFloat] = []
        var composerGaps: [CGFloat] = []
        var bubbleFrames: [CGRect] = []
        for _ in 0..<45 {
            try await Task.sleep(for: .milliseconds(10))
            if let last = model.messages(for: conversation).last, last.text == draft,
               let frame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: last), in: window) {
                if let bubble = ConversationMotionProbeRegistry.frame(
                    for: "bubble-" + (last.clientMessageId ?? last.id), in: window
                ) {
                    bubbleFrames.append(bubble)
                }
                if firstVisibleTime == nil {
                    firstVisibleTime = CACurrentMediaTime()
                }
                positions.append(frame.minY)
                if let editorLayer = composer.layer.presentation(), let root = window.layer.presentation() {
                    composerGaps.append(editorLayer.convert(editorLayer.bounds, to: root).minY - frame.maxY)
                }
            }
        }
        XCTAssertGreaterThan(positions.count, 5)
        XCTAssertNotNil(firstVisibleTime, "Every accepted send must become visible")
        let maximumDownwardStep = zip(positions, positions.dropFirst()).map { $1 - $0 }.max() ?? 0
        print("Synthetic send motion count=\(count), positions=\(positions.map { Int($0.rounded()) }), maximumDownwardStep=\(maximumDownwardStep), firstVisibleMs=\(((firstVisibleTime ?? sendTime) - sendTime) * 1000)")
        if waitForKeyboard {
            XCTAssertLessThanOrEqual(maximumDownwardStep, 1, "The real chat must not jump down after its initial upward movement")
        }
        let positionRange = (positions.max() ?? 0) - (positions.min() ?? 0)
        if waitForKeyboard {
            XCTAssertLessThanOrEqual(positionRange, 1, "The first visible frame must already use the final message position")
        } else {
            XCTAssertGreaterThan(composerGaps.count, 5)
            let gapRange = (composerGaps.max() ?? 0) - (composerGaps.min() ?? 0)
            XCTAssertLessThanOrEqual(gapRange, 1, "A send during keyboard movement must stay anchored to the composer")
        }
        print("Synthetic composer gap count=\(count), gaps=\(composerGaps.map { Int($0.rounded()) })")
        if count == 40, draft == "New message", !rapid {
            attachSnapshot(of: window, name: "Settled message frame")
        }
        XCTAssertGreaterThan(bubbleFrames.count, 5)
        let widths = bubbleFrames.map(\.width)
        let settledWidth = try XCTUnwrap(widths.last)
        let smallestWidth = try XCTUnwrap(widths.min())
        XCTAssertGreaterThan(settledWidth - smallestWidth, settledWidth * 0.02, "A new bubble must visibly grow to full size")
        let largestShrink = zip(widths, widths.dropFirst()).map { $0 - $1 }.max() ?? 0
        XCTAssertLessThanOrEqual(largestShrink, 1, "Bubble growth must not reverse or replay during delivery updates")
        let anchors = waitForKeyboard
            ? [bubbleFrames.map(\.maxX), bubbleFrames.map(\.maxY)]
            : [bubbleFrames.map(\.maxX)]
        for anchor in anchors {
            XCTAssertLessThanOrEqual((anchor.max() ?? 0) - (anchor.min() ?? 0), 1, "The bottom trailing bubble anchor must remain fixed")
        }
        print("Synthetic bubble growth widths=\(widths.map { Int($0.rounded()) })")
        composer.resignFirstResponder()
        var stableClosedFrames = 0
        previousEditorTop = nil
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(20))
            guard let frame = presentedEditorFrame() else { continue }
            if frame.maxY > window.bounds.maxY - 100, let previousEditorTop,
               abs(previousEditorTop - frame.minY) < 0.1 {
                stableClosedFrames += 1
            } else { stableClosedFrames = 0 }
            previousEditorTop = frame.minY
            if stableClosedFrames >= 6 { break }
        }
    }
    private func attachSnapshot(of window: UIWindow, name: String) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

}

@MainActor
final class ConversationLatestIndicatorIntegrationTests: XCTestCase {
    func testJumpToLatestClearsUnreadWithoutComposerInteraction() async throws {
        try await checkReadingLatest(useButton: true)
    }

    func testScrollingToLatestClearsUnreadWithoutComposerInteraction() async throws {
        try await checkReadingLatest(useButton: false)
    }

    func testLatestAlreadyVisibleDoesNotKeepUnreadIndicator() async throws {
        try await checkReadingLatest(useButton: true, resumeAtLatest: true)
    }

    func testKeyboardAndTypingPreserveUnreadUntilJumpingToLatest() async throws {
        try await checkReadingLatest(useButton: true, opensKeyboard: true)
    }

    private func checkReadingLatest(
        useButton: Bool,
        resumeAtLatest: Bool = false,
        opensKeyboard: Bool = false
    ) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = try XCTUnwrap(model.conversations.first { $0.id == "person:acct_maya" })
        let initialUnreadCount = conversation.unreadCount
        // Exercise cache hydration with fixed-height text instead of preview
        // media whose asynchronous layout can change the scroll destination.
        model.hydrateCachedMessages(for: conversation)
        for other in model.conversations where other.id != conversation.id {
            model.hydrateCachedMessages(for: other)
        }
        let messages = (0..<40).map { index in
            ChatMessage(id: "latest-fixture-\(index)", conversationId: conversation.id,
                author: .person, authorName: "Fixture peer", text: "Message \(index)",
                createdAt: Date().addingTimeInterval(Double(index - 40)),
                deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        }
        store.saveMessages(messages, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        model.hydrateCachedMessages(for: conversation)
        XCTAssertEqual(model.messages(for: conversation).map(\.id), messages.map(\.id))
        XCTAssertGreaterThan(initialUnreadCount, 0)
        model.conversationViewportMemory.remember(
            key: "\(accountID):\(conversation.id):conversation", messageID: resumeAtLatest ? messages.last?.id : messages[0].id,
            latestMessageID: messages.last?.id, at: Date()
        )
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator())
            .environment(\.scenePhase, .active))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        controller.view.layoutIfNeeded()
        navigation.path = [.conversation(conversation)]
        for _ in 0..<200 {
            if ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window) != nil
                || (resumeAtLatest && model.conversations.first { $0.id == conversation.id }?.unreadCount == 0) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        try await Task.sleep(for: .milliseconds(300))
        if !resumeAtLatest {
            XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window))
            XCTAssertEqual(model.conversations.first { $0.id == conversation.id }?.unreadCount, initialUnreadCount, "Browsing history must preserve unread messages")
        }
        func timelineScroll(in view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, !(scroll is UITextView),
               scroll.contentSize.height > scroll.bounds.height + 100 { return scroll }
            return view.subviews.lazy.compactMap { timelineScroll(in: $0) }.first
        }
        let scroll = try XCTUnwrap(timelineScroll(in: controller.view))
        func editor(in view: UIView) -> UITextView? {
            if let editor = view as? UITextView, editor.isEditable { return editor }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        let composer = try XCTUnwrap(editor(in: controller.view))
        if opensKeyboard {
            composer.becomeFirstResponder()
            ConversationMotionProbeRegistry.setDraft?("Draft while reading history")
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertTrue(composer.isFirstResponder)
            XCTAssertEqual(model.conversations.first { $0.id == conversation.id }?.unreadCount, initialUnreadCount,
                "Keyboard focus and typing must not acknowledge unseen messages")
            XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window))
        }
        if useButton {
            let action = try XCTUnwrap(ConversationMotionProbeRegistry.goToLatest)
            action()
        } else {
            scroll.setContentOffset(CGPoint(x: 0, y: ConversationTailScrollAnimator.targetOffset(in: scroll)), animated: false)
        }
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(20))
            if model.conversations.first { $0.id == conversation.id }?.unreadCount == 0,
               ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window) == nil { break }
        }
        XCTAssertEqual(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 12)
        XCTAssertNil(ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window), "The control must disappear after reaching the latest messages, without focusing or typing")
        XCTAssertEqual(model.conversations.first { $0.id == conversation.id }?.unreadCount, 0, "Read acknowledgement must follow actual viewport arrival")
        if !opensKeyboard {
            XCTAssertFalse(composer.isFirstResponder, "Clearing the indicator must not require composer focus")
        }
        if useButton && !resumeAtLatest && !opensKeyboard {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "Latest messages read with keyboard closed"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        composer.resignFirstResponder()
    }
}
