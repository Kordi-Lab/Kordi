import XCTest
import UIKit
@testable import Kordi

final class ChatRowSwipeGestureTests: XCTestCase {
    func testHorizontalIntentAcceptsBothDirectionsAndRejectsVerticalOrAmbiguousMotion() {
        for direction in [-1.0, 1.0] {
            XCTAssertTrue(ChatRowSwipeDirection.isHorizontal(CGPoint(x: direction * 80, y: 10)))
            XCTAssertFalse(ChatRowSwipeDirection.isHorizontal(CGPoint(x: 10, y: direction * 80)))
            XCTAssertFalse(ChatRowSwipeDirection.isHorizontal(CGPoint(x: direction * 30, y: 30)))
        }
        XCTAssertFalse(ChatRowSwipeDirection.isHorizontal(.zero))
    }

    @MainActor
    func testNativeRecognizerRejectsVerticalInputBeforeClaimingTouches() {
        let coordinator = ChatRowPanCoordinator()
        let pan = SamplePan()
        pan.sample = CGPoint(x: 2, y: 300)
        XCTAssertFalse(coordinator.gestureRecognizerShouldBegin(pan))
        pan.sample = CGPoint(x: -300, y: 2)
        XCTAssertTrue(coordinator.gestureRecognizerShouldBegin(pan))
        pan.sample = CGPoint(x: 300, y: 2)
        XCTAssertTrue(coordinator.gestureRecognizerShouldBegin(pan))
    }

    @MainActor
    func testListWaitsForDirectionDecisionAndIndirectScrollInputIsSupported() {
        let coordinator = ChatRowPanCoordinator()
        let pan = coordinator.makeRecognizer()
        let list = UIScrollView()
        XCTAssertTrue(coordinator.gestureRecognizer(pan, shouldBeRequiredToFailBy: list.panGestureRecognizer))
        XCTAssertFalse(coordinator.gestureRecognizer(pan, shouldBeRequiredToFailBy: UITapGestureRecognizer()))
        XCTAssertTrue(pan.allowedScrollTypesMask.contains(.continuous))
        XCTAssertTrue(pan.allowedScrollTypesMask.contains(.discrete))
    }

    func testClosingEitherOpenSideStopsAtNeutralEvenWithProjectedOvershoot() throws {
        for side: CGFloat in [-1, 1] {
            let drag = try XCTUnwrap(ChatRowSwipeSession(restingOffset: side * 120, firstTranslation: -side * 20))
            XCTAssertEqual(drag.limitedOffset(side * 60, leadingWidth: 160, trailingWidth: 160), side * 60)
            for oppositeOffset: CGFloat in [20, 500] {
                XCTAssertEqual(drag.limitedOffset(-side * oppositeOffset, leadingWidth: 160, trailingWidth: 160), 0)
            }
        }
    }

    func testOppositeActionsNeedANewGestureAfterClosing() throws {
        let closing = try XCTUnwrap(ChatRowSwipeSession(restingOffset: -120, firstTranslation: 180))
        XCTAssertEqual(closing.limitedOffset(60, leadingWidth: 160, trailingWidth: 160), 0)
        let nextDrag = try XCTUnwrap(ChatRowSwipeSession(restingOffset: 0, firstTranslation: 60))
        XCTAssertEqual(nextDrag.limitedOffset(60, leadingWidth: 160, trailingWidth: 160), 60)
    }

    func testInitiallyClosedRowWaitsForMovementAndKeepsTheFirstDirection() throws {
        XCTAssertNil(ChatRowSwipeSession(restingOffset: 0, firstTranslation: 0))
        for side: CGFloat in [-1, 1] {
            let drag = try XCTUnwrap(ChatRowSwipeSession(restingOffset: 0, firstTranslation: side * 12))
            XCTAssertEqual(drag.limitedOffset(-side * 80, leadingWidth: 160, trailingWidth: 160), 0)
            XCTAssertEqual(drag.limitedOffset(side * 300, leadingWidth: 160, trailingWidth: 160), side * 160)
        }
    }

    func testGradualRevealStillFullyExposesEveryActionAtRest() {
        let diameter: CGFloat = 44
        let padding: CGFloat = 16
        for count in 1...4 {
            let restingWidth = padding * 2 + CGFloat(count) * diameter + CGFloat(count - 1) * 8
            for index in 0..<count {
                let fullDistance = padding + diameter + CGFloat(index) * (diameter + 8)
                let end = fullDistance + padding
                let progress: (CGFloat) -> CGFloat = { offset in
                    ChatRowSwipeMotion.actionProgress(
                        offset: offset, fullRevealDistance: fullDistance,
                        edgePadding: padding, diameter: diameter
                    )
                }
                XCTAssertEqual(progress(0), 0)
                XCTAssertEqual(progress(end - diameter), 0)
                XCTAssertEqual(progress(end - diameter / 2), 0.5, accuracy: 0.001)
                XCTAssertEqual(progress(restingWidth), 1)
                XCTAssertLessThan(progress(end - diameter * 0.8), 0.2)
            }
        }
    }

    @MainActor
    private final class SamplePan: UIPanGestureRecognizer {
        var sample: CGPoint = .zero
        override func velocity(in view: UIView?) -> CGPoint { sample }
    }
}
