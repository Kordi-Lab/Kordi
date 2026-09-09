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

    @MainActor
    private final class SamplePan: UIPanGestureRecognizer {
        var sample: CGPoint = .zero
        override func velocity(in view: UIView?) -> CGPoint { sample }
    }
}
