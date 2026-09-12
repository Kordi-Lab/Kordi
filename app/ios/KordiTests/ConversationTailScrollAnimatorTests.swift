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
