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

    func testSendCommitsMeasuredTailAndUsesOnePresentationAnimation() async throws {
        let scroll = scrollView()
        let window = try mount(scroll)
        defer { window.isHidden = true; window.rootViewController = nil }
        await settle()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, animated: true, reduceMotion: false)
        scroll.contentSize.height = 1070
        animator.request(in: scroll, animated: false, reduceMotion: false)
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, 470)
        let animation = scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey) as? CABasicAnimation
        XCTAssertEqual(animation?.fromValue as? CGFloat, 400)
        XCTAssertEqual(animation?.toValue as? CGFloat, 470)
        XCTAssertEqual(scroll.layer.animationKeys(), [ConversationTailScrollAnimator.animationKey])
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
        let before = scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey) as? CABasicAnimation
        animator.request(in: scroll, animated: false, reduceMotion: false)
        await settle()
        let after = scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey) as? CABasicAnimation
        XCTAssertEqual(before?.fromValue as? CGFloat, after?.fromValue as? CGFloat)
        XCTAssertEqual(before?.toValue as? CGFloat, after?.toValue as? CGFloat)
        XCTAssertEqual(before?.beginTime, after?.beginTime)
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
        XCTAssertEqual(scroll.contentOffset.y, 0)
        let animation = scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey) as? CABasicAnimation
        XCTAssertEqual(animation?.fromValue as? CGFloat, -70)
        XCTAssertEqual(animation?.toValue as? CGFloat, 0)
        animator.disconnect()
    }

    func testReduceMotionAndCancellationDoNotLeaveADeferredJump() async {
        let scroll = scrollView()
        let animator = ConversationTailScrollAnimator()
        animator.request(in: scroll, animated: true, reduceMotion: true)
        scroll.contentSize.height += 70
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, 470)
        XCTAssertNil(scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey))
        animator.request(in: scroll, animated: true, reduceMotion: false)
        animator.cancel()
        scroll.contentSize.height += 70
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, 470)
        XCTAssertNil(scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey))
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
        XCTAssertEqual(scroll.contentOffset.y, 420)
        animator.disconnect()
    }

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
        for frame in 0..<35 {
            if frame == 5 {
                animator.request(in: scroll, animated: true, reduceMotion: false)
                scroll.contentSize.height += 70
            }
            if frame == 8 { animator.request(in: scroll, animated: false, reduceMotion: false) }
            try await Task.sleep(for: .milliseconds(10))
            offsets.append(animator.visibleOffset(in: scroll))
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
        XCTAssertNil(scroll.layer.animation(forKey: ConversationTailScrollAnimator.animationKey))
    }

}
