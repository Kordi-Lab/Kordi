import SwiftUI
import XCTest
@testable import Kordi

final class PhotoLibraryPickerTests: XCTestCase {
    private let ids = ["a", "b", "c", "d", "e", "f"]

    private func select(_ drag: PhotoLibraryDragSelection, through index: Int) -> [String] {
        drag.selection(through: index, count: ids.count) { self.ids.indices.contains($0) ? self.ids[$0] : nil }
    }

    func testDragFromUnselectedPhotoSelectsTheRunInDragOrder() {
        let drag = PhotoLibraryDragSelection(anchorIndex: 1, anchorID: "b", baseline: ["e"])

        XCTAssertTrue(drag.selects)
        XCTAssertEqual(select(drag, through: 1), ["e", "b"])
        XCTAssertEqual(select(drag, through: 3), ["e", "b", "c", "d"])
        // Dragging back past the anchor reverses the run and restores the rest.
        XCTAssertEqual(select(drag, through: 0), ["e", "b", "a"])
    }

    func testDragFromSelectedPhotoDeselectsTheRunAndRestoresLeftPhotos() {
        let drag = PhotoLibraryDragSelection(anchorIndex: 2, anchorID: "c", baseline: ["a", "c", "d", "e"])

        XCTAssertFalse(drag.selects)
        XCTAssertEqual(select(drag, through: 4), ["a"])
        XCTAssertEqual(select(drag, through: 3), ["a", "e"])
        XCTAssertEqual(select(drag, through: 2), ["a", "d", "e"])
    }

    func testDragClampsToTheLibrary() {
        let drag = PhotoLibraryDragSelection(anchorIndex: 4, anchorID: "e", baseline: [])

        XCTAssertEqual(select(drag, through: 99), ["e", "f"])
        XCTAssertEqual(select(drag, through: -3), ["e", "d", "c", "b", "a"])
    }

    func testVideoDurationsReadLikePhotos() {
        XCTAssertEqual(PhotoLibraryGridMetrics.durationText(7.4), "0:07")
        XCTAssertEqual(PhotoLibraryGridMetrics.durationText(59.6), "1:00")
        XCTAssertEqual(PhotoLibraryGridMetrics.durationText(754), "12:34")
        XCTAssertEqual(PhotoLibraryGridMetrics.durationText(3723), "1:02:03")
        XCTAssertEqual(PhotoLibraryGridMetrics.durationText(-1), "0:00")
    }

    func testGridIndexResolvesGapsToANeighbourAndClampsToTheLastPhoto() {
        let width: CGFloat = 402
        let side = PhotoLibraryGridMetrics.itemSide(width: width, scale: 3)
        XCTAssertEqual(side, 99, accuracy: 0.34)

        let index = { (x: CGFloat, y: CGFloat) in
            PhotoLibraryGridMetrics.index(at: CGPoint(x: x, y: y), itemSide: side, width: width, count: 10)
        }
        XCTAssertEqual(index(10, 10), 0)
        XCTAssertEqual(index(width - 1, 10), 3)
        XCTAssertEqual(index(side + 1.5, 10), 1)
        XCTAssertEqual(index(10, side + 0.5), 0)
        XCTAssertEqual(index(10, side + 2.5), 4)
        XCTAssertEqual(index(width - 1, 1_000), 9)
        XCTAssertNil(PhotoLibraryGridMetrics.index(at: .zero, itemSide: side, width: width, count: 0))
    }
}
