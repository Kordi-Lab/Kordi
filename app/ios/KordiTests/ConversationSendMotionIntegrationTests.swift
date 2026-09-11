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
            // Materialize the tall final row before measuring its final offset.
            // Lazy height estimates can otherwise put the first jump at the tail.
            scroll.setContentOffset(CGPoint(x: 0, y: ConversationTailScrollAnimator.targetOffset(in: scroll) - 240), animated: false)
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
    func testLongMessageCannotDrawIntoHeaderWhileScrolling() async throws {
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
        func capture(hidingNavigation: Bool = true) -> UIImage {
            // Exercise the failure condition independently of UIKit's automatic
            // material visibility. Transcript clipping must protect transparent bars too.
            func clearNavigationMaterial(_ view: UIView) {
                if let bar = view as? UINavigationBar {
                    let appearance = UINavigationBarAppearance()
                    appearance.configureWithTransparentBackground()
                    bar.standardAppearance = appearance
                    bar.scrollEdgeAppearance = appearance
                    bar.compactAppearance = appearance
                    // Keep its safe-area reservation while exposing any transcript
                    // pixels that would otherwise be covered by navigation material.
                    bar.alpha = 0
                    bar.layoutIfNeeded()
                }
                view.subviews.forEach(clearNavigationMaterial)
            }
            if hidingNavigation {
                clearNavigationMaterial(controller.view)
            } else {
                for (bar, standard, edge, compact, alpha) in navigationAppearances {
                    bar.standardAppearance = standard
                    bar.scrollEdgeAppearance = edge
                    bar.compactAppearance = compact
                    bar.alpha = alpha
                    bar.layoutIfNeeded()
                }
            }
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
        }
        func darkPixels(_ image: UIImage) throws -> Int {
            let cg = try XCTUnwrap(image.cgImage)
            var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: cg.width, height: cg.height,
                bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            var count = 0
            let headerBottom = scroll.convert(scroll.bounds, to: window).minY + scroll.adjustedContentInset.top
            for y in 4..<max(5, Int(headerBottom) - 4) {
                for x in 90..<(cg.width - 90) {
                    let i = (y * cg.width + x) * 4
                    if bytes[i] < 100 && bytes[i + 1] < 100 && bytes[i + 2] < 100 { count += 1 }
                }
            }
            return count
        }
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(400))
        let baseline = try darkPixels(capture())
        for offset in [200.0, 245.0, 290.0] {
            scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            try await Task.sleep(for: .milliseconds(250))
            let image = capture()
            let dark = try darkPixels(image)
            let attachment = XCTAttachment(image: image)
            attachment.name = "Synthetic long message at header, offset \(offset)"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertLessThanOrEqual(dark, baseline + 12,
                "Message glyphs must not paint into the navigation or status area while scrolling")
        }
        let restoredHeader = XCTAttachment(image: capture(hidingNavigation: false))
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
