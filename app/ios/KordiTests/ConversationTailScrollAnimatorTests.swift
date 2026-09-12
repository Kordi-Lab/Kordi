import XCTest
import UIKit
@testable import Kordi

@MainActor
final class ConversationTailScrollAnimatorTests: XCTestCase {
    private func scrollView(contentHeight: CGFloat = 1000) -> UIScrollView {
        let view = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
        view.contentInsetAdjustmentBehavior = .never
        view.contentSize = CGSize(width: 320, height: contentHeight)
        view.contentOffset.y = max(0, contentHeight - 600)
        return view
    }

    private func mount(_ scroll: UIScrollView) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 600)
        let controller = UIViewController()
        controller.view.addSubview(scroll)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        CATransaction.flush()
        return window
    }

    private func settle() async {
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(20))
    }

    private func waitForAnimation(_ animator: ConversationTailScrollAnimator) async {
        for _ in 0..<150 {
            try? await Task.sleep(for: .milliseconds(10))
            if !animator.isAnimating && !animator.hasPendingRequest { return }
        }
        XCTFail("Native scrolling did not finish within the bounded settling interval")
    }

    func testMessageBottomVisibilityRejectsContentClippedByTheComposer() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        defer { window.isHidden = true; window.rootViewController = nil }
        let row = UIView(frame: CGRect(x: 0, y: 850, width: 320, height: 200))
        scroll.addSubview(row)
        let position = ConversationScrollPosition()
        position.attach(to: scroll)
        position.register(row, messageID: "synthetic-tail")
        XCTAssertFalse(position.isMessageBottomVisible("synthetic-tail"),
            "Seeing most of a reply is not the same as seeing its end")
        row.frame.origin.y = 700
        XCTAssertTrue(position.isMessageBottomVisible("synthetic-tail"))
        position.viewportFrameInWindow = CGRect(x: 0, y: 0, width: 320, height: 480)
        XCTAssertFalse(position.isMessageBottomVisible("synthetic-tail"),
            "The actual conversation viewport must exclude the composer")
    }

    func testLatestArrowDependsOnTheVisibleMessageBottom() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldShowLatestButton(
            isAtBottom: false, messageCount: 20, latestMessageBottomVisible: true))
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldShowLatestButton(
            isAtBottom: false, messageCount: 20, latestMessageBottomVisible: false))
    }

    func testContentGrowthFollowsThePreviouslyVisibleBottomOncePerLayout() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        let follower = ConversationContentResizeFollower()
        defer { follower.disconnect(); window.isHidden = true; window.rootViewController = nil }
        var follows = 0
        follower.isEnabled = true
        follower.connect(to: scroll) {
            follows += 1
            scroll.contentOffset.y = ConversationTailScrollAnimator.targetOffset(in: scroll)
        }
        scroll.contentSize.height = 1200
        scroll.contentSize.height = 1500
        await settle()
        XCTAssertEqual(follows, 1, "Several measurements must coalesce into one correction")
        XCTAssertEqual(scroll.contentOffset.y, 900, accuracy: 1)
        scroll.contentSize.height = 1200
        await settle()
        XCTAssertEqual(follows, 2, "Height corrections in either direction must keep the bottom aligned")
        XCTAssertEqual(scroll.contentOffset.y, 600, accuracy: 1)
    }

    func testShortBottomAlignedContentDoesNotReceiveAnExtraCorrection() async throws {
        let scroll = scrollView()
        let content = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 200))
        scroll.addSubview(content)
        let window = try mount(scroll)
        let follower = ConversationContentResizeFollower()
        defer { follower.disconnect(); window.isHidden = true; window.rootViewController = nil }
        var follows = 0
        follower.isEnabled = true
        follower.connect(to: scroll, contentView: content) { follows += 1 }
        scroll.contentSize.height = 1200
        await settle()
        XCTAssertEqual(follows, 0, "An undersized stack already handles its bottom-aligned origin")
        scroll.contentOffset.y = ConversationTailScrollAnimator.targetOffset(in: scroll)
        scroll.contentSize.height = 1500
        content.frame.size.height = 800
        await settle()
        XCTAssertEqual(follows, 1, "Check final layout when a formerly short reply fills the viewport")
    }

    func testContentGrowthDoesNotFollowWhileReadingOlderMessages() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        scroll.contentOffset.y = 100
        let follower = ConversationContentResizeFollower()
        defer { follower.disconnect(); window.isHidden = true; window.rootViewController = nil }
        var follows = 0
        follower.isEnabled = true
        follower.connect(to: scroll) { follows += 1 }
        scroll.contentSize.height = 1500
        await settle()
        XCTAssertEqual(follows, 0)
        XCTAssertEqual(scroll.contentOffset.y, 100, accuracy: 1)
    }

    func testHistoryNavigationCancelsAQueuedContentCorrection() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        let follower = ConversationContentResizeFollower()
        defer { follower.disconnect(); window.isHidden = true; window.rootViewController = nil }
        follower.isEnabled = true
        follower.connect(to: scroll) {
            scroll.contentOffset.y = ConversationTailScrollAnimator.targetOffset(in: scroll)
        }
        scroll.contentSize.height = 1500
        // A quote/mention jump changes the offset without a pan gesture.
        scroll.contentOffset.y = 100
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, 100, accuracy: 1,
            "A queued tail correction must not override a later history-navigation intent")
    }

    func testSuspendingContentFollowingCancelsPendingCorrection() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        let follower = ConversationContentResizeFollower()
        defer { follower.disconnect(); window.isHidden = true; window.rootViewController = nil }
        var follows = 0
        follower.isEnabled = true
        follower.connect(to: scroll) { follows += 1 }
        scroll.contentSize.height = 1500
        follower.isEnabled = false
        await settle()
        XCTAssertEqual(follows, 0)
        follower.isEnabled = true
        scroll.contentOffset.y = 900
        scroll.contentSize.height = 1800
        follower.disconnect()
        await settle()
        XCTAssertEqual(follows, 0, "A departing conversation must not complete old work")
    }

    func testStableIntermediateGeometryCannotRevealDuringKeyboardTransition() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        defer {
            animator.disconnect()
            window.isHidden = true
            window.rootViewController = nil
        }
        await settle()
        var revealed = false
        // Keep the transition active while several identical frames are sampled.
        animator.keyboardWillAnimate(until: CACurrentMediaTime() + 30)
        animator.request(in: scroll, animated: false, reduceMotion: false) { revealed = true }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(revealed, "Stable bounds alone do not mean the keyboard has finished moving")
        animator.keyboardWillAnimate(until: CACurrentMediaTime())
        for _ in 0..<50 {
            if revealed { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(revealed, "The row should reveal once the transition and geometry have settled")
    }

    func testSendMovesTheNativeOffsetToTheMeasuredTail() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        defer { window.isHidden = true; window.rootViewController = nil }
        await settle()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.contentSize.height = 1070
        animator.request(in: scroll, animated: false, reduceMotion: false)
        await settle()
        XCTAssertTrue(animator.isAnimating)
        XCTAssertLessThan(scroll.contentOffset.y, 470)
        await waitForAnimation(animator)
        XCTAssertEqual(scroll.contentOffset.y, 470, accuracy: 1)
        animator.disconnect()
    }

    func testReceiptDoesNotReplaceAnInFlightAnimation() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        defer { window.isHidden = true; window.rootViewController = nil }
        await settle()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.contentSize.height += 70
        await settle()
        let before = animator.visibleOffset(in: scroll)
        animator.request(in: scroll, animated: false, reduceMotion: false)
        await settle()
        XCTAssertGreaterThanOrEqual(animator.visibleOffset(in: scroll), before - 1)
        XCTAssertTrue(animator.isAnimating)
        await waitForAnimation(animator)
        XCTAssertEqual(scroll.contentOffset.y, 470, accuracy: 1)
        animator.disconnect()
    }

    func testShortHistoryUsesItsActualOriginMovement() async throws {
        let scroll = scrollView(contentHeight: 600)
        let content = UIView(frame: CGRect(x: 0, y: 450, width: 320, height: 150))
        scroll.addSubview(content)
        let window = try mount(scroll)
        defer { window.isHidden = true; window.rootViewController = nil }
        await settle()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, contentView: content, animated: true, reduceMotion: false)
        content.frame = CGRect(x: 0, y: 380, width: 320, height: 220)
        await settle()
        XCTAssertLessThan(scroll.contentOffset.y, 0)
        XCTAssertGreaterThanOrEqual(scroll.contentOffset.y, -70)
        await waitForAnimation(animator)
        XCTAssertEqual(scroll.contentOffset.y, 0, accuracy: 1)
        animator.disconnect()
    }

    func testReduceMotionAndCancellationDoNotLeaveADeferredJump() async {
        let scroll = scrollView()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, animated: true, reduceMotion: true)
        scroll.contentSize.height += 70
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, 470)
        XCTAssertFalse(animator.isAnimating)
        animator.request(in: scroll, animated: true, reduceMotion: false)
        animator.cancel()
        scroll.contentSize.height += 70
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, 470)
        XCTAssertFalse(animator.isAnimating)
        animator.disconnect()
    }

    func testInsetsAndComposerResizeUseFinalGeometry() async {
        let scroll = scrollView()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.bounds.size.height = 700
        scroll.contentInset.bottom = 20
        scroll.contentSize.height = 1100
        await settle()
        await waitForAnimation(animator)
        XCTAssertEqual(scroll.contentOffset.y, 420, accuracy: 1)
        animator.disconnect()
    }

    func testLeavingTheConversationRemovesItsJumpCover() async throws {
        let scroll = scrollView(contentHeight: 2_000)
        scroll.contentOffset.y = 100
        let content = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 2_000))
        scroll.addSubview(content)
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        let position = ConversationScrollPosition()
        position.attachNavigationAnimator(animator)
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        await settle()
        animator.request(in: scroll, contentView: content, animated: true, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(animator.isTransitionCoveringContent)
        position.cancelScrolling()
        XCTAssertFalse(animator.isAnimating)
        XCTAssertFalse(animator.isTransitionCoveringContent)
        XCTAssertFalse(window.subviews.contains { $0.accessibilityIdentifier == "conversation-jump-cover" })
    }

    func testVirtualizedJumpRevealsOnlyAfterMeasuredDestinationSettles() async throws {
        let scroll = scrollView(contentHeight: 2_000)
        scroll.contentOffset.y = 100
        let content = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 2_000))
        scroll.addSubview(content)
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        var coverage: [Bool] = []
        animator.onTransitionVisibilityChange = { [weak animator] in
            coverage.append(animator?.isTransitionCoveringContent == true)
        }
        await settle()
        animator.request(in: scroll, contentView: content, animated: true, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(animator.isTransitionCoveringContent)
        await waitForAnimation(animator)
        XCTAssertEqual(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 1)
        XCTAssertFalse(animator.isTransitionCoveringContent)
        XCTAssertEqual(coverage, [true, false])
        scroll.contentOffset.y = 100
        animator.request(in: scroll, contentView: content, animated: true, reduceMotion: true)
        await settle()
        XCTAssertFalse(animator.isTransitionCoveringContent)
        XCTAssertFalse(animator.isAnimating)
        XCTAssertEqual(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 1)
    }

    func testCancellingFreezesNativeScrollingAtTheCurrentPosition() async throws {
        let scroll = scrollView(contentHeight: 2_000)
        scroll.contentOffset.y = 100
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        await settle()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(60))
        let current = scroll.contentOffset.y
        XCTAssertLessThan(current, ConversationTailScrollAnimator.targetOffset(in: scroll))
        animator.cancel()
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertFalse(animator.isAnimating)
        XCTAssertEqual(scroll.contentOffset.y, current, accuracy: 1)
    }

    func testAnimatedJumpDoesNotReportLatestBeforeItArrives() async throws {
        let scroll = scrollView(contentHeight: 2_000)
        scroll.contentOffset.y = 100
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        await settle()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertGreaterThan(scroll.contentOffset.y, 100)
        XCTAssertLessThan(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll) - 1,
            "Read and latest-button state must follow the visible scroll, not jump to the endpoint before the animation")
    }

    func testRetargetUsesThePositionReachedWhileLayoutWasBusy() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        await settle()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.contentSize.height += 4_000
        try await Task.sleep(for: .milliseconds(40))
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.contentSize.height += 70
        // The compositor continues the old animation while main-thread layout
        // delays the queued retarget. It must not restart from the earlier sample.
        simulateBusyLayout()
        let reached = animator.visibleOffset(in: scroll)
        await settle()
        XCTAssertGreaterThanOrEqual(animator.visibleOffset(in: scroll), reached - 1,
            "Retargeting must continue from the reached position")
        await waitForAnimation(animator)
        XCTAssertEqual(scroll.contentOffset.y, 4_470, accuracy: 1)
    }

    func testLateResizeCannotReverseVisibleDestinationDuringFade() async throws {
        try await checkLateResize(delta: -80)
    }

    func testLateGrowthFollowsTheNewTailAfterFading() async throws {
        try await checkLateResize(delta: 80)
    }

    func testCancellingRetargetedRevealRemovesItsCover() async throws {
        try await checkLateResize(delta: -80, cancels: true)
    }

    private func checkLateResize(delta: CGFloat, cancels: Bool = false) async throws {
        let scroll = scrollView(contentHeight: 2_000)
        scroll.contentOffset.y = 100
        scroll.contentInset.bottom = 17
        let content = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 2_000))
        let marker = UIView(frame: CGRect(x: 0, y: 1_700, width: 320, height: 40))
        marker.backgroundColor = .systemBlue
        content.addSubview(marker); scroll.addSubview(content)
        let window = try mount(scroll)
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        await settle()
        animator.request(in: scroll, contentView: content, animated: true, reduceMotion: false)
        var fadingCover: UIView?
        for _ in 0..<150 {
            try await Task.sleep(for: .milliseconds(5))
            if let cover = window.subviews.first(where: { $0.accessibilityIdentifier == "conversation-jump-cover" }),
               let opacity = cover.layer.presentation()?.opacity, opacity > 0.2, opacity < 0.8 {
                fadingCover = cover; break
            }
        }
        let cover = try XCTUnwrap(fadingCover)
        let visibleMarkerY = marker.convert(marker.bounds, to: window).minY
        // Resize after destination pixels are visible. Both UIKit's own clamp
        // and a follow request must remain behind a fresh, opaque snapshot.
        content.frame.size.height += delta
        scroll.contentSize.height += delta
        animator.request(in: scroll, contentView: content, animated: false, reduceMotion: false)
        let replacement = try XCTUnwrap(window.subviews.first {
            $0.accessibilityIdentifier == "conversation-jump-cover"
        })
        XCTAssertFalse(replacement === cover)
        XCTAssertNil(cover.superview)
        XCTAssertEqual(replacement.alpha, 1)
        XCTAssertEqual(scroll.contentInset.bottom, 17)
        if cancels {
            animator.cancel()
            XCTAssertFalse(animator.isAnimating)
            XCTAssertFalse(animator.isTransitionCoveringContent)
            XCTAssertNil(replacement.superview)
            let stoppedOffset = scroll.contentOffset.y
            try await Task.sleep(for: .milliseconds(350))
            XCTAssertEqual(scroll.contentOffset.y, stoppedOffset, accuracy: 1)
            return
        }
        var previousVisibleY: CGFloat? = visibleMarkerY
        var comparedFrames = 0
        var sawCrossfade = false
        for _ in 0..<150 {
            try await Task.sleep(for: .milliseconds(5))
            let opacity = replacement.layer.presentation()?.opacity ?? Float(replacement.alpha)
            if replacement.superview != nil, opacity >= 0.99 {
                previousVisibleY = nil
                continue
            }
            sawCrossfade = sawCrossfade || (opacity > 0.01 && opacity < 0.99)
            let y = marker.convert(marker.bounds, to: window).minY
            if let previousVisibleY {
                comparedFrames += 1
                XCTAssertEqual(y, previousVisibleY, accuracy: 1,
                    "The destination must remain stationary whenever it is visible through the cover")
            }
            previousVisibleY = y
            if !animator.isAnimating, !animator.hasPendingRequest { break }
        }
        XCTAssertTrue(sawCrossfade)
        XCTAssertGreaterThan(comparedFrames, 2)
        XCTAssertEqual(scroll.contentOffset.y, ConversationTailScrollAnimator.targetOffset(in: scroll), accuracy: 1)
        XCTAssertFalse(animator.isAnimating)
        XCTAssertFalse(animator.isTransitionCoveringContent)
        XCTAssertEqual(scroll.contentInset.bottom, 17, "Retargeting must preserve the original inset")
    }

    private func simulateBusyLayout() { Thread.sleep(forTimeInterval: 0.08) }

    func testRapidSendsMoveContinuouslyOnTheCompositedScrollLayer() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 600)
        let controller = UIViewController()
        let scroll = scrollView()
        controller.view.addSubview(scroll)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect(); window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(40))
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.contentSize.height += 70
        var offsets: [CGFloat] = []
        for frame in 0..<120 {
            if frame == 5 {
                animator.request(in: scroll, animated: true, reduceMotion: false)
                scroll.contentSize.height += 70
            }
            if frame == 8 { animator.request(in: scroll, animated: false, reduceMotion: false) }
            try await Task.sleep(for: .milliseconds(10))
            offsets.append(animator.visibleOffset(in: scroll))
            if frame > 8, !animator.isAnimating, !animator.hasPendingRequest { break }
        }
        XCTAssertTrue(offsets.contains { $0 > 400.5 && $0 < 539.5 }, "The transition must present intermediate frames")
        for (before, after) in zip(offsets, offsets.dropFirst()) {
            XCTAssertGreaterThanOrEqual(after - before, -1, "Sending must not reverse its displayed scroll direction")
        }
        XCTAssertEqual(scroll.contentOffset.y, 540, accuracy: 1)
        XCTAssertEqual(offsets.last ?? 0, 540, accuracy: 1)
    }

    func testEmptyComposerUsesFinalHeightBeforeItsMeasurementCallback() {
        XCTAssertEqual(ComposerTextViewLayout.resolvedHeight(isEmpty: true, measuredHeight: 160, lineHeight: 20, insets: 22), 44)
        XCTAssertEqual(ComposerTextViewLayout.resolvedHeight(isEmpty: false, measuredHeight: 160, lineHeight: 20, insets: 22), 160)
        XCTAssertEqual(ComposerTextViewLayout.resolvedHeight(isEmpty: true, measuredHeight: 160, lineHeight: 40, insets: 22), 62)
    }

    func testInsertedMessageIsRevealedOnlyAfterMeasuredTailSettles() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        defer { window.isHidden = true; window.rootViewController = nil }
        let animator = ConversationTailScrollAnimator()
        defer { animator.disconnect() }
        var revealed = false
        animator.request(in: scroll, animated: false, reduceMotion: false, onPositioned: { revealed = true })
        scroll.contentSize.height = 1070
        XCTAssertFalse(revealed)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(revealed)
        XCTAssertEqual(scroll.contentOffset.y, 470, accuracy: 0.5)
        XCTAssertFalse(animator.isAnimating)
    }

}
