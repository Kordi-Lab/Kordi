import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
private final class TimelineMountLedger {
    var active: Set<Int> = []
    var maximumActive = 0
    var heights: [Int: CGFloat] = [:]
    var scroll: ((Int) -> Void)?
    var retain: ((Int?) -> Void)?

    func mount(_ id: Int) {
        active.insert(id)
        maximumActive = max(maximumActive, active.count)
    }
}

private struct VirtualizedTimelineHarness: View {
    let ledger: TimelineMountLedger
    @State private var retainedID: Int?

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    ConversationTimelineStack(usesCompatibilityLayout: true) {
                        ForEach(0..<200, id: \.self) { id in
                            ConversationTimelineRowSlot(
                                viewportFrame: viewport.frame(in: .global),
                                isRetained: retainedID == id,
                                usesCompatibilityLayout: true
                            ) {
                                Text("History row \(id)")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: id == 5 ? 1600 : 100.25)
                                    .onAppear { ledger.mount(id) }
                                    .onDisappear { ledger.active.remove(id) }
                            }
                            .id(id)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                                ledger.heights[id] = height
                            }
                        }
                    }
                    .scrollTargetLayout()
                }
                .onAppear {
                    ledger.scroll = { id in proxy.scrollTo(id, anchor: .top) }
                    ledger.retain = { retainedID = $0 }
                }
            }
        }
    }
}

@MainActor
final class ConversationTimelineVirtualizationTests: XCTestCase {
    func testLongHistoryEvictsContentButPreservesMeasuredSlotsAndRetainedActions() async throws {
        let ledger = TimelineMountLedger()
        let controller = UIHostingController(rootView: VirtualizedTimelineHarness(ledger: ledger))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
        }
        func settle() async throws {
            try await Task.sleep(for: .milliseconds(500))
            controller.view.layoutIfNeeded()
        }
        try await settle()
        XCTAssertTrue(ledger.active.contains(5), "The tall row near the initial viewport must materialize")
        XCTAssertEqual(ledger.heights[5] ?? 0, 1600, accuracy: 1)
        XCTAssertLessThan(ledger.maximumActive, 50, "Loading history must not construct all 200 message bodies")

        ledger.retain?(5)
        ledger.scroll?(150)
        try await settle()
        XCTAssertTrue(ledger.active.contains(150), "Scroll IDs must remain reachable before a row materializes")
        XCTAssertTrue(ledger.active.contains(5), "An active action must retain its source outside the viewport")
        XCTAssertFalse(ledger.active.contains(0), "Distant content must be evicted")

        ledger.retain?(nil)
        try await settle()
        XCTAssertFalse(ledger.active.contains(5), "Completing the action must release the offscreen source")
        XCTAssertEqual(ledger.heights[5] ?? 0, 1600, accuracy: 1,
                       "Eviction must not replace a measured tall row with the initial height estimate")
        ledger.scroll?(0)
        try await settle()
        XCTAssertTrue(ledger.active.contains(0))
        XCTAssertFalse(ledger.active.contains(150))
        XCTAssertLessThan(ledger.maximumActive, 50)
    }
}
