import EventKit
import ImageIO
import UIKit
import XCTest
import SwiftUI
@testable import Kordi

@MainActor
private final class HistoryNavigationProbe: ObservableObject {
    @Published var path: [MainNavigationRoute] = []
}

private struct HistoryNavigationProbeView: View {
    @ObservedObject var navigation: HistoryNavigationProbe
    let model: AppModel
    let calls: KordiCallCoordinator
    let notifications: KordiNotificationCoordinator
    let conversation: ConversationSummary

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
        .preferredColorScheme(.light)
    }
}

@MainActor
final class CachedAgentHistoryViewportTests: XCTestCase {
    func testKeyboardKeepsLatestMessageVisibleAndPreservesHistoryPosition() async throws {
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let conversation = ConversationSummary(
            id: "person:keyboard-test", kind: .person, peerAccountId: "keyboard-peer", agentId: nil,
            ownerDisplayName: "Tester", displayName: "Keyboard visibility",
            lastMessage: "Message 39", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "keyboard-test"
        )
        let accountID = try XCTUnwrap(model.account?.accountId)
        let messages = (0..<40).map { index in
            ChatMessage(
                id: "keyboard-message-\(index)", conversationId: conversation.id,
                author: index.isMultiple(of: 2) ? .me : .person,
                authorName: "Keyboard tester",
                text: index == 37
                    ? String(repeating: "A tall history message that must stay above the keyboard.\n", count: 8)
                    : "Message \(index): checking the visible conversation.",
                createdAt: Date(timeIntervalSince1970: Double(1_000 + index)),
                cloudMessageVersion: 1, deliveryState: .read, errorMessage: nil, requestMessageId: nil
            )
        }
        store.saveMessages(messages, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let controller = UIHostingController(rootView:
            MainTabView(initialPath: [.conversation(conversation)])
                .environmentObject(model)
                .environmentObject(KordiCallCoordinator())
                .environmentObject(KordiNotificationCoordinator())
                .environment(\.kordiChatTheme, .sand)
                .preferredColorScheme(.light)
        )
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
        }
        func settle() async throws {
            try await Task.sleep(for: .milliseconds(800))
            controller.view.layoutIfNeeded()
        }
        func descendants(_ view: UIView) -> [UIView] {
            [view] + view.subviews.flatMap(descendants)
        }
        func bottomGap(_ scroll: UIScrollView) -> CGFloat {
            scroll.contentSize.height + scroll.adjustedContentInset.bottom
                - scroll.contentOffset.y - scroll.bounds.height
        }
        try await settle()
        let editor = try XCTUnwrap(descendants(controller.view).compactMap { $0 as? UITextView }.first)
        let scroll = try XCTUnwrap(descendants(controller.view).compactMap { $0 as? UIScrollView }
            .filter { !($0 is UITextView) }.max { $0.contentSize.height < $1.contentSize.height })
        XCTAssertLessThanOrEqual(abs(bottomGap(scroll)), 14, "Chat must start at latest")
        XCTAssertTrue(scroll.keyboardDismissMode == .interactive || scroll.keyboardDismissMode == .interactiveWithAccessory)
        let closedHeight = scroll.bounds.height
        func navigationController(in host: UIViewController) -> UINavigationController? {
            if let navigation = host as? UINavigationController { return navigation }
            return host.children.lazy.compactMap { navigationController(in: $0) }.first
        }
        let navigationController = try XCTUnwrap(navigationController(in: controller))
        let navigationHeight = navigationController.view.bounds.height
        XCTAssertTrue(editor.becomeFirstResponder())
        var navigationHeights: [CGFloat] = []
        for _ in 0..<40 {
            try await Task.sleep(for: .milliseconds(16))
            navigationHeights.append(navigationController.view.layer.presentation()?.bounds.height
                ?? navigationController.view.bounds.height)
        }
        XCTAssertLessThanOrEqual(
            navigationHeights.map { abs($0 - navigationHeight) }.max() ?? 0, 1,
            "The outer navigation host must not resize ahead of its keyboard-aware conversation"
        )
        try await settle()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "Conversation with keyboard open"
        attachment.lifetime = .keepAlways
        add(attachment)
        let backingImage = try XCTUnwrap(image.cgImage)
        let corner = try XCTUnwrap(backingImage.cropping(to: CGRect(
            x: 3, y: backingImage.height - 30, width: 1, height: 1
        )))
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(corner, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertEqual(Double(pixel[0]), 242, accuracy: 8, "The keyboard's uncovered corners must have the chat wallpaper")
        XCTAssertEqual(Double(pixel[1]), 235, accuracy: 8)
        XCTAssertEqual(Double(pixel[2]), 221, accuracy: 8)
        XCTAssertEqual(model.messages(for: conversation).count, 40)
        XCTAssertTrue(scroll.keyboardDismissMode == .interactive || scroll.keyboardDismissMode == .interactiveWithAccessory)
        XCTAssertLessThan(scroll.bounds.height, closedHeight - 100, "The real keyboard must resize the transcript")
        XCTAssertLessThanOrEqual(abs(bottomGap(scroll)), 14, "Keyboard must keep the latest message above the composer")

        let textKeyboardHeight = scroll.bounds.height
        let accessory = UIView(frame: CGRect(x: 0, y: 0, width: window.bounds.width, height: 80))
        accessory.backgroundColor = .secondarySystemBackground
        editor.inputAccessoryView = accessory
        editor.reloadInputViews()
        try await settle()
        XCTAssertGreaterThan(abs(scroll.bounds.height - textKeyboardHeight), 20, "Expanding the input surface must exercise a different height")
        XCTAssertLessThanOrEqual(abs(bottomGap(scroll)), 14, "Changing input height must keep latest visible")
        editor.inputAccessoryView = nil
        editor.reloadInputViews()
        try await settle()
        XCTAssertLessThanOrEqual(abs(bottomGap(scroll)), 14, "Returning to the text keyboard must keep latest visible")
        editor.resignFirstResponder()
        try await settle()
        XCTAssertLessThanOrEqual(abs(bottomGap(scroll)), 14, "Dismissing the keyboard must keep latest visible")

        // Reading history must not be mistaken for following the latest message.
        scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentOffset.y - 250)), animated: false)
        try await settle()
        let historyOffset = scroll.contentOffset.y
        let historyViewportHeight = scroll.bounds.height
        XCTAssertGreaterThan(bottomGap(scroll), 100)
        XCTAssertTrue(editor.becomeFirstResponder())
        try await settle()
        let raisedHistoryOffset = historyOffset + historyViewportHeight - scroll.bounds.height
        XCTAssertEqual(scroll.contentOffset.y, raisedHistoryOffset, accuracy: 14,
            "The bottom visible history must move above the composer with the keyboard")
        // Lazy layout can refine the height of offscreen rows during resizing.
        // The exact offset assertion above protects the reading position; this
        // check only verifies that the reader has not returned to latest.
        XCTAssertGreaterThan(bottomGap(scroll), 14, "Reading history must remain outside the latest-message tolerance")
        let didEdit = await model.editMessage(
            messages[39],
            text: String(repeating: "An updated message below the reading position.\n", count: 20),
            in: conversation
        )
        XCTAssertTrue(didEdit)
        try await settle()
        XCTAssertEqual(scroll.contentOffset.y, raisedHistoryOffset, accuracy: 14, "Content growth must not pull the reader to latest")
        editor.resignFirstResponder()
        try await settle()
    }

    func testCachedAgentHistoryRendersAfterRepeatedEntry() async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        defer {
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(
            id: "agent-session:viewport-test", kind: .agent, peerAccountId: accountID,
            agentId: "viewport-agent", ownerDisplayName: "Tester", displayName: "Completed history",
            lastMessage: "Completed", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "viewport-test"
        )
        var messages = (0..<13).map { index in
            ChatMessage(
                id: "message-\(index)", conversationId: conversation.id,
                author: index.isMultiple(of: 2) ? .me : .agent, authorName: "Tester",
                text: index.isMultiple(of: 2) ? "Request \(index)" : "## Completed report \(index)\n\n" + String(repeating: "This paragraph describes the completed analysis and its supporting details.\n\n", count: 25),
                createdAt: Date(timeIntervalSince1970: Double(1_000 + index)),
                cloudMessageVersion: 1, deliveryState: .read, errorMessage: nil, requestMessageId: nil
            )
        }
        if let fixturePath = ProcessInfo.processInfo.environment["KORDI_VIEWPORT_FIXTURE"] {
            messages = try JSONDecoder().decode([ChatMessage].self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
        }
        store.saveMessages(messages, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let calls = KordiCallCoordinator()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 440, height: 956))
        window.windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true; window.rootViewController = nil }
        let navigation = HistoryNavigationProbe()
        let controller = UIHostingController(rootView: HistoryNavigationProbeView(
            navigation: navigation, model: model, calls: calls,
            notifications: KordiNotificationCoordinator(), conversation: conversation
        ))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        func navigationController(in host: UIViewController) -> UINavigationController? {
            if let navigation = host as? UINavigationController { return navigation }
            return host.children.lazy.compactMap { navigationController(in: $0) }.first
        }
        func waitForStack(count: Int) async throws -> UIViewController {
            for _ in 0..<150 {
                controller.view.layoutIfNeeded()
                if let outer = navigationController(in: controller),
                   outer.viewControllers.count == count,
                   outer.transitionCoordinator == nil,
                   let top = outer.topViewController, top.view.window === window {
                    return top
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTFail("The actual Product navigation stack did not finish transitioning to \(count) controllers")
            throw HistoryNavigationWaitError.incompleteTransition
        }
        _ = try await waitForStack(count: 1)
        var expectedAnchor: (id: String, top: CGFloat)?
        func rowTop(_ id: String, in scroll: UIScrollView) -> CGFloat? {
            guard let view = ConversationMotionProbeRegistry.views[id]?.value,
                  view.window === window else { return nil }
            return view.convert(view.bounds, to: scroll).minY
                - scroll.bounds.minY - scroll.adjustedContentInset.top
        }
        for entry in 0..<5 {
            let openingStarted = CACurrentMediaTime()
            let anchorAtEntry = expectedAnchor
            let firstContent = Task { @MainActor in
                for _ in 0..<200 {
                    try await Task.sleep(for: .milliseconds(10))
                    if messages.contains(where: { message in
                        guard let frame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: message), in: window) else { return false }
                        let visible = frame.intersection(window.bounds.insetBy(dx: 0, dy: 100))
                        return visible.width > 64 && visible.height > 10
                    }) {
                        let targetID = anchorAtEntry?.id ?? model.timelineIdentity(for: messages[messages.count - 1])
                        let targetView = try XCTUnwrap(ConversationMotionProbeRegistry.views[targetID]?.value,
                            "The first visible frame must contain the requested message")
                        var ancestor = targetView.superview
                        while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
                        let scroll = try XCTUnwrap(ancestor as? UIScrollView)
                        if let anchorAtEntry {
                            XCTAssertEqual(try XCTUnwrap(rowTop(anchorAtEntry.id, in: scroll)), anchorAtEntry.top, accuracy: 2,
                                "The reading position must already be correct in the first visible frame")
                        } else {
                            XCTAssertEqual(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 1,
                                "The first visible frame must already be at latest")
                        }
                        let firstVisibleTime = (CACurrentMediaTime() - openingStarted) * 1000
                        // Keep observing after the first paint: a later correction
                        // is visible as an unwanted scroll during chat re-entry.
                        for _ in 0..<60 {
                            try await Task.sleep(for: .milliseconds(10))
                            if let anchorAtEntry {
                                XCTAssertEqual(try XCTUnwrap(rowTop(anchorAtEntry.id, in: scroll)), anchorAtEntry.top, accuracy: 2,
                                    "The restored message must stay fixed after the first visible frame")
                            } else {
                                XCTAssertEqual(scroll.layer.presentation()?.bounds.minY ?? scroll.contentOffset.y,
                                    ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 2,
                                    "Latest must stay fixed after the first visible frame")
                            }
                        }
                        return firstVisibleTime
                    }
                }
                XCTFail("Cached history did not become visible")
                return -1.0
            }
            defer { firstContent.cancel() }
            navigation.path = [.conversation(conversation)]
            let destination = try await waitForStack(count: 2)
            try await Task.sleep(for: .milliseconds(300))
            controller.view.layoutIfNeeded()
            XCTAssertEqual(model.messages(for: conversation).count, messages.count)
            XCTAssertNil(ConversationMotionProbeRegistry.views["conversation-initial-loading"],
                         "Cached navigation must not construct a loading placeholder")

            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
            _ = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try await Task.sleep(for: .milliseconds(150))
            var didDraw = false
            let image = renderer.image { _ in
                didDraw = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            XCTAssertTrue(didDraw)
            let cgImage = try XCTUnwrap(image.cgImage)
            var pixels = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
            let context = try XCTUnwrap(CGContext(
                data: &pixels, width: cgImage.width, height: cgImage.height,
                bitsPerComponent: 8, bytesPerRow: cgImage.width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
            var textPixels = 0
            for y in stride(from: 180, to: cgImage.height - 180, by: 3) {
                for x in stride(from: 24, to: cgImage.width - 80, by: 3) {
                    let offset = (y * cgImage.width + x) * 4
                    if pixels[offset + 3] > 240 && pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100 {
                        textPixels += 1
                    }
                }
            }
            if textPixels <= 30 {
                let attachment = XCTAttachment(image: image)
                attachment.name = "history-entry-\(entry)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            XCTAssertGreaterThan(textPixels, 30, "Entry \(entry) has cached messages but no visible transcript text")
            func scrollView(in view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView, !(scroll is UITextView) { return scroll }
                return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
            }
            let scroll = try XCTUnwrap(scrollView(in: destination.view))
            if let expectedAnchor {
                let top = try XCTUnwrap(rowTop(expectedAnchor.id, in: scroll), "The same message must be materialized on return")
                XCTAssertEqual(top, expectedAnchor.top, accuracy: 2,
                               "Re-entry must restore the same message at the same viewport position")
            } else {
                XCTAssertEqual(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 1)
            }
            let firstContentMilliseconds = try await firstContent.value
            let timing = XCTAttachment(string: "Entry \(entry), first visible content: \(firstContentMilliseconds) ms")
            timing.name = "Cached conversation opening timing"
            timing.lifetime = .keepAlways
            add(timing)
            print("[ConversationOpening] entry=\(entry) first-content-ms=\(firstContentMilliseconds)")
            let targetOffset = max(0, scroll.contentSize.height - scroll.bounds.height) * 0.5
            scroll.setContentOffset(CGPoint(x: 0, y: targetOffset), animated: false)
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertLessThan(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll) - 12,
                              "Reading history must not be pulled back to the tail")
            let viewport = scroll.bounds.inset(by: scroll.adjustedContentInset)
            let visibleRows = messages.compactMap { message -> (id: String, top: CGFloat)? in
                let id = model.timelineIdentity(for: message)
                guard let view = ConversationMotionProbeRegistry.views[id]?.value,
                      view.window === window,
                      view.convert(view.bounds, to: scroll).intersects(viewport),
                      let top = rowTop(id, in: scroll) else { return nil }
                return (id, top)
            }
            expectedAnchor = try XCTUnwrap(visibleRows.min { $0.top < $1.top })
            let leavingAt = Date()
            navigation.path = []
            _ = try await waitForStack(count: 1)
            var savedPosition: ConversationViewportSnapshot?
            // UIKit can finish its pop before SwiftUI delivers onDisappear.
            // Wait for this visit's save, rather than accepting an older snapshot.
            for _ in 0..<100 {
                let snapshot = model.conversationViewportMemory.resumedPosition(
                    for: "\(accountID):\(conversation.id):conversation", latestMessageID: messages.last?.id,
                    availableMessageIDs: Set(messages.map(\.id)), now: Date()
                )
                if let snapshot, snapshot.leftAt >= leavingAt { savedPosition = snapshot; break }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertNotNil(savedPosition, "Entry \(entry) must save the inspected viewport")
            // An older message can reflow while this conversation is closed.
            // The latest ID is unchanged, so quick return must retain the read message.
            if entry == 1 {
                let edited = await model.editMessage(messages[0],
                    text: String(repeating: "Expanded older message with additional details.\n", count: 35),
                    in: conversation)
                XCTAssertTrue(edited)
            }
        }
    }
}

@MainActor
private final class OpeningRevealProbe: ObservableObject {
    @Published var isReady = false
    @Published var animates = false
}

private struct OpeningRevealProbeView: View {
    @ObservedObject var state: OpeningRevealProbe
    var body: some View {
        Color.blue.frame(width: 160, height: 80)
            .background(ConversationMotionProbe(id: "opening-policy-probe"))
            .modifier(ConversationInitialContentReveal(isReady: state.isReady,
                animates: state.animates, reduceMotion: false))
    }
}

@MainActor
final class ConversationOpeningMotionTests: XCTestCase {
    func testLoadedMessagesCrossfadeFromSkeletonWithoutMoving() async throws {
        try await checkLoadingReveal()
    }

    func testCancelledPositioningCannotCompleteAfterLeaving() async throws {
        let positioner = ConversationInitialPositioner { false }
        let task = Task { await positioner.waitUntilPositioned() }
        await Task.yield()
        task.cancel()
        let positioned = await task.value
        XCTAssertFalse(positioned)
    }

    func testDisappearingViewCancelsItsPositioningRequest() async throws {
        let position = ConversationScrollPosition()
        let task = Task { await position.positionInitialViewport { false } }
        await Task.yield()
        position.cancelInitialPositioning()
        let positioned = await task.value
        XCTAssertFalse(positioned)
    }

    func testLateLoadingPolicyCannotHideAlreadyVisibleContent() async throws {
        ConversationMotionProbeRegistry.enabled = true
        defer {
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let state = OpeningRevealProbe()
        window.rootViewController = UIHostingController(rootView: OpeningRevealProbeView(state: state))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(100))
        state.isReady = true
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: "opening-policy-probe", in: window))
        state.animates = true
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: "opening-policy-probe", in: window),
                        "A delayed loading-policy update must not hide content after readiness")
    }

    private func checkLoadingReveal() async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        defer {
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true, previewHistoryLoadDelay: .seconds(5))
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "agent-session:loading-motion", kind: .agent,
            peerAccountId: accountID, agentId: "loading-agent", ownerDisplayName: "Tester",
            displayName: "Loading transition", lastMessage: "", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "loading-motion")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let controller = UIHostingController(rootView:
            MainTabView(initialPath: [.conversation(conversation)])
                .environmentObject(model)
                .environmentObject(KordiCallCoordinator())
                .environmentObject(KordiNotificationCoordinator())
        )
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKeyAndVisible() }
        controller.view.layoutIfNeeded()
        func opacity(_ id: String) -> Float? {
            guard let view = ConversationMotionProbeRegistry.views[id]?.value,
                  view.window === window, !view.bounds.isEmpty,
                  let layer = view.layer.presentation() else { return nil }
            var value: Float = 1
            var current: CALayer? = layer
            while let layer = current {
                if layer.isHidden { return 0 }
                value *= layer.opacity
                current = layer.superlayer
            }
            return value
        }
        for _ in 0..<150 {
            if opacity("conversation-initial-loading") == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(try XCTUnwrap(opacity("conversation-initial-loading")), 1, accuracy: 0.01)
        try await Task.sleep(for: .milliseconds(350))
        let message = ChatMessage(id: "loaded-report", conversationId: conversation.id, author: .agent,
            authorName: "Test agent", text: "## Ready to read\n\nThe message stays in place while the loading placeholder fades away.",
            createdAt: Date(), deliveryState: .read, errorMessage: nil, requestMessageId: nil)
        store.saveMessages([message], conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let rowID = model.timelineIdentity(for: message)
        model.hydrateCachedMessages(for: conversation)
        var loadingAlphas: [Float] = []
        var messageAlphas: [Float] = []
        var frames: [CGRect] = []
        for _ in 0..<80 {
            try await Task.sleep(for: .milliseconds(10))
            if let alpha = opacity("conversation-initial-loading") { loadingAlphas.append(alpha) }
            if let alpha = opacity(rowID), alpha > 0.01 {
                messageAlphas.append(alpha)
                if let frame = ConversationMotionProbeRegistry.frame(for: rowID, in: window) { frames.append(frame) }
            }
        }
        XCTAssertTrue(loadingAlphas.contains { $0 > 0.01 && $0 < 0.99 }, "The placeholder must fade out, not disappear in one frame")
        XCTAssertTrue(messageAlphas.contains { $0 > 0.01 && $0 < 0.99 }, "Loaded content must fade in")
        XCTAssertEqual(try XCTUnwrap(messageAlphas.last), 1, accuracy: 0.01)
        XCTAssertNil(ConversationMotionProbeRegistry.frame(for: "conversation-initial-loading", in: window))
        let first = try XCTUnwrap(frames.first)
        XCTAssertGreaterThan(frames.count, 5)
        for frame in frames {
            XCTAssertEqual(frame.minY, first.minY, accuracy: 2, "Revealing a message must not animate its reading position")
            XCTAssertEqual(frame.width, first.width, accuracy: 2)
        }
    }
}

@MainActor
final class ConversationReadingAnchorTests: XCTestCase {
    func testRestoresSamePartOfTallMessageAfterEarlierContentReflows() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let scroll = UIScrollView(frame: window.bounds)
        window.addSubview(scroll)
        scroll.contentSize = CGSize(width: 390, height: 5000)
        scroll.contentInset = UIEdgeInsets(top: 44, left: 0, bottom: 34, right: 0)
        let row = UIView(frame: CGRect(x: 0, y: 1200, width: 390, height: 1500))
        scroll.addSubview(row)
        scroll.contentOffset.y = 1700
        let position = ConversationScrollPosition()
        position.attach(to: scroll)
        position.register(row, messageID: "long-report")
        position.captureReadingAnchor()
        let anchor = try XCTUnwrap(position.readingAnchor)
        XCTAssertEqual(anchor.messageID, "long-report")
        XCTAssertEqual(anchor.offsetFromViewportTop, -544)

        // Changed measurements before this row invalidate the old absolute offset.
        row.frame.origin.y += 650
        scroll.contentSize.height += 650
        XCTAssertFalse(position.restore(anchor))
        XCTAssertEqual(scroll.contentOffset.y, 2350, accuracy: 1)
        XCTAssertTrue(position.restore(anchor))
        position.captureReadingAnchor()
        XCTAssertEqual(position.readingAnchor, anchor)
    }

    func testDetachedRowsCannotReplaceVisibleAnchor() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let scroll = UIScrollView(frame: window.bounds)
        window.addSubview(scroll)
        scroll.contentSize = CGSize(width: 390, height: 3000)
        let visible = UIView(frame: CGRect(x: 0, y: 500, width: 390, height: 300))
        let detached = UIView(frame: CGRect(x: 0, y: 450, width: 390, height: 400))
        scroll.addSubview(visible)
        scroll.contentOffset.y = 550
        let position = ConversationScrollPosition()
        position.attach(to: scroll)
        position.register(visible, messageID: "visible")
        position.register(detached, messageID: "detached")
        position.captureReadingAnchor()
        let anchor = try XCTUnwrap(position.readingAnchor)
        XCTAssertEqual(anchor.messageID, "visible")
        visible.removeFromSuperview()
        XCTAssertFalse(position.restore(anchor))
        position.captureReadingAnchor()
        XCTAssertNil(position.readingAnchor)
    }

    func testMissingMessageDiscardsQuickReturnAnchor() {
        let memory = ConversationViewportMemory()
        let now = Date()
        memory.remember(key: "test", messageID: "removed", latestMessageID: "latest",
            readingAnchor: ConversationReadingAnchor(messageID: "removed", offsetFromViewportTop: -150), at: now)
        XCTAssertNil(memory.resumedPosition(for: "test", latestMessageID: "latest",
            availableMessageIDs: ["latest"], now: now.addingTimeInterval(1)))
    }
}

private enum HistoryNavigationWaitError: Error {
    case incompleteTransition
}

final class ConversationReadPresentationTests: XCTestCase {
    func testPendingIOSRequestQueuesImmediatelyBehindSyncedMacExecution() throws {
        let fixture = agentQueueFixture()
        let request = try XCTUnwrap(fixture.first { $0.id == "request-2" })
        let beforeAdmission = fixture.filter { ["request-1", "response-1", "request-2"].contains($0.id) }
        let phase = try XCTUnwrap(AgentSessionQueuePresentation.pendingPhase(
            requestID: request.id, createdAt: request.createdAt, messages: beforeAdmission,
            kind: .agent, locallyQueued: false
        ))
        XCTAssertEqual(phase, .queued)
        var placeholder = try XCTUnwrap(fixture.first { $0.id == "response-2" })
        placeholder.agentExecution = AgentExecutionSnapshot(
            phase: phase, summary: "Queued next", steps: [], thinkingText: nil,
            tools: nil, startedAtMs: 2_000, updatedAtMs: 2_000, completed: false
        )
        let firstFrame = AgentSessionQueuePresentation.apply(to: beforeAdmission + [placeholder], kind: .agent)
        XCTAssertEqual(firstFrame.first { $0.id == request.id }?.agentQueuePosition, 1)
        XCTAssertFalse(firstFrame.contains { $0.author == .agent && $0.requestMessageId == request.id })
    }

    func testUnconfirmedAgentAdmissionDoesNotInventProcessingOrQueue() {
        let fixture = agentQueueFixture()
        let userMessages = fixture.filter { $0.author == .me }
        XCTAssertNil(AgentSessionQueuePresentation.pendingPhase(
            requestID: "request-1", createdAt: Date(timeIntervalSince1970: 1),
            messages: userMessages, kind: .agent, locallyQueued: false
        ))
        // A later queued request must not make the first request queue behind it.
        XCTAssertNil(AgentSessionQueuePresentation.pendingPhase(
            requestID: "request-1", createdAt: Date(timeIntervalSince1970: 1),
            messages: fixture.filter { $0.id != "response-1" }, kind: .agent, locallyQueued: false
        ))
        for kind: ConversationKind in [.group, .person] {
            XCTAssertEqual(AgentSessionQueuePresentation.pendingPhase(
                requestID: "request-2", createdAt: Date(timeIntervalSince1970: 2),
                messages: fixture, kind: kind, locallyQueued: true
            ), .preparing)
        }
    }

    func testCompletedMacRequestDoesNotCauseAStaleOptimisticQueue() throws {
        let fixture = agentQueueFixture()
        let earlier = fixture.filter { ["request-1", "response-1", "request-2"].contains($0.id) }
        var terminal = try XCTUnwrap(earlier.first { $0.id == "response-1" })
        for phase: AgentExecutionSnapshot.Phase in [.complete, .failed, .cancelled] {
            terminal.agentExecution = AgentExecutionSnapshot(
                phase: phase, summary: "Finished", steps: [], thinkingText: nil,
                tools: nil, startedAtMs: 1_000, updatedAtMs: 5_000, completed: true
            )
            XCTAssertNil(AgentSessionQueuePresentation.pendingPhase(
                requestID: "request-2", createdAt: Date(timeIntervalSince1970: 2),
                messages: [terminal] + earlier, kind: .agent, locallyQueued: false
            ))
        }
    }

    func testAgentSessionShowsQueuedRequestsWithoutRunningPlaceholders() {
        let messages = agentQueueFixture()
        let projected = AgentSessionQueuePresentation.apply(to: messages, kind: .agent)
        XCTAssertNil(projected.first { $0.id == "request-1" }?.agentQueuePosition)
        XCTAssertEqual(projected.first { $0.id == "request-2" }?.agentQueuePosition, 1)
        XCTAssertEqual(projected.first { $0.id == "request-3" }?.agentQueuePosition, 2)
        XCTAssertEqual(projected.filter { $0.author == .agent }.map(\.requestMessageId), ["request-1"])
        XCTAssertEqual(messages.first { $0.id == "request-2" }?.deliveryState, .delivered)
    }

    func testAgentQueueAdvancesAfterSuccessFailureOrCancellation() {
        for phase: AgentExecutionSnapshot.Phase in [.complete, .failed, .cancelled] {
            var messages = agentQueueFixture()
            var terminal = messages.first { $0.id == "response-1" }!
            terminal.agentExecution = AgentExecutionSnapshot(
                phase: phase, summary: "Finished", steps: [], thinkingText: nil,
                tools: nil, startedAtMs: 1_000, updatedAtMs: 4_000, completed: true
            )
            messages.append(terminal)
            let waiting = AgentSessionQueuePresentation.apply(to: messages, kind: .agent)
            XCTAssertEqual(waiting.first { $0.id == "request-2" }?.agentQueuePosition, 1)
            var started = messages.first { $0.id == "response-2" }!
            started.agentExecution = AgentExecutionSnapshot(
                phase: .preparing, summary: "Starting", steps: [], thinkingText: nil,
                tools: nil, startedAtMs: 5_000, updatedAtMs: 5_000, completed: false
            )
            messages.append(started)
            let projected = AgentSessionQueuePresentation.apply(to: messages, kind: .agent)
            XCTAssertNil(projected.first { $0.id == "request-2" }?.agentQueuePosition)
            XCTAssertEqual(projected.first { $0.id == "request-3" }?.agentQueuePosition, 1)
            XCTAssertTrue(projected.contains { $0.id == "response-2" })
        }
    }

    func testGroupAndContactRequestsDoNotUseTheAgentSessionQueue() {
        let messages = agentQueueFixture()
        for kind: ConversationKind in [.group, .person] {
            XCTAssertEqual(AgentSessionQueuePresentation.apply(to: messages, kind: kind), messages)
        }
    }

    func testHistoricalWritingDoesNotQueueAnAlreadyRunningRequest() {
        var messages = agentQueueFixture()
        for index in messages.indices where messages[index].author == .agent {
            messages[index].agentExecution = AgentExecutionSnapshot(
                phase: .writing, summary: "Writing", steps: [], thinkingText: nil,
                tools: nil, startedAtMs: 1, updatedAtMs: 1, completed: false
            )
        }
        let projected = AgentSessionQueuePresentation.apply(to: messages, kind: .agent)
        XCTAssertTrue(projected.allSatisfy { $0.agentQueuePosition == nil })
        XCTAssertEqual(projected.filter { $0.author == .agent }.count, 3)
    }

    private func agentQueueFixture() -> [ChatMessage] {
        (1...3).flatMap { index -> [ChatMessage] in
            let createdAt = Date(timeIntervalSince1970: Double(index))
            let request = ChatMessage(
                id: "request-\(index)", conversationId: "agent-session:test",
                author: .me, authorName: "You", text: "Message \(index)",
                createdAt: createdAt, deliveryState: .delivered,
                errorMessage: nil, requestMessageId: nil
            )
            let response = ChatMessage(
                id: "response-\(index)", conversationId: request.conversationId,
                author: .agent, authorName: "Kordi", text: "processing...",
                createdAt: createdAt.addingTimeInterval(0.001), deliveryState: .delivered,
                errorMessage: nil, requestMessageId: request.id,
                agentExecution: AgentExecutionSnapshot(
                    phase: index == 1 ? .preparing : .queued,
                    summary: index == 1 ? "Preparing" : "Queued next", steps: [], thinkingText: nil,
                    tools: nil, startedAtMs: Double(index) * 1_000,
                    updatedAtMs: Double(index) * 1_000, completed: false
                )
            )
            return [request, response]
        }
    }

    func testAgentSendAcknowledgementDoesNotWaitForRuntimeCompletion() throws {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi")
        let source = try String(
            contentsOf: iosDirectory.appendingPathComponent("App/AppModel.swift"),
            encoding: .utf8
        )
        let sendStart = try XCTUnwrap(source.range(of: "    func send(\n"))
        let sendEnd = try XCTUnwrap(source.range(
            of: "    func retry(",
            range: sendStart.upperBound..<source.endIndex
        ))
        let send = source[sendStart.lowerBound..<sendEnd.lowerBound]
        XCTAssertTrue(send.contains("startAgentRunInBackground("))
        XCTAssertFalse(send.contains("await startAgentRun("))

        let pollStart = try XCTUnwrap(source.range(of: "    private func pollForAgentReply("))
        let pollEnd = try XCTUnwrap(source.range(
            of: "    private struct MessageHistoryLoadResult",
            range: pollStart.upperBound..<source.endIndex
        ))
        XCTAssertFalse(source[pollStart.lowerBound..<pollEnd.lowerBound].contains("loadConversation("))
    }

    func testEmptyConversationLoadingHasVisibleProgress() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/ConversationInitialLoadingView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("ProgressView(\"Loading conversation…\")"))
    }

    func testChatDeleteShowsImmediateStableAlertPresentation() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(source.contains("Task.sleep(for: .milliseconds(180))"))
        XCTAssertEqual(source.components(separatedBy: "deleteTarget = conversation").count - 1, 2)
        XCTAssertTrue(source.contains(".alert(\n            \"Delete this chat from your list?\""))
        XCTAssertTrue(source.contains("It will return only when a new visible message arrives."))
        XCTAssertFalse(source.contains("deleteTarget.map { \"delete:"))
        XCTAssertFalse(source.contains(".id(deleteTarget?.sessionId"))
        XCTAssertFalse(source.contains("listLayoutIdentity"))
        XCTAssertFalse(source.contains(".confirmationDialog(\n            \"Delete this chat from your list?\""))
        XCTAssertEqual(
            source.components(separatedBy: "Button(role: .destructive) {")
                .dropFirst()
                .filter { $0.prefix(160).contains("requestDelete") }
                .count,
            2,
            "Only context-menu delete actions may be destructive before confirmation"
        )
    }

    func testChatSwipeActionsUseCircularTargetsBehindTranslatedRows() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("private let actionDiameter: CGFloat = 44"))
        XCTAssertTrue(source.contains(".background(action.color, in: Circle())"))
        XCTAssertTrue(source.contains(".scaleEffect(reduceMotion ? 1 : minimumActionScale + (1 - minimumActionScale) * progress)"))
        XCTAssertTrue(source.contains(".opacity(progress)"))
        XCTAssertTrue(source.contains(".chatRowSwipeGesture(onChanged: updateSwipe, onEnded: finishSwipe, onCancelled: cancelSwipe)"))
        XCTAssertTrue(source.contains(".offset(x: displayedOffset)"))
        XCTAssertTrue(source.contains(".zIndex(1)"))
        XCTAssertTrue(source.contains("ChatRowSwipeMotion.settlingAnimation(reduceMotion: reduceMotion)"))
        XCTAssertEqual(
            source.components(separatedBy: "guard !dismissActiveSwipeActions() else { return }").count - 1,
            6
        )
        XCTAssertFalse(source.contains(".swipeActions(edge:"))
    }

    func testArchivedChatsRemainOpenableAndGroupSessionsStayGrouped() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("@State private var selectedConversation: ConversationSummary?"))
        XCTAssertTrue(source.contains(".navigationDestination(item: $selectedConversation)"))
        XCTAssertTrue(source.contains("GroupSpaceCatalog.build(\n            conversations: conversations"))
        XCTAssertTrue(source.contains("Task { _ = await model.restoreGroupSpace(space) }"))
    }

    func testArchiveAndRestoreUpdateTheListBeforeWaitingForCloud() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/AppModel.swift"),
            encoding: .utf8
        )
        let boundaries = [
            ("func archiveGroupSpace", "func restoreGroupSpace"),
            ("func restoreGroupSpace", "func archiveConversation"),
            ("func archiveConversation", "func restoreConversation"),
            ("func restoreConversation", "private func moveConversations"),
        ]

        for (startMarker, endMarker) in boundaries {
            let start = try XCTUnwrap(source.range(of: startMarker))
            let end = try XCTUnwrap(source.range(
                of: endMarker,
                range: start.upperBound..<source.endIndex
            ))
            let action = source[start.lowerBound..<end.lowerBound]
            let beginMutation = try XCTUnwrap(action.range(of: "beginSessionVisibilityMutation()"))
            let localUpdate = try XCTUnwrap(action.range(of: "moveConversations("))
            let cloudRequest = try XCTUnwrap(action.range(of: "try await"))
            XCTAssertTrue(action.contains("defer { endSessionVisibilityMutation() }"))
            XCTAssertLessThan(beginMutation.lowerBound, localUpdate.lowerBound)
            XCTAssertLessThan(localUpdate.lowerBound, cloudRequest.lowerBound)
        }
    }

    func testPinUpdatesTheListBeforeWaitingForCloud() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/AppModel.swift"),
            encoding: .utf8
        )
        let boundaries = [
            ("func setConversationPinned", "func setConversationMuted"),
            ("func setGroupSpacePinned", "func setGroupSpaceMuted"),
        ]

        for (startMarker, endMarker) in boundaries {
            let start = try XCTUnwrap(source.range(of: startMarker))
            let end = try XCTUnwrap(source.range(
                of: endMarker,
                range: start.upperBound..<source.endIndex
            ))
            let action = source[start.lowerBound..<end.lowerBound]
            let beginMutation = try XCTUnwrap(action.range(of: "beginSessionVisibilityMutation()"))
            let localUpdate = try XCTUnwrap(action.range(of: "if pinned {"))
            let cloudRequest = try XCTUnwrap(action.range(of: "try await"))
            XCTAssertTrue(action.contains("defer { endSessionVisibilityMutation() }"))
            XCTAssertEqual(action.components(separatedBy: "if pinned {").count - 1, 1)
            XCTAssertLessThan(beginMutation.lowerBound, localUpdate.lowerBound)
            XCTAssertLessThan(localUpdate.lowerBound, cloudRequest.lowerBound)
        }
    }

    func testVisibilitySnapshotCannotOverwriteAnOverlappingOptimisticMutation() {
        XCTAssertTrue(SessionVisibilitySnapshotPolicy.shouldApply(
            startRevision: 4,
            currentRevision: 4,
            pendingMutationCount: 0
        ))
        XCTAssertFalse(SessionVisibilitySnapshotPolicy.shouldApply(
            startRevision: 4,
            currentRevision: 6,
            pendingMutationCount: 0
        ))
        XCTAssertFalse(SessionVisibilitySnapshotPolicy.shouldApply(
            startRevision: 4,
            currentRevision: 4,
            pendingMutationCount: 1
        ))
    }

    func testDeleteUpdatesTheListBeforeWaitingForCloud() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/AppModel.swift"),
            encoding: .utf8
        )
        let start = try XCTUnwrap(source.range(of: "func deleteConversation"))
        let end = try XCTUnwrap(source.range(
            of: "private func removeConversationLocally",
            range: start.upperBound..<source.endIndex
        ))
        let action = source[start.lowerBound..<end.lowerBound]
        let beginMutation = try XCTUnwrap(action.range(of: "beginSessionVisibilityMutation()"))
        let cloudRequest = try XCTUnwrap(action.range(of: "try await api.deleteSession"))
        let visibilityCheck = try XCTUnwrap(action.range(of: "try? await api.listSessionVisibility"))
        let localRemoval = try XCTUnwrap(action.range(of: "removeConversationLocally(conversation)"))
        let rollback = try XCTUnwrap(action.range(of: "conversations.append(contentsOf: visibleRows)"))

        XCTAssertTrue(action.contains("defer { endSessionVisibilityMutation() }"))
        XCTAssertLessThan(beginMutation.lowerBound, localRemoval.lowerBound)
        XCTAssertLessThan(localRemoval.lowerBound, cloudRequest.lowerBound)
        XCTAssertLessThan(cloudRequest.lowerBound, visibilityCheck.lowerBound)
        XCTAssertLessThan(visibilityCheck.lowerBound, rollback.lowerBound)
        XCTAssertTrue(action.contains("conversations.append(contentsOf: visibleRows)"))
        XCTAssertTrue(action.contains("archivedConversations.append(contentsOf: archivedRows)"))
    }

    func testGroupSessionRowsShowOnlyTheLatestMessagePreview() throws {
        let chatsDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Chats")
        let source = try String(
            contentsOf: chatsDirectory.appendingPathComponent("GroupSpaceRow.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("BlobEmojiPreviewText(text: session.lastMessage.nonEmpty ?? \"No messages yet\")"))
        XCTAssertFalse(source.contains("messageCountText"))
    }

    func testGroupExpansionSharesMotionAndHonorsReducedMotion() throws {
        let chatsDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Chats")
        let homeSource = try String(
            contentsOf: chatsDirectory.appendingPathComponent("ChatHomeView.swift"),
            encoding: .utf8
        )
        let rowSource = try String(
            contentsOf: chatsDirectory.appendingPathComponent("GroupSpaceRow.swift"),
            encoding: .utf8
        )
        let groupToggles = homeSource.components(separatedBy: "private func toggleGroupSpace").dropFirst()

        XCTAssertEqual(groupToggles.count, 2)
        for suffix in groupToggles {
            let end = suffix.range(of: "\n    private func ")?.lowerBound ?? suffix.endIndex
            XCTAssertTrue(suffix[..<end].contains("withAnimation(reduceMotion ? nil : GroupChannelDisclosureMotion.animation)"))
        }
        XCTAssertTrue(rowSource.contains("accessibilityReduceMotion ? nil : GroupChannelDisclosureMotion.animation"))
        XCTAssertTrue(rowSource.contains("value: isExpanded"))
    }

    func testPinRebuildsOnlyTheActiveChatListLayouts() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("private var pinLayoutIdentity: [String]"))
        XCTAssertTrue(source.contains("model.pinnedSessionIds.map { \"session:"))
        XCTAssertTrue(source.contains("model.pinnedGroupSpaceIds.map { \"group:"))
        XCTAssertEqual(source.components(separatedBy: ".id(pinLayoutIdentity)").count - 1, 2)
        XCTAssertFalse(source.contains("listLayoutIdentity"))
    }

    func testContactsRemainVisibleWithoutAChatAndProfileUsesDirectChatAction() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features")
        let contacts = try String(
            contentsOf: root.appendingPathComponent("Contacts/ContactsView.swift"),
            encoding: .utf8
        )
        let details = try String(
            contentsOf: root.appendingPathComponent("Conversation/SessionDetailSheet.swift"),
            encoding: .utf8
        )
        let app = try String(
            contentsOf: root.deletingLastPathComponent().appendingPathComponent("App/KordiApp.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(contacts.contains("if let conversation = model.conversations.first"))
        XCTAssertTrue(contacts.contains("if let conversation = model.conversationForContact(contact)"))
        XCTAssertTrue(contacts.contains("NavigationLink(value: conversation)"))
        XCTAssertTrue(contacts.contains(".task { _ = await model.restoreConversationIfNeeded(conversation) }"))
        XCTAssertTrue(contacts.contains(".navigationDestination(for: ConversationSummary.self)"))
        XCTAssertFalse(contacts.contains("selectedConversation"))
        XCTAssertTrue(app.contains("ContactsView()"))
        XCTAssertTrue(details.contains("case .person: [.call, .video, .mute, .chat]"))
        XCTAssertFalse(details.contains("case .person: [.call, .video, .mute, .more]"))
    }

    func testReactionChipOverlapsTheBubbleWithoutShrinkingItsTouchTarget() {
        XCTAssertEqual(MessageBubble.reactionChipVerticalLift, 14)
    }

    func testEditedMessageStateRoundTripsAndDrivesBubbleMetadata() throws {
        let editedAt = Date(timeIntervalSince1970: 2)
        let message = ChatMessage(
            id: "edited-message",
            conversationId: "conversation",
            author: .person,
            authorName: "Mira",
            text: "Updated text",
            createdAt: Date(timeIntervalSince1970: 1),
            editedAt: editedAt,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )
        let decoded = try JSONDecoder().decode(
            ChatMessage.self,
            from: JSONEncoder().encode(message)
        )
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/MessageBubble.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(decoded.isEdited)
        XCTAssertEqual(decoded.editedAt, editedAt)
        XCTAssertTrue(source.contains("Text(\"edited\", comment:"))
        XCTAssertTrue(source.contains("if message.isEdited"))
    }

    func testMessageActionsExposeEditAndBothDeletionScopes() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let actionSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )
        let conversationSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )
        let composerSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ComposerView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(actionSource.contains("actionButton(\"Edit\""))
        XCTAssertTrue(actionSource.contains("mediaAttachment == nil ? \"Delete\" : \"Delete photo\""))
        XCTAssertTrue(actionSource.contains("deleteChoiceButton(deleteForEveryoneLabel)"))
        XCTAssertTrue(actionSource.contains("deleteChoiceButton(mediaAttachment == nil ? \"Delete for me\" : \"Delete photo for me\")"))
        XCTAssertTrue(actionSource.contains("isConfirmingDelete = true"))
        XCTAssertTrue(conversationSource.contains("? \"Delete for everyone\""))
        XCTAssertTrue(conversationSource.contains(": \"Delete for me and \\(conversation.displayName)\""))
        XCTAssertFalse(conversationSource.contains("\"Delete this message?\""))
        XCTAssertFalse(conversationSource.contains("value: visibleTimelineRows.map(\\.id)"))
        XCTAssertTrue(conversationSource.contains("editingMessage: editTarget"))
        XCTAssertTrue(composerSource.contains("editPreview(editingMessage)"))
        XCTAssertTrue(composerSource.contains("Text(\"Edit message\")"))
        XCTAssertFalse(conversationSource.contains("MessageEditSheet("))
    }

    func testParticleSnapshotRemovesWallpaperWithoutRemovingMessagePixels() throws {
        func image(_ pixels: [UInt8]) -> CGImage {
            let provider = CGDataProvider(data: Data(pixels) as CFData)!
            return CGImage(width: 4, height: 1, bitsPerComponent: 8, bitsPerPixel: 32,
                           bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(),
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                               .union(.byteOrder32Big),
                           provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        }
        let background = image([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255])
        let source = image([10, 20, 30, 255, 200, 30, 40, 255, 71, 81, 91, 255, 20, 180, 220, 255])
        let masked = try XCTUnwrap(MessageDeleteSnapshotMask.image(source: source, background: background))
        let data = try XCTUnwrap(masked.dataProvider?.data) as Data
        XCTAssertEqual(Array(data[0..<4]), [0, 0, 0, 0])
        XCTAssertEqual(Array(data[4..<8]), [200, 30, 40, 255])
        XCTAssertEqual(Array(data[8..<12]), [0, 0, 0, 0])
        XCTAssertEqual(Array(data[12..<16]), [20, 180, 220, 255])
        XCTAssertNil(MessageDeleteSnapshotMask.image(source: background, background: background))
    }

    func testParticleReflowUsesActualSurvivorPositionsForBothScrollAnchors() {
        func frame(_ y: CGFloat) -> CGRect { CGRect(x: 0, y: y, width: 390, height: 50) }
        let before = ["above": frame(20), "deleted": frame(70), "below": frame(290)]
        XCTAssertEqual(MessageDeleteReflow.offsets(
            before: before, after: ["above": frame(20), "below": frame(70), "new": frame(120)]
        ), ["below": 220])
        XCTAssertEqual(MessageDeleteReflow.offsets(
            before: before, after: ["above": frame(240), "below": frame(290)]
        ), ["above": -220])
        XCTAssertEqual(MessageDeleteReflow.offsets(
            before: before, after: ["above": frame(57), "below": frame(282)]
        ), ["above": -37, "below": 8])
    }

    func testDeletingLatestMessageDoesNotStartASecondScrollAnimation() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: true, isAtBottom: true,
            previousLatestMessageID: "deleted-photo", currentLatestMessageID: "previous-message",
            isDeletingLatestMessage: true
        ))
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: true, isAtBottom: true,
            previousLatestMessageID: "previous-message", currentLatestMessageID: "new-message",
            isDeletingLatestMessage: false
        ))
    }

    func testParticleCountIsBoundedForTextPhotosAndTallMessages() {
        for (width, height) in [(12, 30), (280, 48), (348, 690), (402, 874), (430, 1800)] {
            let grid = MessageDeleteParticleGeometry.grid(width: width, height: height)
            XCTAssertLessThanOrEqual(grid.columns * grid.rows, 3_200)
            XCTAssertGreaterThanOrEqual(grid.columns * grid.cellSize, width)
            XCTAssertGreaterThanOrEqual(grid.rows * grid.cellSize, height)
            XCTAssertGreaterThanOrEqual(grid.cellSize, 3)
        }
    }

    func testParticlePipelineIsAvailableOnDevice() async {
        let resources = await MessageDeleteParticleResources.prepared.value
        XCTAssertNotNil(resources, "The normal deletion path must render particles, not silently fall back.")
    }

    @MainActor
    func testOverlayInstallsWhenItsAnchorAttachesAfterInitialLayout() async {
        let host = UIHostingController(rootView: WindowOverlayPresenter(
            passthroughFrame: nil, allowsInteraction: false, animatesRemoval: false
        ) { _ in Text("Particle overlay") })
        host.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        host.view.layoutIfNeeded()
        await Task.yield()
        let window = UIWindow(frame: host.view.bounds)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        await Task.yield()
        XCTAssertGreaterThan(window.subviews.count, 1, "The overlay must install even if the anchor was initially detached.")
        XCTAssertEqual(window.subviews.last?.isUserInteractionEnabled, false)
    }

    @MainActor
    func testEmptyReactionShelfDoesNotReserveMessageSpacing() {
        func content(_ reactions: [MessageReaction]) -> some View {
            VStack(spacing: 4) {
                Color.clear.frame(width: 100, height: 50)
                MessageBubbleAccessoryRow(reactions: reactions, threadReplyCount: 0,
                    threadHasUnread: false, threadAgentState: nil, ownAccountId: "self",
                    scrollAnchor: .leading, onReact: { _ in }, onOpenThread: {})
            }
        }
        let host = UIHostingController(rootView: content([]))
        let proposal = CGSize(width: 310, height: 800)
        let emptySize = host.sizeThatFits(in: proposal)
        XCTAssertEqual(emptySize.height, 50, accuracy: 0.5)
        host.rootView = content([MessageReaction(value: "👍", accountIds: ["self"])])
        XCTAssertGreaterThan(host.sizeThatFits(in: proposal).height, emptySize.height)
        host.rootView = content([])
        XCTAssertEqual(host.sizeThatFits(in: proposal).height, emptySize.height, accuracy: 0.5)
    }

    @MainActor
    func testOverlayControlsKeepTouchesWhenTheyOverlapLongText() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let anchor = UIView(frame: window.bounds)
        controller.view.addSubview(anchor)
        let regions = WindowOverlayHitTestRegions()
        regions.controlFrames = [CGRect(x: 20, y: 100, width: 320, height: 52),
                                 CGRect(x: 20, y: 550, width: 240, height: 100)]
        let coordinator = WindowOverlayPresenter<Text>.Coordinator(rootView: Text("Actions"))
        coordinator.install(from: anchor, passthroughFrame: CGRect(x: 20, y: 50, width: 320, height: 650),
                            hitTestRegions: regions) { _ in Text("Actions") }
        defer { coordinator.remove(animated: false) }
        let overlay = try XCTUnwrap(window.subviews.last)
        XCTAssertTrue(overlay.point(inside: CGPoint(x: 100, y: 120), with: nil))
        XCTAssertTrue(overlay.point(inside: CGPoint(x: 100, y: 580), with: nil))
        XCTAssertFalse(overlay.point(inside: CGPoint(x: 100, y: 300), with: nil))
        // Region updates must take effect without reinstalling the host.
        regions.controlFrames = [CGRect(x: 20, y: 300, width: 320, height: 200)]
        XCTAssertFalse(overlay.point(inside: CGPoint(x: 100, y: 120), with: nil))
        XCTAssertTrue(overlay.point(inside: CGPoint(x: 100, y: 330), with: nil))
    }

    @MainActor
    func testParticleWindowDoesNotInterceptTouches() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let anchor = UIView(frame: window.bounds)
        controller.view.addSubview(anchor)
        let coordinator = WindowOverlayPresenter<Text>.Coordinator(rootView: Text("Particles"))
        coordinator.allowsInteraction = false
        coordinator.install(from: anchor, passthroughFrame: nil) { _ in Text("Particles") }
        XCTAssertEqual(window.subviews.last?.isUserInteractionEnabled, false)
        XCTAssertTrue(window.hitTest(CGPoint(x: 180, y: 400), with: nil) === anchor)
        coordinator.remove(animated: false)
    }

    func testAttachmentDeletionRetainsTheOriginalRowUntilParticleRemoval() throws {
        var target = try XCTUnwrap(agentQueueFixture().first)
        let first = ChatAttachment(attachmentId: "photo-one", name: "One.png", kind: .image,
                                   mimeType: "image/png", sizeBytes: 1, previewURL: nil)
        let second = ChatAttachment(attachmentId: "photo-two", name: "Two.png", kind: .image,
                                    mimeType: "image/png", sizeBytes: 1, previewURL: nil)
        target.attachments = [first, second]
        target.text = "Original caption"
        let deletion = MessageDeletionPresentation(message: target, messages: [target], attachmentID: first.id)
        var authoritative = target
        authoritative.attachments = [second]
        authoritative.text = "Updated caption"
        let retained = try XCTUnwrap(deletion.retainingMessage(in: [authoritative]).first)
        XCTAssertEqual(retained.attachments.map(\.id), [first.id, second.id])
        XCTAssertEqual(retained.text, "Original caption")
        XCTAssertEqual(authoritative.attachments.map(\.id), [second.id])
        XCTAssertEqual(authoritative.text, "Updated caption")
        XCTAssertEqual(deletion.retainingMessage(in: []).map(\.id), [target.id])
    }

    func testDeletionRetainsSourceWhenSyncRemovesItBeforeRequestReturns() throws {
        let messages = agentQueueFixture()
        let target = try XCTUnwrap(messages.dropFirst().first)
        let deletion = MessageDeletionPresentation(message: target, messages: messages)
        let synced = messages.filter { $0.id != target.id }
        XCTAssertEqual(deletion.retainingMessage(in: synced).map(\.id), messages.map(\.id))
        XCTAssertEqual(deletion.retainingMessage(in: messages).map(\.id), messages.map(\.id))
    }

    func testDeletionPreservesOrderWhenHistoryAndNewMessagesArrive() throws {
        let messages = agentQueueFixture()
        let target = try XCTUnwrap(messages.dropFirst().first)
        let deletion = MessageDeletionPresentation(message: target, messages: messages)
        let older = ChatMessage(
            id: "older-page", conversationId: target.conversationId, author: .person,
            authorName: "Sam", text: "Earlier", createdAt: .distantPast,
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil
        )
        let newer = ChatMessage(
            id: "incoming-message", conversationId: target.conversationId, author: .person,
            authorName: "Sam", text: "New", createdAt: .distantFuture,
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil
        )
        let synced = [older] + messages.filter { $0.id != target.id } + [newer]
        XCTAssertEqual(
            deletion.retainingMessage(in: synced).map(\.id),
            ([older] + messages + [newer]).map(\.id)
        )
        let last = try XCTUnwrap(messages.last)
        let lastDeletion = MessageDeletionPresentation(message: last, messages: messages)
        XCTAssertEqual(
            lastDeletion.retainingMessage(in: Array(messages.dropLast()) + [newer]).map(\.id),
            (messages + [newer]).map(\.id)
        )
    }

    @MainActor
    func testMessageMenuDismissalCompletionRunsAfterOverlayIsDetached() async {
        for animated in [false, true] {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
            let controller = UIViewController()
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            let anchor = UIView(frame: window.bounds)
            controller.view.addSubview(anchor)
            let coordinator = WindowOverlayPresenter<Text>.Coordinator(rootView: Text("Delete"))
            let originalSubviewCount = window.subviews.count
            coordinator.install(from: anchor, passthroughFrame: nil) { _ in Text("Delete") }
            XCTAssertEqual(window.subviews.count, originalSubviewCount + 1)
            let dismissed = expectation(description: "Menu is detached before deletion begins")
            coordinator.remove(animated: animated) {
                XCTAssertEqual(window.subviews.count, originalSubviewCount)
                dismissed.fulfill()
            }
            await fulfillment(of: [dismissed], timeout: 2)
        }
    }

    @MainActor
    func testConfirmedPreviewDeletionRetainsOnlyThePresentationUntilAnimation() async throws {
        for forEveryone in [false, true] {
            let model = AppModel(previewMode: true)
            let conversation = try XCTUnwrap(model.conversations.first { $0.id == "person:acct_maya" })
            let messages = model.messages(for: conversation)
            let target = try XCTUnwrap(messages.first { $0.author == .me })
            var presentation: MessageDeletionPresentation? = MessageDeletionPresentation(
                message: target, messages: messages
            )
            let succeeded = await model.deleteMessage(target, forEveryone: forEveryone, in: conversation)
            XCTAssertTrue(succeeded)
            let current = model.messages(for: conversation)
            XCTAssertFalse(current.contains { $0.id == target.id })
            XCTAssertEqual(presentation?.retainingMessage(in: current).map(\.id), messages.map(\.id))
            presentation = nil
            XCTAssertEqual((presentation?.retainingMessage(in: current) ?? current).count, messages.count - 1)
        }
    }

    func testDeletionRetainsOnlyMessageAndHandlesDeletedNeighbors() throws {
        let messages = agentQueueFixture()
        let target = try XCTUnwrap(messages.first)
        let onlyMessage = MessageDeletionPresentation(message: target, messages: [target])
        XCTAssertEqual(onlyMessage.retainingMessage(in: []).map(\.id), [target.id])
        let deletion = MessageDeletionPresentation(message: messages[2], messages: messages)
        let remaining = [messages[0], messages[5]]
        XCTAssertEqual(
            deletion.retainingMessage(in: remaining).map(\.id),
            [messages[0].id, messages[2].id, messages[5].id]
        )
    }

    func testDeletionWaitsForConfirmationAndMenuDismissalInEitherOrder() throws {
        let messages = agentQueueFixture()
        let target = try XCTUnwrap(messages.first)
        for confirmsFirst in [false, true] {
            var deletion = MessageDeletionPresentation(message: target, messages: messages)
            XCTAssertFalse(deletion.canAnimateRemoval)
            deletion.isConfirmed = confirmsFirst
            deletion.isMenuDismissed = !confirmsFirst
            XCTAssertFalse(deletion.canAnimateRemoval)
            deletion.isConfirmed = true
            deletion.isMenuDismissed = true
            XCTAssertTrue(deletion.canAnimateRemoval)
            deletion.isSourceHidden = true
            XCTAssertFalse(deletion.canAnimateRemoval)
        }
    }

    func testMessageBubblesUseThemeAwareContrastForRepliesLinksAndMentions() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let markdownSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MarkdownMessageContent.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(bubbleSource.contains("lightAppearanceBubbleTintColor"))
        XCTAssertTrue(bubbleSource.contains("chatTheme == .quiet ? .clear"))
        XCTAssertFalse(bubbleSource.contains("chatTheme.peerText.opacity(0.07)"))
        XCTAssertTrue(bubbleSource.contains("chatTheme.peerText.opacity(0.12)"))
        XCTAssertTrue(bubbleSource.contains("replyPreviewBackgroundColor"))
        XCTAssertTrue(bubbleSource.contains("inlineAccent: bubbleInlineAccentColor"))
        XCTAssertTrue(markdownSource.contains("@Entry var messageInlineAccent: Color? = nil"))
        XCTAssertTrue(markdownSource.contains("inlineAccent ?? KordiTheme.signalBlue"))
    }

    func testSyntheticConversationPreviewExposesThemeControls() throws {
        let appSource = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/KordiApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(appSource.contains("--preview-theme-controls"))
        XCTAssertTrue(appSource.contains("PreviewThemeControls("))
        XCTAssertTrue(appSource.contains("ForEach(KordiChatTheme.allCases)"))
        XCTAssertTrue(appSource.contains("ForEach(AppAppearance.allCases)"))
    }

    func testDeleteResurrectionPreviewAddsFreshUnreadMayaMessage() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/PreviewData.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("--preview-delete-resurrection"))
        XCTAssertTrue(source.contains("maya-delete-resurrection"))
        XCTAssertTrue(source.contains("New message after deletion — this chat is back."))
    }

    func testReactionChipsMatchTheAvatarEdgeAndMacOSSurface() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/MessageBubble.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("scrollAnchor: message.author == .me ? .trailing : .leading"))
        XCTAssertTrue(source.contains(".defaultScrollAnchor(scrollAnchor)"))
        XCTAssertTrue(source.contains(".background(Color(uiColor: .tertiarySystemFill), in: Capsule())"))
        XCTAssertFalse(source.contains("KordiTheme.agentViolet.opacity(0.14)"))
    }

    func testThreadRepliesShareOneAccessoryRowAndCannotNest() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let conversationSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )
        let actionSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(bubbleSource.contains("MessageBubbleAccessoryRow("))
        XCTAssertTrue(bubbleSource.contains("!reactions.isEmpty || threadReplyCount > 0"))
        XCTAssertTrue(conversationSource.contains("allowsQuotedReplies: conversation.kind.supportsQuotedReplies"))
        XCTAssertTrue(conversationSource.contains("allowsThreadReply: scopedThreadRootMessageID == nil"))
        XCTAssertTrue(conversationSource.contains("content.navigationDestination(item: $activeRootMessageID)"))
        XCTAssertTrue(conversationSource.contains("threadReturnMessageID = trackedMessageID ??"))
        XCTAssertTrue(conversationSource.contains("rememberViewport(in: messages)"))
        XCTAssertTrue(conversationSource.contains("proxy.scrollTo(returnMessageID, anchor: initialViewport.scrollAnchor)"))
        XCTAssertTrue(conversationSource.contains("isNavigationReturnPending: threadReturnMessageID != nil"))
        XCTAssertTrue(conversationSource.contains("contentOffsetY: scrollView.contentOffset.y"))
        XCTAssertTrue(conversationSource.contains("exactScrollRestoreRequest = ConversationScrollRestoreRequest("))
        XCTAssertTrue(conversationSource.contains("restoreThreadReturnPosition(using: proxy)"))
        XCTAssertTrue(conversationSource.contains("threadReturnMessageID != nil || threadReturnScrollOffsetY != nil"))
        XCTAssertTrue(conversationSource.contains("trackedMessageID = nil"))
        XCTAssertTrue(conversationSource.contains("didRestoreContentOffset("))
        XCTAssertTrue(conversationSource.contains("scopedThreadRootMessageID.map"))
        XCTAssertTrue(actionSource.contains("actionButton(\"Reply in conversation\""))
        XCTAssertTrue(actionSource.contains("actionButton(\"Reply in thread\""))
        XCTAssertFalse(actionSource.contains("showsReplyDestinations"))
    }

    func testMessageActionsStopConversationPanningAfterTheHoldWins() {
        XCTAssertFalse(MessageGestureArbitration.allowsSimultaneousRecognition(
            with: UIPanGestureRecognizer()
        ))
        XCTAssertTrue(MessageGestureArbitration.allowsSimultaneousRecognition(
            with: UITapGestureRecognizer()
        ))
        XCTAssertTrue(MessageGestureArbitration.allowsSimultaneousRecognition(
            with: UILongPressGestureRecognizer()
        ))
    }

    func testMessageActionsAllowManualTextSelectionOnlyAfterOpening() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")

        let markdownSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MarkdownMessageContent.swift"),
            encoding: .utf8
        )
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let overlaySource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )
        let conversationSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(markdownSource.contains("textView.selectedRange = NSRange("))
        XCTAssertFalse(markdownSource.contains("textView.becomeFirstResponder()"))
        XCTAssertTrue(markdownSource.contains("content.textSelection(.enabled)"))
        XCTAssertTrue(markdownSource.contains("content.textSelection(.disabled)"))
        XCTAssertFalse(markdownSource.contains("SelectableMessageTextView"))
        XCTAssertTrue(bubbleSource.contains("allowsTextSelection: isActionPresented"))
        XCTAssertTrue(bubbleSource.contains("isHighlighted || isSelected"))
        XCTAssertTrue(bubbleSource.contains("value: showsSelectionHighlight"))
        XCTAssertTrue(bubbleSource.contains(".accessibilityAddTraits(isSelected ? .isSelected : [])"))
        XCTAssertTrue(overlaySource.contains("MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,"))
        XCTAssertTrue(overlaySource.contains("readers: readReceiptReaders"))
        XCTAssertTrue(overlaySource.contains("readers.prefix(4)"))
        XCTAssertTrue(overlaySource.contains("size: avatarSize"))
        XCTAssertTrue(overlaySource.contains("MessageDeliveryGlyph(state: .read"))
        XCTAssertFalse(overlaySource.contains("cornerSize: CGSize(width: 18, height: 18)"))
        XCTAssertTrue(overlaySource.contains("eoFill: true"))
        XCTAssertTrue(overlaySource.contains("performAction(onDismiss)"))
        XCTAssertTrue(overlaySource.contains("mediaAttachment == nil"))
        XCTAssertTrue(overlaySource.contains("AnyShape(Rectangle())"))
        XCTAssertTrue(overlaySource.contains("sourceFrame.offsetBy("))
        XCTAssertTrue(overlaySource.contains(".ignoresSafeArea()"))
        XCTAssertTrue(overlaySource.contains("MessageActionWindowOverlayView"))
        XCTAssertTrue(overlaySource.contains("passthroughFrame.contains(point)"))
        XCTAssertTrue(overlaySource.contains("withDuration: 0.18"))
        XCTAssertTrue(overlaySource.contains("UIAccessibility.isReduceMotionEnabled"))
        XCTAssertTrue(overlaySource.contains(".curveEaseOut"))
        XCTAssertFalse(overlaySource.contains("acceptsInput"))
        XCTAssertTrue(overlaySource.contains("actionButton(\"Select\""))
        XCTAssertTrue(conversationSource.contains("toggleSelection(message.id)"))
        XCTAssertFalse(conversationSource.contains("messageActionAcceptsInput"))
        XCTAssertFalse(conversationSource.contains("proxy.scrollTo(row.id, anchor: .bottom)"))
        XCTAssertFalse(conversationSource.contains(".toolbarBackground(.visible"))
        XCTAssertTrue(conversationSource.contains(".toolbar(navigationBarVisibility, for: .navigationBar)"))
        XCTAssertTrue(conversationSource.contains("showsNavigationChrome ? .visible : .automatic"))
        XCTAssertFalse(conversationSource.contains("showsNavigationChrome && messageActionMessage == nil ? .visible : .hidden"))
        XCTAssertTrue(conversationSource.contains("WindowOverlayPresenter("))
        XCTAssertTrue(conversationSource.contains("passthroughFrame:"))
        XCTAssertTrue(conversationSource.contains("MessageReadReceiptPresentation.label("))
    }

    func testDirectReadReceiptProjectsAndNamesThePeer() throws {
        let directConversation = conversation(id: "direct", kind: .person, unread: 0)
        let projected = CloudDirectMessageProjector.project(
            [CloudMessageDTO(
                messageId: "msg_read",
                fromAccountId: "acct_me",
                toAccountId: "acct_peer",
                body: "Seen message",
                createdAt: "2026-08-29T10:00:00Z",
                deliveredAt: "2026-08-29T10:00:01Z",
                readAt: "2026-08-29T10:00:02Z",
                readByAccountIds: [],
                direction: "outgoing",
                sessionId: directConversation.sessionId
            )],
            conversation: directConversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first)
        let readers = MessageReadReceiptPresentation.readers(
            for: message,
            in: directConversation
        )

        XCTAssertEqual(message.readByAccountIds, ["acct_peer"])
        XCTAssertEqual(message.readByCount, 1)
        XCTAssertEqual(message.deliveryState.label, "Seen")
        XCTAssertEqual(readers.map(\.displayName), ["Conversation"])
        XCTAssertEqual(
            MessageReadReceiptPresentation.label(for: message, readers: readers),
            "1 Seen"
        )
    }

    func testMessageActionsDoNotMoveTimelineDuringViewportChange() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldKeepLatestVisibleAfterViewportChange(
            hasRevealedInitialViewport: true,
            wasAtLatest: true,
            isMessageActionPresented: true,
            previousViewportSize: CGSize(width: 390, height: 700),
            currentViewportSize: CGSize(width: 390, height: 744)
        ))
    }

    func testCachedThreadTimelineRendersWithoutAnotherConversationLoad() {
        XCTAssertTrue(ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: "root",
            messageCount: 1
        ))
        XCTAssertFalse(ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: "root",
            messageCount: 0
        ))
        XCTAssertFalse(ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: nil,
            messageCount: 1
        ))
    }

    func testBlobEmojiCatalogAndRecentsAreSharedDeduplicatedAndBounded() throws {
        XCTAssertEqual(BlobEmojiCatalog.all.count, 547)
        XCTAssertEqual(BlobEmojiCatalog.all.filter(\.animated).count, 173)
        var stored = "[]"
        for emoji in BlobEmojiCatalog.all.prefix(30) {
            stored = BlobEmojiRecentStore.recording(emoji.id, in: stored)
        }
        let selectedID = BlobEmojiCatalog.all[10].id
        stored = BlobEmojiRecentStore.recording(selectedID, in: stored)
        let recent = BlobEmojiRecentStore.ids(from: stored)

        XCTAssertEqual(recent.first, selectedID)
        XCTAssertEqual(recent.count, 24)
        XCTAssertEqual(recent.filter { $0 == selectedID }.count, 1)
        XCTAssertNotNil(BlobEmojiCatalog.assetURL(for: BlobEmojiCatalog.all[0]))
        let animated = try XCTUnwrap(BlobEmojiCatalog.all.first(where: \.animated))
        let animatedURL = try XCTUnwrap(BlobEmojiCatalog.assetURL(for: animated))
        let animatedSource = try XCTUnwrap(CGImageSourceCreateWithURL(animatedURL as CFURL, nil))
        XCTAssertGreaterThan(CGImageSourceGetCount(animatedSource), 1)
        let decoded = try XCTUnwrap(AnimatedImageDecoder.image(
            at: animatedURL,
            animated: true,
            maximumPixelSize: 64
        ))
        XCTAssertGreaterThan(decoded.images?.count ?? 1, 1)
        XCTAssertTrue((decoded.images ?? [decoded]).allSatisfy {
            ($0.cgImage?.width ?? 0) <= 64 && ($0.cgImage?.height ?? 0) <= 64
        })
    }

    func testQuickReactionImagesAreBundledAndPrewarmed() async throws {
        let animated = try XCTUnwrap(BlobEmojiCatalog.all.first(where: \.animated))
        let storedRecents = BlobEmojiRecentStore.recording(animated.id, in: "[]")
        let reactions = BlobEmojiCatalog.quickReactions(
            storedRecentEmojiIDs: storedRecents
        )

        XCTAssertEqual(reactions.count, 6)
        XCTAssertEqual(reactions.first, animated)
        XCTAssertTrue(reactions.allSatisfy {
            BlobEmojiCatalog.assetURL(for: $0) != nil
        })

        await BlobEmojiCatalog.prewarmQuickReactions(
            storedRecentEmojiIDs: storedRecents
        )

        XCTAssertTrue(reactions.allSatisfy {
            BlobEmojiCatalog.cachedImage(for: $0, animated: false) != nil
        })
    }

    func testReactionMutationAddsTogglesAndRemovesWithoutDuplicates() {
        let added = AppModel.updatingReaction(
            "👍",
            accountId: "acct_me",
            active: true,
            in: []
        )
        XCTAssertEqual(added, [MessageReaction(value: "👍", accountIds: ["acct_me"])])
        XCTAssertEqual(
            AppModel.updatingReaction(
                "👍",
                accountId: "acct_me",
                active: true,
                in: added
            ),
            added
        )
        XCTAssertTrue(
            AppModel.updatingReaction(
                "👍",
                accountId: "acct_me",
                active: false,
                in: added
            ).isEmpty
        )
    }

    @MainActor
    func testSelectingFormattedTextDoesNotChangeItsLayout() {
        let samples = [
            "A short **bold** message with a [link](https://example.com).",
            "# Blob heading\n\nKeep **bold** and :blob:blobwave: rendered.\n\n- A list item",
            "# Notes\n\n- First item\n- Second **bold** item\n\n> A quoted passage.\n\n```swift\nlet value = 42\n```",
            Array(repeating: "A long paragraph with **emphasis** and readable text.", count: 70).joined(separator: "\n\n"),
            String(repeating: "A very long response. ", count: 2_000)
        ]
        for text in samples {
            let host = UIHostingController(rootView: MarkdownMessageContent(text: text).frame(width: 290, alignment: .leading))
            let proposal = CGSize(width: 290, height: CGFloat.greatestFiniteMagnitude)
            let original = host.sizeThatFits(in: proposal)
            host.rootView = MarkdownMessageContent(text: text, allowsTextSelection: true).frame(width: 290, alignment: .leading)
            let selected = host.sizeThatFits(in: proposal)
            host.rootView = MarkdownMessageContent(text: text).frame(width: 290, alignment: .leading)
            let returned = host.sizeThatFits(in: proposal)
            XCTAssertEqual(selected.width, original.width, accuracy: 0.5)
            XCTAssertEqual(selected.height, original.height, accuracy: 0.5)
            XCTAssertEqual(returned.height, original.height, accuracy: 0.5)
        }
    }

    @MainActor
    func testTallPreviewScrollKeepsItsOriginalSizeAndClampsMovement() {
        let source = CGRect(x: 20, y: -800, width: 300, height: 1_600)
        let layout = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: CGSize(width: 390, height: 700),
            showsReactions: true, reactionCount: 6, actionCount: 8
        )
        XCTAssertEqual(layout.previewFrame.size, source.size)
        XCTAssertLessThan(layout.previewFrame.minY, 0)
        XCTAssertGreaterThan(layout.scrollLimit, 0)
        XCTAssertTrue(layout.menuIsBelow)
        let scroll = MessageActionPreviewScroll()
        scroll.limit = layout.scrollLimit
        scroll.drag(translation: 200)
        XCTAssertEqual(scroll.offset, 200)
        scroll.drag(translation: 10_000)
        XCTAssertEqual(scroll.offset, layout.scrollLimit)
        scroll.endDrag()
        scroll.drag(translation: -10_000)
        XCTAssertEqual(scroll.offset, 0)
        scroll.reset()
        XCTAssertEqual(scroll.limit, 0)
    }

    func testActionOverlayStaysInsideTopAndBottomEdges() {
        let container = CGSize(width: 390, height: 700)
        let top = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 20, y: 70, width: 180, height: 70),
            containerSize: container,
            showsReactions: true,
            reactionCount: 4,
            actionCount: 5
        )
        let bottom = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 190, y: 590, width: 180, height: 70),
            containerSize: container,
            showsReactions: true,
            reactionCount: 4,
            actionCount: 5
        )
        let media = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 190, y: 280, width: 180, height: 240),
            containerSize: container,
            showsReactions: true,
            reactionCount: 4,
            actionCount: 8
        )
        let visibleMedia = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 150, y: 427, width: 228, height: 394),
            containerSize: CGSize(width: 390, height: 874),
            showsReactions: true,
            reactionCount: 6,
            actionCount: 7
        )
        let deleteConfirmation = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 190, y: 590, width: 180, height: 70),
            containerSize: container,
            showsReactions: false,
            reactionCount: 0,
            actionCount: 2,
            forcedMenuIsBelow: bottom.menuIsBelow
        )

        for layout in [top, bottom, media, deleteConfirmation] {
            XCTAssertGreaterThanOrEqual(layout.menuCenter.x - layout.menuWidth / 2, 12)
            XCTAssertLessThanOrEqual(layout.menuCenter.x + layout.menuWidth / 2, container.width - 12)
            XCTAssertGreaterThan(layout.menuCenter.y, 12)
            XCTAssertLessThan(layout.menuCenter.y, container.height - 12)
            XCTAssertGreaterThanOrEqual(layout.menuCenter.y - layout.menuHeight / 2, 12)
            XCTAssertLessThanOrEqual(
                layout.menuCenter.y + layout.menuHeight / 2,
                container.height - 12
            )
            XCTAssertGreaterThan(layout.reactionCenter.y, 12)
            XCTAssertLessThan(layout.reactionCenter.y, container.height - 12)
            XCTAssertGreaterThanOrEqual(layout.pickerCenter.x - layout.pickerWidth / 2, 12)
            XCTAssertLessThanOrEqual(
                layout.pickerCenter.x + layout.pickerWidth / 2,
                container.width - 12
            )
            XCTAssertGreaterThanOrEqual(layout.pickerCenter.y - layout.pickerHeight / 2, 12)
            XCTAssertLessThanOrEqual(
                layout.pickerCenter.y + layout.pickerHeight / 2,
                container.height - 12
            )
            XCTAssertLessThanOrEqual(
                layout.pickerCenter.y - layout.pickerHeight / 2,
                layout.reactionCenter.y - 26 + 0.001
            )
        }
        XCTAssertGreaterThan(top.menuCenter.y, top.reactionCenter.y)
        XCTAssertLessThan(bottom.menuCenter.y, bottom.reactionCenter.y)
        XCTAssertLessThanOrEqual(
            media.menuCenter.y + media.menuHeight / 2 + 8,
            media.reactionCenter.y - 26
        )
        XCTAssertEqual(visibleMedia.menuHeight, 318)
        XCTAssertEqual(visibleMedia.pickerHeight, 520)
        XCTAssertEqual(deleteConfirmation.menuHeight, 98)
        XCTAssertEqual(deleteConfirmation.menuIsBelow, bottom.menuIsBelow)
    }

    func testActionPresentationFitsBubbleAndMenusWithoutOverlap() {
        let cases: [(CGSize, CGRect)] = [
            (CGSize(width: 390, height: 700), CGRect(x: 20, y: 12, width: 180, height: 70)),
            (CGSize(width: 390, height: 700), CGRect(x: 20, y: -60, width: 300, height: 820)),
            (CGSize(width: 390, height: 700), CGRect(x: 190, y: 650, width: 180, height: 70)),
            (CGSize(width: 390, height: 280), CGRect(x: 20, y: -30, width: 300, height: 480)),
            (CGSize(width: 720, height: 280), CGRect(x: 400, y: 200, width: 260, height: 200))
        ]
        for (container, source) in cases {
            for showsReactions in [true, false] {
                let layout = MessageActionOverlayLayout.make(
                    sourceFrame: source, containerSize: container,
                    showsReactions: showsReactions, reactionCount: 6, actionCount: 8
                )
                let menu = CGRect(x: layout.menuCenter.x - layout.menuWidth / 2,
                                  y: layout.menuCenter.y - layout.menuHeight / 2,
                                  width: layout.menuWidth, height: layout.menuHeight)
                let reaction = CGRect(x: layout.reactionCenter.x - layout.reactionWidth / 2,
                                      y: layout.reactionCenter.y - 26,
                                      width: layout.reactionWidth, height: 52)
                let usable = CGRect(origin: .zero, size: container).insetBy(dx: 11.99, dy: 11.99)
                XCTAssertEqual(layout.previewFrame.size, source.size)
                XCTAssertTrue(usable.intersects(layout.previewFrame))
                if layout.scrollLimit == 0 { XCTAssertTrue(usable.contains(layout.previewFrame)) }
                XCTAssertTrue(usable.contains(menu))
                XCTAssertFalse(menu.intersects(layout.previewFrame))
                if showsReactions {
                    XCTAssertTrue(usable.contains(reaction))
                    if layout.scrollLimit == 0 { XCTAssertFalse(reaction.intersects(layout.previewFrame)) }
                    XCTAssertFalse(reaction.intersects(menu))
                }
                XCTAssertGreaterThanOrEqual(layout.menuHeight, 44)
                XCTAssertEqual(layout.previewFrame.width / source.width,
                               layout.previewFrame.height / source.height, accuracy: 0.001)
            }
        }
    }

    func testDeleteConfirmationKeepsTheSelectedBubbleInPlace() {
        let source = CGRect(x: 20, y: -60, width: 300, height: 820)
        let size = CGSize(width: 390, height: 700)
        let regular = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: size,
            showsReactions: true, reactionCount: 6, actionCount: 8
        )
        let confirmation = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: size,
            showsReactions: false, reactionCount: 0, actionCount: 2,
            forcedMenuIsBelow: regular.menuIsBelow, fixedPreviewFrame: regular.previewFrame
        )
        XCTAssertEqual(confirmation.previewFrame, regular.previewFrame)
        if regular.menuIsBelow {
            XCTAssertGreaterThanOrEqual(confirmation.menuCenter.y - confirmation.menuHeight / 2,
                                        regular.previewFrame.maxY + 8)
        } else {
            XCTAssertLessThanOrEqual(confirmation.menuCenter.y + confirmation.menuHeight / 2 + 8,
                                     regular.previewFrame.minY)
        }
    }

    func testImageLongPressUsesTheFullMessageActionMenu() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let overlaySource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )
        let imageSource = bubbleSource.components(separatedBy: "private struct MessageImageAttachment")[1]
            .components(separatedBy: "private enum MessageImagePresentation")[0]
        let gestureSource = bubbleSource.components(separatedBy: "enum MessageGestureArbitration")[1]
            .components(separatedBy: "private struct MessageImageAttachment")[0]
        let collectionSource = bubbleSource.components(separatedBy: "private struct MessageImageCollection")[1]
            .components(separatedBy: "enum MessageImageStack")[0]

        XCTAssertFalse(imageSource.contains(".contextMenu {"))
        XCTAssertFalse(imageSource.contains(".simultaneousGesture("))
        XCTAssertFalse(imageSource.contains("MessageImageGestureSurface"))
        XCTAssertFalse(imageSource.contains("Button(action: activate)"))
        XCTAssertTrue(imageSource.contains("MessageInteractionGestureBridge("))
        XCTAssertTrue(imageSource.contains("onTap: opensPreview ? activate : nil"))
        XCTAssertTrue(imageSource.contains("onLongPress: openActions"))
        XCTAssertTrue(gestureSource.contains("UILongPressGestureRecognizer"))
        XCTAssertTrue(gestureSource.contains("UITapGestureRecognizer"))
        XCTAssertTrue(gestureSource.contains("tap.require(toFail: longPress)"))
        XCTAssertTrue(gestureSource.contains("current as? UIScrollView"))
        XCTAssertTrue(gestureSource.contains("recognizer.cancelsTouchesInView = true"))
        XCTAssertFalse(imageSource.contains(".onGeometryChange(for: CGRect.self)"))
        XCTAssertTrue(gestureSource.contains("attachmentView.convert(attachmentView.bounds, to: window)"))
        XCTAssertTrue(imageSource.contains("onRequestActions(frame)"))
        XCTAssertTrue(collectionSource.contains("if presentation.isStackPreview"))
        XCTAssertTrue(collectionSource.contains("onPrepareActions(nil)"))
        XCTAssertTrue(collectionSource.contains("isExpanded = true"))
        XCTAssertTrue(collectionSource.contains("collapsedInteractionSurface"))
        XCTAssertTrue(bubbleSource.contains("!hasImageAttachments"))
        XCTAssertFalse(bubbleSource.contains("suppressesNextActionPresentation"))
        XCTAssertTrue(bubbleSource.contains("if actionAttachment == nil"))
        XCTAssertTrue(overlaySource.contains("actionButton(\"Review\""))
        XCTAssertTrue(overlaySource.contains("\"Download / Save to Files\""))
        XCTAssertTrue(overlaySource.contains("\"Add to \\(mediaKind.libraryName)\""))
        XCTAssertTrue(overlaySource.contains("\"Share\","))
        XCTAssertTrue(overlaySource.contains("systemImage: \"square.and.arrow.up\""))
        XCTAssertTrue(overlaySource.contains("action: onShareMessage"))
    }

    func testGroupedMessageImagesRenderBeforeTheirSeparateBubble() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let source = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let messageSurface = source.components(separatedBy: "private var messageSurface")[1]
            .components(separatedBy: "private var imageCollection")[0]
        let bubbleContents = source.components(separatedBy: "private var bubbleContents")[1]
            .components(separatedBy: "private var usesBorderlessImageSurface")[0]

        XCTAssertTrue(messageSurface.contains("} else if usesDetachedImageGroup {"))
        XCTAssertTrue(messageSurface.contains("captionSurface"))
        XCTAssertTrue(messageSurface.contains("message-image-"))
        XCTAssertTrue(messageSurface.contains("message-caption-"))
        XCTAssertTrue(bubbleContents.contains("!usesDetachedImageGroup"))
    }

    func testOnlyTerminalContentMessagesAllowReactions() {
        let message = ChatMessage(
            id: "message",
            conversationId: "conversation",
            author: .person,
            authorName: "Peer",
            text: "Hello",
            createdAt: .now,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            reactionTargetMessageId: "018f47c2-9f4c-7a5e-b001-000000000001"
        )
        XCTAssertTrue(MessageBubble.allowsReactions(for: message))
        var failed = message
        failed.deliveryState = .failed
        XCTAssertFalse(MessageBubble.allowsReactions(for: failed))

        var previewOnly = message
        previewOnly.reactionTargetMessageId = nil
        XCTAssertFalse(MessageBubble.allowsReactions(for: previewOnly))
        XCTAssertTrue(MessageBubble.allowsReactions(for: previewOnly, isPreviewMode: true))
    }

    func testReadPresentationRequiresVisibleForegroundLatestTranscript() {
        XCTAssertTrue(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: true,
                isAppForeground: true,
                isAtLatest: true
            ).canMarkRead
        )
        XCTAssertFalse(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: false,
                isAppForeground: true,
                isAtLatest: true
            ).canMarkRead
        )
        XCTAssertFalse(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: true,
                isAppForeground: false,
                isAtLatest: true
            ).canMarkRead
        )
        XCTAssertFalse(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: true,
                isAppForeground: true,
                isAtLatest: false
            ).canMarkRead
        )
    }

    @MainActor
    func testUnreadClearsOnlyWhenPreviewConversationBecomesReadable() throws {
        let model = AppModel(previewMode: true)
        let conversationID = "person:acct_maya"
        let presentationID = UUID()
        let initialUnread = try XCTUnwrap(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount
        )
        XCTAssertGreaterThan(initialUnread, 0)

        model.updateConversationReadPresentation(
            id: presentationID,
            conversationID: conversationID,
            isPresented: true,
            isAppForeground: false,
            isAtLatest: true
        )
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
            initialUnread
        )

        model.updateConversationReadPresentation(
            id: presentationID,
            conversationID: conversationID,
            isPresented: true,
            isAppForeground: true,
            isAtLatest: false
        )
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
            initialUnread
        )

        model.updateConversationReadPresentation(
            id: presentationID,
            conversationID: conversationID,
            isPresented: true,
            isAppForeground: true,
            isAtLatest: true
        )
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
            0
        )
    }

    func testTabUnreadCountsSumMessagesAndExcludeHiddenSessionsAndAgentTemplates() {
        let conversations = [
            conversation(id: "person", kind: .person, unread: 2),
            conversation(id: "group-main", kind: .group, unread: 3, groupSpaceId: "space"),
            conversation(id: "group-followup", kind: .group, unread: 1, groupSpaceId: "space"),
            conversation(id: "agent-session", kind: .agent, unread: 4),
            conversation(id: "agent-template:unused", kind: .agent, unread: 9),
        ]

        XCTAssertEqual(
            MainTabUnreadCounts.build(
                conversations: conversations
            ),
            MainTabUnreadCounts(chats: 6, agents: 4)
        )
        XCTAssertEqual(MainTabUnreadCounts.build(conversations: conversations).total, 10)
        XCTAssertEqual(
            MainTabUnreadCounts.build(
                conversations: conversations,
                mutedSessionIds: ["session:group-main", "session:agent-session"]
            ),
            MainTabUnreadCounts(chats: 3, agents: 0)
        )
        XCTAssertEqual(ConversationAttentionBadge.countLabel(120), "99+")
    }

    func testOnlyCloudGroupOwnersAndAdminsCanRenameChannels() {
        func group(role: String) -> ConversationSummary {
            ConversationSummary(
                id: "group-\(role)",
                kind: .group,
                peerAccountId: "acct_peer",
                agentId: nil,
                ownerDisplayName: "Group",
                displayName: "channel",
                lastMessage: "",
                lastActivityAt: .distantPast,
                unreadCount: 0,
                avatarSource: nil,
                agentActivity: nil,
                sessionId: "session:group:\(role)",
                groupParticipants: [
                    CloudGroupParticipant(
                        accountId: "acct_me",
                        displayName: "Me",
                        avatarUrl: nil,
                        role: role
                    )
                ]
            )
        }

        XCTAssertTrue(group(role: "owner").canManageGroup(accountId: "acct_me"))
        XCTAssertTrue(group(role: "admin").canManageGroup(accountId: "acct_me"))
        XCTAssertFalse(group(role: "member").canManageGroup(accountId: "acct_me"))
    }

    @MainActor
    func testAppModelDeletesLegacyLocalSessionTitleOverrides() {
        let key = "kordi.session-title-overrides"
        UserDefaults.standard.set(["session:group:old": "Local title"], forKey: key)

        _ = AppModel(previewMode: true)

        XCTAssertNil(UserDefaults.standard.object(forKey: key))
    }

    @MainActor
    func testPresentedMentionsAdvanceOnlyThroughTheirSequenceAndPersist() async throws {
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "mention-read", kind: .group, peerAccountId: accountID,
            agentId: nil, ownerDisplayName: nil, displayName: "Mentions", lastMessage: "Later message",
            lastActivityAt: Date(), unreadCount: 3, avatarSource: nil, agentActivity: nil,
            sessionId: "session:group:mention-read", unreadMentionCount: 2)
        let mention = MessageMention(label: "Me", targetKind: "person", targetIdentityId: "human:\(accountID)")
        func message(_ id: String, sequence: Int64, author: MessageAuthor = .person, mentioned: Bool) -> ChatMessage {
            ChatMessage(id: id, conversationId: conversation.id, conversationSequence: sequence,
                author: author, authorName: "Sender", text: "Synthetic message", createdAt: Date(),
                deliveryState: .delivered, errorMessage: nil, requestMessageId: nil,
                mentions: mentioned ? [mention] : [])
        }
        let first = message("first", sequence: 5, mentioned: true)
        let second = message("second", sequence: 8, mentioned: true)
        _ = await model.restoreConversationIfNeeded(conversation)
        store.saveMessages([first, second,
            message("later", sequence: 9, mentioned: false),
            message("own", sequence: 10, author: .me, mentioned: false)],
            conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        model.hydrateCachedMessages(for: conversation)

        await model.markMentionPresented(first, in: conversation)
        var current = try XCTUnwrap(model.conversations.first { $0.id == conversation.id })
        XCTAssertEqual(current.lastReadSequence, 5)
        XCTAssertEqual(current.unreadCount, 2)
        XCTAssertEqual(model.pendingMentionMessages(for: current).map(\.id), [second.id])

        await model.markMentionPresented(second, in: conversation)
        await model.markMentionPresented(first, in: conversation)
        current = try XCTUnwrap(model.conversations.first { $0.id == conversation.id })
        XCTAssertEqual(current.lastReadSequence, 8, "An older visibility callback cannot regress the cursor")
        XCTAssertEqual(current.unreadCount, 1, "The later incoming message must remain unread")
        XCTAssertEqual(current.unreadMentionCount, 0)
        let cached = try XCTUnwrap(store.loadConversations(accountId: accountID).first { $0.id == conversation.id })
        XCTAssertEqual(cached.lastReadSequence, 8)
        XCTAssertEqual(cached.unreadCount, 1)
        XCTAssertEqual(cached.unreadMentionCount, 0)
    }

    @MainActor
    func testPresentedLegacyMentionClearsSummaryWithoutRegressingCursor() async throws {
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "legacy-mention-read", kind: .person, peerAccountId: "peer",
            agentId: nil, ownerDisplayName: nil, displayName: "Legacy chat", lastMessage: "Mention",
            lastActivityAt: Date(), unreadCount: 1, avatarSource: nil, agentActivity: nil,
            sessionId: "legacy-session", unreadMentionCount: 1, lastReadSequence: 7)
        let message = ChatMessage(id: "legacy", conversationId: conversation.id, author: .person,
            authorName: "Sender", text: "Legacy mention", createdAt: Date(), deliveryState: .delivered,
            errorMessage: nil, requestMessageId: nil, mentions: [
                MessageMention(label: "Me", targetKind: "person", targetIdentityId: "human:\(accountID)")
            ])
        _ = await model.restoreConversationIfNeeded(conversation)
        store.saveMessages([message], conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        model.hydrateCachedMessages(for: conversation)
        XCTAssertEqual(model.pendingMentionMessages(for: conversation).map(\.id), [message.id])

        await model.markMentionPresented(message, in: conversation)
        let current = try XCTUnwrap(model.conversations.first { $0.id == conversation.id })
        XCTAssertEqual(current.unreadCount, 0)
        XCTAssertEqual(current.unreadMentionCount, 0)
        XCTAssertEqual(current.lastReadSequence, 7)
        let cached = try XCTUnwrap(store.loadConversations(accountId: accountID).first { $0.id == conversation.id })
        XCTAssertEqual(cached.unreadCount, 0)
        XCTAssertEqual(cached.lastReadSequence, 7)
    }

    @MainActor
    func testPreviewChatListActionsUpdateVisibleState() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(
            model.conversations.first { $0.id == "person:acct_maya" }
        )

        let didPin = await model.setConversationPinned(conversation, pinned: true)
        XCTAssertTrue(didPin)
        XCTAssertTrue(model.pinnedSessionIds.contains(conversation.sessionId))
        let didMute = await model.setConversationMuted(conversation, muted: true)
        XCTAssertTrue(didMute)
        XCTAssertTrue(model.mutedSessionIds.contains(conversation.sessionId))

        let readConversation = try XCTUnwrap(
            model.conversations.first { $0.id == "person:acct_ethan" }
        )
        let didMarkUnread = await model.setConversationUnread(readConversation, unread: true)
        XCTAssertTrue(didMarkUnread)
        XCTAssertTrue(model.markedUnreadSessionIds.contains(readConversation.sessionId))
        XCTAssertEqual(
            model.conversations.first { $0.id == readConversation.id }?.unreadCount,
            1
        )
        await model.markConversationRead(readConversation)
        XCTAssertFalse(model.markedUnreadSessionIds.contains(readConversation.sessionId))
        XCTAssertEqual(
            model.conversations.first { $0.id == readConversation.id }?.unreadCount,
            0
        )

        let didArchive = await model.archiveConversation(conversation)
        XCTAssertTrue(didArchive)
        XCTAssertFalse(model.conversations.contains { $0.sessionId == conversation.sessionId })
        XCTAssertTrue(model.archivedConversations.contains { $0.sessionId == conversation.sessionId })

        let didRestore = await model.restoreConversation(conversation)
        XCTAssertTrue(didRestore)
        XCTAssertTrue(model.conversations.contains { $0.sessionId == conversation.sessionId })
        XCTAssertFalse(model.archivedConversations.contains { $0.sessionId == conversation.sessionId })

        let didDelete = await model.deleteConversation(conversation)
        XCTAssertTrue(didDelete)
        XCTAssertFalse(model.conversations.contains { $0.sessionId == conversation.sessionId })
        XCTAssertFalse(model.mutedSessionIds.contains(conversation.sessionId))
    }

    @MainActor
    func testDeletingAChatKeepsTheContactAndAllowsStartingChatAgain() async throws {
        let model = AppModel(previewMode: true)
        let contact = try XCTUnwrap(model.contacts.first { $0.accountId == "acct_maya" })
        let conversation = try XCTUnwrap(
            model.conversations.first { $0.kind == .person && $0.peerAccountId == contact.accountId }
        )

        let didDelete = await model.deleteConversation(conversation)
        XCTAssertTrue(didDelete)
        XCTAssertTrue(model.contacts.contains { $0.accountId == contact.accountId })
        XCTAssertFalse(model.conversations.contains { $0.sessionId == conversation.sessionId })

        let reopenedConversation = model.conversationForContact(contact)
        let reopened = try XCTUnwrap(reopenedConversation)
        XCTAssertEqual(reopened.peerAccountId, contact.accountId)

        let didRestore = await model.restoreConversationIfNeeded(reopened)
        XCTAssertTrue(didRestore)
        XCTAssertTrue(model.conversations.contains { $0.sessionId == reopened.sessionId })
    }

    @MainActor
    func testPreviewGroupActionsApplyToEverySessionAtomically() async throws {
        let model = AppModel(previewMode: true)
        let space = try XCTUnwrap(
            GroupSpaceCatalog.build(
                conversations: model.conversations,
                ownAccountId: model.account?.accountId ?? "",
                pinnedSessionIds: model.pinnedSessionIds
            ).first { $0.displayName == "Mobile builders" }
        )
        let sessionIds = Set(space.sessions.map(\.sessionId))
        XCTAssertEqual(space.preferenceId, "session:group:mobile")

        let didPin = await model.setGroupSpacePinned(space, pinned: true)
        XCTAssertTrue(didPin)
        XCTAssertTrue(model.pinnedGroupSpaceIds.contains(space.preferenceId))
        XCTAssertTrue(model.pinnedSessionIds.isDisjoint(with: sessionIds))

        let pinnedSession = try XCTUnwrap(space.sessions.first)
        let didPinSession = await model.setConversationPinned(pinnedSession, pinned: true)
        XCTAssertTrue(didPinSession)
        XCTAssertTrue(model.pinnedSessionIds.contains(pinnedSession.sessionId))
        XCTAssertTrue(model.pinnedGroupSpaceIds.contains(space.preferenceId))

        let didUnpinGroup = await model.setGroupSpacePinned(space, pinned: false)
        XCTAssertTrue(didUnpinGroup)
        XCTAssertFalse(model.pinnedGroupSpaceIds.contains(space.preferenceId))
        XCTAssertTrue(model.pinnedSessionIds.contains(pinnedSession.sessionId))
        let didRepinGroup = await model.setGroupSpacePinned(space, pinned: true)
        XCTAssertTrue(didRepinGroup)
        let didMute = await model.setGroupSpaceMuted(space, muted: true)
        XCTAssertTrue(didMute)
        XCTAssertTrue(sessionIds.isSubset(of: model.mutedSessionIds))

        await model.markGroupSpaceRead(space)
        XCTAssertTrue(
            model.conversations
                .filter { sessionIds.contains($0.sessionId) }
                .allSatisfy { !$0.hasUnreadAttention }
        )

        let didArchive = await model.archiveGroupSpace(space)
        XCTAssertTrue(didArchive)
        XCTAssertFalse(model.conversations.contains { sessionIds.contains($0.sessionId) })
        XCTAssertEqual(
            Set(model.archivedConversations.map(\.sessionId)).intersection(sessionIds),
            sessionIds
        )
        XCTAssertTrue(model.pinnedSessionIds.isDisjoint(with: sessionIds))
        XCTAssertFalse(model.pinnedGroupSpaceIds.contains(space.preferenceId))

        let archivedSpace = try XCTUnwrap(
            GroupSpaceCatalog.build(
                conversations: model.archivedConversations,
                ownAccountId: model.account?.accountId ?? ""
            ).first { $0.id == space.id }
        )
        XCTAssertEqual(Set(archivedSpace.sessions.map(\.sessionId)), sessionIds)

        let didRestore = await model.restoreGroupSpace(archivedSpace)
        XCTAssertTrue(didRestore)
        XCTAssertTrue(sessionIds.isSubset(of: Set(model.conversations.map(\.sessionId))))
        XCTAssertTrue(model.archivedConversations.allSatisfy { !sessionIds.contains($0.sessionId) })
    }

    @MainActor
    func testMessageNotificationPreferencesPersistPerDevice() throws {
        let suiteName = "KordiNotificationPreferencesTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let coordinator = KordiNotificationCoordinator(defaults: defaults)
        XCTAssertTrue(coordinator.messagesEnabled)
        XCTAssertTrue(coordinator.previewsEnabled)

        coordinator.setPreference(.messages, enabled: false)
        coordinator.setPreference(.previews, enabled: false)

        let restored = KordiNotificationCoordinator(defaults: defaults)
        XCTAssertFalse(restored.messagesEnabled)
        XCTAssertFalse(restored.previewsEnabled)
        XCTAssertTrue(restored.soundEnabled)
        XCTAssertTrue(restored.badgeEnabled)
    }

    func testNotificationAuthorizationRequestsAutomaticallyOnlyAfterLogin() {
        XCTAssertTrue(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: true,
            state: .notDetermined
        ))
        XCTAssertFalse(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: false,
            state: .notDetermined
        ))
        XCTAssertFalse(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: true,
            state: .authorized
        ))
        XCTAssertFalse(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: true,
            state: .denied
        ))
    }

    func testCalendarAuthorizationRequestsAutomaticallyOnlyAfterLogin() {
        XCTAssertTrue(shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: true,
            status: .notDetermined
        ))
        XCTAssertFalse(shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: false,
            status: .notDetermined
        ))
        XCTAssertFalse(shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: true,
            status: .fullAccess
        ))
        XCTAssertFalse(shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: true,
            status: .writeOnly
        ))
        XCTAssertFalse(shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: true,
            status: .denied
        ))
        XCTAssertFalse(shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: true,
            status: .restricted
        ))
    }

    private func conversation(
        id: String,
        kind: ConversationKind,
        unread: Int,
        groupSpaceId: String? = nil,
        forkedFromSessionId: String? = nil
    ) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: kind,
            peerAccountId: "acct_peer",
            agentId: kind == .agent ? "agent" : nil,
            ownerDisplayName: "Conversation",
            displayName: "Conversation",
            lastMessage: "Latest message",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: unread,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:\(id)",
            groupSpaceId: groupSpaceId,
            messageCount: 1,
            forkedFromSessionId: forkedFromSessionId
        )
    }
}
