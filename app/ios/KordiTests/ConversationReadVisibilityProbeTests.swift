import UIKit
import XCTest
@testable import Kordi

@MainActor
final class ConversationReadVisibilityProbeTests: XCTestCase {
    func testVisibilityIsDeferredAndTracksKeyboardSizedViewportWithoutRepeatedUpdates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 600)
        let controller = UIViewController()
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil }
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.contentSize = CGSize(width: 320, height: 1_000)
        controller.view.addSubview(scroll)
        let probe = ConversationReadVisibilityProbe.ProbeView(frame: CGRect(x: 0, y: 500, width: 320, height: 100))
        scroll.addSubview(probe)
        var reported: [Bool] = []
        probe.configure(messageID: "reply", mode: .latest) { reported.append($0) }
        probe.layoutSubviews()
        XCTAssertTrue(reported.isEmpty, "Layout must not synchronously mutate SwiftUI read state")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reported, [true])
        for _ in 0..<10 {
            probe.configure(messageID: "reply", mode: .latest) { reported.append($0) }
            probe.layoutSubviews()
        }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reported, [true], "Unchanged layout must not repeatedly invalidate the transcript")
        scroll.frame.size.height = 300
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reported, [true, false], "A keyboard-sized viewport must hide the lower reply")
        scroll.contentOffset.y = 300
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reported, [true, false, true])
        probe.disconnect()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reported, [true, false, true, false])
        scroll.contentOffset.y = 0
        scroll.frame.size.height = 600
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reported, [true, false, true, false], "Detached rows must stop observing geometry")
    }
}
