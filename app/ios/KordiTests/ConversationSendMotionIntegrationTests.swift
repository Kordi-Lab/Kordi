import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
final class SendMotionNavigation: ObservableObject {
    @Published var path: [MainNavigationRoute] = []
}

struct SendMotionHost: View {
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
            // The composer rejects another send until the first one is staged.
            // Wait for acceptance, not rendering or a guessed 40 ms delay, so
            // this still exercises a second send during the first reveal.
            for _ in 0..<200 {
                if model.messages(for: conversation).contains(where: { $0.text == "First message" }) { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(model.messages(for: conversation).contains { $0.text == "First message" },
                          "The first send must be accepted before issuing another composer action")
            ConversationMotionProbeRegistry.setDraft?(draft)
        }
        let sendTime = CACurrentMediaTime()
        ConversationMotionProbeRegistry.send?()
        var firstVisibleTime: CFTimeInterval?
        var positions: [CGFloat] = []
        var composerGaps: [CGFloat] = []
        var bubbleFrames: [CGRect] = []
        // Bound readiness separately from measurement. A cold debug simulator
        // may spend time in layout before it can produce the first visible frame.
        // Keep observing for 450 ms after reveal so the spatial checks never
        // pass with only the last couple of frames of a keyboard transition.
        let revealDeadline = sendTime + 5
        while CACurrentMediaTime() < (firstVisibleTime.map { $0 + 0.45 } ?? revealDeadline) {
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
        if firstVisibleTime == nil {
            let current = model.messages(for: conversation)
            let accepted = current.filter { $0.text == draft }
            let row = accepted.last.flatMap { ConversationMotionProbeRegistry.views[model.timelineIdentity(for: $0)]?.value }
            print("[SendReadiness] accepted=\(accepted.count) firstAccepted=\(current.filter { $0.text == "First message" }.count) latestMatches=\(current.last?.text == draft) composerMatches=\(composer.text == draft) composerEmpty=\(composer.text.isEmpty) rowExists=\(row != nil) rowAttached=\(row?.window != nil) rowAlpha=\(row?.alpha ?? -1)")
        }
        XCTAssertGreaterThan(positions.count, 5)
        XCTAssertNotNil(firstVisibleTime, "Every accepted send must become visible")
        if rapid {
            let first = try XCTUnwrap(model.messages(for: conversation).first { $0.text == "First message" })
            XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: first), in: window),
                            "A later send must not leave an earlier accepted message hidden")
        }
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
    func testVisibleReplyReadPresentationDoesNotCoverANewerUnseenReply() {
        let visible = ConversationReadPresentation(conversationID: "conversation", isPresented: true,
            isAppForeground: true, isAtLatest: true, visibleMessageID: "visible-reply")
        XCTAssertTrue(visible.canMarkRead(latestMessageID: "visible-reply"))
        XCTAssertFalse(visible.canMarkRead(latestMessageID: "newer-reply"))
        XCTAssertFalse(visible.canMarkRead(latestMessageID: nil))
        let background = ConversationReadPresentation(conversationID: "conversation", isPresented: true,
            isAppForeground: false, isAtLatest: true, visibleMessageID: "visible-reply")
        XCTAssertFalse(background.canMarkRead(latestMessageID: "visible-reply"))
    }

    func testJumpToLatestClearsUnreadWithoutComposerInteraction() async throws {
        try await checkReadingLatest(useButton: true)
    }

    func testScrollingToLatestClearsUnreadWithoutComposerInteraction() async throws {
        try await checkReadingLatest(useButton: false)
    }

    func testLatestAlreadyVisibleDoesNotKeepUnreadIndicator() async throws {
        try await checkReadingLatest(useButton: true, resumeAtLatest: true)
    }

    func testVisibleAIReplyClearsUnreadWithoutReachingExactBottom() async throws {
        try await checkReadingLatest(useButton: false, visibleAboveBottom: true)
    }

    func testKeyboardAndTypingPreserveUnreadUntilJumpingToLatest() async throws {
        try await checkReadingLatest(useButton: true, opensKeyboard: true)
    }

    private func checkReadingLatest(
        useButton: Bool,
        resumeAtLatest: Bool = false,
        opensKeyboard: Bool = false,
        visibleAboveBottom: Bool = false
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
        let messages: [ChatMessage] = (0..<40).map { index in
            let isAIReply = visibleAboveBottom && index == 39
            let author: MessageAuthor = isAIReply ? .agent : .person
            let text = isAIReply ? Array(repeating: "Visible AI reply line.", count: 8).joined(separator: "\n") : "Message \(index)"
            return ChatMessage(id: "latest-fixture-\(index)", conversationId: conversation.id,
                author: author, authorName: "Fixture peer", text: text,
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
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator())
            .environment(\.scenePhase, .active))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
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
            for cycle in 0..<4 {
                composer.becomeFirstResponder()
                ConversationMotionProbeRegistry.setDraft?("Draft while reading history \(cycle)")
                try await Task.sleep(for: .milliseconds(350))
                XCTAssertTrue(composer.isFirstResponder)
                XCTAssertEqual(model.messages(for: conversation).map(\.id), messages.map(\.id),
                    "Keyboard transitions must preserve the full loaded history")
                composer.resignFirstResponder()
                try await Task.sleep(for: .milliseconds(350))
            }
            composer.becomeFirstResponder()
            try await Task.sleep(for: .milliseconds(350))
            XCTAssertTrue(composer.isFirstResponder)
            XCTAssertEqual(model.conversations.first { $0.id == conversation.id }?.unreadCount, initialUnreadCount,
                "Keyboard focus and typing must not acknowledge unseen messages")
            XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window))
        }
        if visibleAboveBottom {
            // Approach the tail in bounded steps so measuring unknown rows
            // cannot turn an estimated far jump into a real visit to the bottom.
            // The reply must still be offscreen when the visibility check starts.
            for _ in 0..<100 {
                let gap = ConversationTailScrollAnimator.targetOffset(in: scroll) - scroll.contentOffset.y
                if gap <= 500 { break }
                scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentOffset.y + min(100, gap - 500)), animated: false)
                try await Task.sleep(for: .milliseconds(40))
            }
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertEqual(model.conversations.first { $0.id == conversation.id }?.unreadCount, initialUnreadCount)
            let target = ConversationTailScrollAnimator.targetOffset(in: scroll) - 60
            scroll.setContentOffset(CGPoint(x: 0, y: target), animated: false)
            for _ in 0..<100 {
                if model.conversations.first(where: { $0.id == conversation.id })?.unreadCount == 0 { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertEqual(model.conversations.first(where: { $0.id == conversation.id })?.unreadCount, 0)
            XCTAssertLessThan(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll) - 12)
            return
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
        try await Task.sleep(for: .milliseconds(600))
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(model.messages(for: conversation).map(\.id), messages.map(\.id))
        let firstFrame = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: messages[0].id, in: window))
        XCTAssertTrue(firstFrame.intersects(scroll.convert(scroll.bounds, to: window)),
            "The oldest loaded message must remain reachable after reading and keyboard transitions")
    }
}

@MainActor
final class ConversationHistoryLayoutIntegrationTests: XCTestCase {
    func testColdCachedEntryStaysAtLatestWhenOlderHistoryArrives() async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, wireCache: CloudWireCache(directory: directory), previewMode: true)
        let account = try XCTUnwrap(model.account)
        let conversation = ConversationSummary(id: "person:cold-history", kind: .person,
            peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil, displayName: "Cold history",
            lastMessage: "Latest", lastActivityAt: Date(), unreadCount: 0, avatarSource: nil,
            agentActivity: .ready, sessionId: "cold-history")
        let messages = (0..<200).map { index in
            ChatMessage(id: "cold-\(index)", clientMessageId: "client-\(index)",
                conversationId: conversation.id, conversationSequence: Int64(index + 1),
                author: .me, authorName: "You",
                text: String(repeating: "Synthetic history line \(index).\n", count: 1 + index % 12),
                createdAt: Date(timeIntervalSince1970: Double(index + 1_000)),
                cloudMessageVersion: 1, deliveryState: .read, errorMessage: nil, requestMessageId: nil,
                reactionTargetMessageId: "cold-\(index)")
        }
        store.saveMessages(Array(messages.suffix(64)), conversationId: conversation.id,
            accountId: account.accountId, hasEarlier: true)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil; ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        navigation.path = [.conversation(conversation)]
        let latestID = model.timelineIdentity(for: messages.last!)
        var scroll: UIScrollView?
        for _ in 0..<200 {
            if let frame = ConversationMotionProbeRegistry.frame(for: latestID, in: window),
               frame.intersects(window.bounds), let row = ConversationMotionProbeRegistry.views[latestID]?.value {
                var ancestor = row.superview
                while let value = ancestor, !(value is UIScrollView) { ancestor = value.superview }
                scroll = ancestor as? UIScrollView
                if let scroll, abs(scroll.contentOffset.y - ConversationTailScrollAnimator.targetOffset(in: scroll)) < 1 { break }
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        let transcript = try XCTUnwrap(scroll)
        let known = model.knownHistoryMessageIDs(conversationID: conversation.id)
        let wires = messages.map { message in
            CloudMessageDTO(messageId: message.id, clientMessageId: message.clientMessageId,
                fromAccountId: account.accountId, toAccountId: "fixture-peer", body: message.text,
                createdAt: message.createdAt.ISO8601Format(), deliveredAt: message.createdAt.ISO8601Format(),
                readAt: message.createdAt.ISO8601Format(), direction: "outgoing", sessionId: conversation.sessionId,
                conversationId: "canonical-cold-history", conversationSequence: message.conversationSequence, version: 1)
        }
        let hydration = Task { await model.applyConversationHistoryPage(CloudConversationMessagePage(
            messages: wires, nextBeforeSequence: nil, hasMore: false), to: conversation,
            account: account, knownMessageIDs: known) }
        var largestGap: CGFloat = 0
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(10))
            largestGap = max(largestGap, abs(ConversationTailScrollAnimator.targetOffset(in: transcript)
                - (transcript.layer.presentation()?.bounds.minY ?? transcript.contentOffset.y)))
        }
        _ = await hydration.value
        XCTAssertEqual(model.messages(for: conversation).count, 200)
        XCTAssertLessThanOrEqual(largestGap, 2, "Prepending older history during cold entry must not pull the viewport away from latest")
    }

    func testLongMessageCannotDrawIntoHeaderWhileScrolling() async throws {
        try await checkHeaderBoundary(transparentNavigation: true)
    }

    func testVisibleNavigationDoesNotClipMessagesBelowHeader() async throws {
        try await checkHeaderBoundary(transparentNavigation: false)
    }

    private func checkHeaderBoundary(transparentNavigation: Bool) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "group:header-boundary", kind: .group,
            peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil,
            displayName: "Notice", lastMessage: "Ready", lastActivityAt: Date(),
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "header-boundary")
        let messages = [
            ChatMessage(id: "long-notice", conversationId: conversation.id, author: .person,
                authorName: "Fixture sender", text: String(repeating: "MMMM MMMM MMMM MMMM MMMM MMMM\n", count: 80),
                createdAt: Date(timeIntervalSince1970: 1000), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
            ChatMessage(id: "notice-tail", conversationId: conversation.id, author: .me,
                authorName: "Tester", text: "End of synthetic notice", createdAt: Date(timeIntervalSince1970: 1001),
                deliveryState: .read, errorMessage: nil, requestMessageId: nil)
        ]
        store.saveMessages(messages, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .light
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator())
            .environment(\.kordiChatTheme, .ocean).preferredColorScheme(.light))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        navigation.path = [.conversation(conversation)]
        for _ in 0..<200 {
            if ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: messages[1]), in: window) != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        func timelineScroll(_ view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, !(scroll is UITextView), scroll.contentSize.height > scroll.bounds.height + 100 { return scroll }
            return view.subviews.lazy.compactMap(timelineScroll).first
        }
        let scroll = try XCTUnwrap(timelineScroll(controller.view))
        XCTAssertGreaterThan(scroll.adjustedContentInset.top, 40)
        var navigationAppearances: [(UINavigationBar, UINavigationBarAppearance, UINavigationBarAppearance?, UINavigationBarAppearance?, CGFloat)] = []
        func rememberNavigation(_ view: UIView) {
            if let bar = view as? UINavigationBar {
                navigationAppearances.append((bar, bar.standardAppearance, bar.scrollEdgeAppearance, bar.compactAppearance, bar.alpha))
            }
            view.subviews.forEach(rememberNavigation)
        }
        rememberNavigation(controller.view)
        let navigationContent = navigationAppearances.flatMap { entry in
            entry.0.subviews.map { ($0, $0.alpha) }
        }
        let reservedTopInset = scroll.adjustedContentInset.top
        func capture(transparentNavigation: Bool = true) -> UIImage {
            // Exercise the failure condition independently of UIKit's automatic
            // material visibility. Transcript clipping must protect transparent bars too.
            func clearNavigationMaterial(_ view: UIView) {
                if let bar = view as? UINavigationBar {
                    let appearance = UINavigationBarAppearance()
                    appearance.configureWithTransparentBackground()
                    bar.standardAppearance = appearance
                    bar.scrollEdgeAppearance = appearance
                    bar.compactAppearance = appearance
                    // Preserve the visible bar and its safe-area reservation.
                    // Hiding the bar changes layout and misses double-inset bugs.
                    bar.layoutIfNeeded()
                    bar.subviews.forEach { $0.alpha = 0 }
                }
                view.subviews.forEach(clearNavigationMaterial)
            }
            if transparentNavigation {
                clearNavigationMaterial(controller.view)
            } else {
                for (view, alpha) in navigationContent { view.alpha = alpha }
                for (bar, standard, edge, compact, alpha) in navigationAppearances {
                    bar.standardAppearance = standard
                    bar.scrollEdgeAppearance = edge
                    bar.compactAppearance = compact
                    bar.alpha = alpha
                    bar.layoutIfNeeded()
                }
            }
            XCTAssertEqual(scroll.adjustedContentInset.top, reservedTopInset, accuracy: 1,
                "Removing navigation paint must preserve the real transcript layout")
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
        }
        func darkPixels(_ image: UIImage, belowHeader: Bool = false) throws -> Int {
            let cg = try XCTUnwrap(image.cgImage)
            var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: cg.width, height: cg.height,
                bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            var count = 0
            let headerBottom = navigationAppearances.filter { $0.4 > 0 }.map { $0.0.convert($0.0.bounds, to: window).maxY }.max() ?? 0
            let rows = belowHeader ? (Int(headerBottom) + 4)..<(Int(headerBottom) + 60) : 4..<max(5, Int(headerBottom) - 4)
            for y in rows {
                for x in 90..<(cg.width - 90) {
                    let i = (y * cg.width + x) * 4
                    if bytes[i] < 100 && bytes[i + 1] < 100 && bytes[i + 2] < 100 { count += 1 }
                }
            }
            return count
        }
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(400))
        let baseline = try darkPixels(capture(transparentNavigation: transparentNavigation))
        for offset in [200.0, 245.0, 290.0] {
            scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            try await Task.sleep(for: .milliseconds(250))
            let image = capture(transparentNavigation: transparentNavigation)
            let dark = try darkPixels(image)
            XCTAssertGreaterThan(try darkPixels(image, belowHeader: true), 100,
                "The scrolled message must remain visible immediately below the header")
            let attachment = XCTAttachment(image: image)
            attachment.name = "Synthetic long message at header, offset \(offset)"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertLessThanOrEqual(dark, baseline + 12,
                "Message glyphs must not paint into the navigation or status area while scrolling")
        }
        let restoredHeader = XCTAttachment(image: capture(transparentNavigation: false))
        restoredHeader.name = "Synthetic long message with protected navigation header"
        restoredHeader.lifetime = .keepAlways
        add(restoredHeader)
    }

    func testMixedHeightGroupHistoryFillsViewportWhileScrolling() async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "group:history-layout", kind: .group,
            peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil,
            displayName: "History layout fixture", lastMessage: "Ready", lastActivityAt: Date(),
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "history-layout")
        var messages: [ChatMessage] = []
        for index in 0..<48 {
            let isQuestion = index % 3 == 0
            let response = Array(repeating: "A synthetic calendar response with a proposed meeting and more details.", count: 1 + index % 9).joined(separator: "\n\n")
            let message = ChatMessage(id: "history-layout-\(index)", conversationId: conversation.id,
                author: isQuestion ? .person : .agent,
                authorName: isQuestion ? "Fixture person" : "Fixture agent",
                text: isQuestion ? "@Kordi What is on my calendar?" : response,
                createdAt: Date().addingTimeInterval(Double(index - 48) * 60),
                deliveryState: .delivered, errorMessage: nil,
                requestMessageId: isQuestion ? nil : "history-layout-\(index - index % 3)")
            messages.append(message)
        }
        XCTAssertEqual(Set(messages.map(model.timelineIdentity(for:))).count, messages.count,
            "Each group reply needs its own row even when request and display names match")
        store.saveMessages(messages, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
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
        for _ in 0..<250 {
            if ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: messages[47]), in: window) != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        func timelineScroll(in view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, !(scroll is UITextView),
               scroll.contentSize.height > scroll.bounds.height + 100 { return scroll }
            return view.subviews.lazy.compactMap { timelineScroll(in: $0) }.first
        }
        let scroll = try XCTUnwrap(timelineScroll(in: controller.view))
        for fraction in [0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75, 1.0] {
            let target = max(0, ConversationTailScrollAnimator.targetOffset(in: scroll)) * fraction
            scroll.setContentOffset(CGPoint(x: 0, y: target), animated: false)
            try await Task.sleep(for: .milliseconds(400))
            let viewport = scroll.convert(scroll.bounds, to: window).insetBy(dx: 0, dy: 20)
            let frames = messages.compactMap { message in
                ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: message), in: window)
            }.filter { $0.intersects(viewport) }.sorted { $0.minY < $1.minY }
            XCTAssertFalse(frames.isEmpty, "History must render rows at scroll fraction \(fraction)")
            guard let first = frames.first, let last = frames.last else { continue }
            let gap = max(first.minY - viewport.minY, viewport.maxY - last.maxY,
                zip(frames, frames.dropFirst()).map { $1.minY - $0.maxY }.max() ?? 0)
            if gap > 40 || fraction == 0.5 {
                let format = UIGraphicsImageRendererFormat(); format.scale = 1
                let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "Synthetic group history at \(fraction)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            XCTAssertLessThanOrEqual(gap, 40, "Visible history must remain contiguous at scroll fraction \(fraction)")
        }
    }
}

@MainActor
final class ConversationIncomingTailTests: XCTestCase {
    func testGroupReplyStaysAtBottomWhileStreamingWithKeyboardOpen() async throws {
        try await checkIncomingReply(readingHistory: false)
    }

    func testGroupReplyDoesNotPullTheReaderAwayFromHistory() async throws {
        try await checkIncomingReply(readingHistory: true)
    }

    private func checkIncomingReply(readingHistory: Bool) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let account = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "group:incoming-tail", kind: .group,
            peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil,
            displayName: "Incoming reply fixture", lastMessage: "Ready", lastActivityAt: Date(),
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "incoming-tail")
        let now = Date()
        let seed = (0..<32).map { index in
            ChatMessage(id: "incoming-seed-\(index)", conversationId: conversation.id,
                author: index % 3 == 0 ? .me : .agent, authorName: "Fixture author",
                text: String(repeating: "A synthetic history paragraph with several lines of context.\n\n", count: 1 + index % 8),
                createdAt: now.addingTimeInterval(Double(index - 32) * 60),
                deliveryState: .read, errorMessage: nil, requestMessageId: nil)
        }
        store.saveMessages(seed, conversationId: conversation.id, accountId: account, hasEarlier: false)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true; window.rootViewController = nil
            previous?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        navigation.path = [.conversation(conversation)]
        let lastSeed = model.timelineIdentity(for: try XCTUnwrap(seed.last))
        for _ in 0..<250 {
            if ConversationMotionProbeRegistry.frame(for: lastSeed, in: window) != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        _ = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: lastSeed, in: window))
        let row = try XCTUnwrap(ConversationMotionProbeRegistry.views[lastSeed]?.value)
        var ancestor = row.superview
        var timeline: UIScrollView?
        while let view = ancestor {
            if let scroll = view as? UIScrollView { timeline = scroll; break }
            ancestor = view.superview
        }
        let scroll = try XCTUnwrap(timeline)
        func editor(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap(editor).first
        }
        let composer = try XCTUnwrap(editor(controller.view))
        func presentedComposerFrame() -> CGRect {
            if let layer = composer.layer.presentation(), let root = window.layer.presentation() {
                return layer.convert(layer.bounds, to: root)
            }
            return composer.convert(composer.bounds, to: window)
        }
        composer.becomeFirstResponder()
        var lastTop: CGFloat = 0
        var stableFrames = 0
        for _ in 0..<250 {
            try await Task.sleep(for: .milliseconds(20))
            let frame = presentedComposerFrame()
            stableFrames = frame.maxY < window.bounds.maxY - 120 && abs(frame.minY - lastTop) < 0.1 ? stableFrames + 1 : 0
            lastTop = frame.minY
            if stableFrames >= 6 { break }
        }
        XCTAssertGreaterThanOrEqual(stableFrames, 6)
        XCTAssertEqual(ConversationTailScrollAnimator.targetOffset(in: scroll) - scroll.contentOffset.y, 0, accuracy: 1,
            "The fixture must begin at the native bottom after keyboard layout")
        if readingHistory {
            scroll.setContentOffset(CGPoint(x: 0, y: 100), animated: false)
            try await Task.sleep(for: .milliseconds(400))
        }
        let historyOffset = scroll.contentOffset.y
        let question = ChatMessage(id: "incoming-question", conversationId: conversation.id,
            author: .me, authorName: "You", text: "Please check this example.", createdAt: now,
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        model.upsertPreviewMessage(question)
        try await Task.sleep(for: .milliseconds(300))
        for phase in 0..<6 {
            let reply = ChatMessage(id: "incoming-answer", conversationId: conversation.id,
                author: .agent, authorName: "Fixture agent",
                text: String(repeating: "A streamed response with supporting details.\n\n", count: phase == 5 ? 1 : phase * 4),
                createdAt: now.addingTimeInterval(1), cloudMessageVersion: phase + 1, deliveryState: .delivered,
                errorMessage: nil, requestMessageId: question.id,
                messageAction: MessageActionMetadata.quote(question.actionSource(sessionId: conversation.sessionId)),
                agentExecution: AgentExecutionSnapshot(phase: phase >= 4 ? .complete : .usingTool,
                    summary: "", steps: [], startedAtMs: 0, updatedAtMs: Double(phase), completed: phase >= 4))
            model.upsertPreviewMessage(reply)
            var gaps: [CGFloat] = []
            for _ in 0..<40 {
                try await Task.sleep(for: .milliseconds(10))
                if !readingHistory,
                   let frame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: reply), in: window),
                   frame.minY < presentedComposerFrame().minY {
                    gaps.append(presentedComposerFrame().minY - frame.maxY)
                }
            }
            if readingHistory {
                XCTAssertEqual(scroll.contentOffset.y, historyOffset, accuracy: 1,
                    "An incoming reply must preserve the reader's history position")
            } else {
                let frame = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: reply), in: window),
                    "Reply phase \(phase) must render; distance from bottom: \(ConversationTailScrollAnimator.targetOffset(in: scroll) - scroll.contentOffset.y)")
                let gap = presentedComposerFrame().minY - frame.maxY
                let gapRange = (gaps.max() ?? 0) - (gaps.min() ?? 0)
                XCTAssertLessThanOrEqual(gapRange, 2, "A visible incoming reply must not jump up and then down in phase \(phase)")
                let tailDistance = ConversationTailScrollAnimator.targetOffset(in: scroll) - scroll.contentOffset.y
                XCTAssertGreaterThanOrEqual(gap, 0, "The latest reply must stay above the composer")
                XCTAssertLessThanOrEqual(gap, 45, "No blank space may remain below the latest reply")
                XCTAssertEqual(tailDistance, 0, accuracy: 1, "Streaming must continue following the bottom")
                XCTAssertNil(ConversationMotionProbeRegistry.frame(for: "latest-message-button", in: window),
                    "A fully visible latest reply must not offer a further jump down")
            }
        }
    }
}
