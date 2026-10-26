import XCTest

/// Guards issue #2094: inside a `NavigationStack` hosted by a child
/// `UIHostingController` (every screen `MainNavigationHost` pushes), a view
/// wrapped by `navigationDestination(item:)` gets its sheets and full-screen
/// covers rebuilt with fresh state on every update.
final class StableNavigationDestinationTests: XCTestCase {
    func testScreensUseTheStableNavigationDestinationForItemBindings() throws {
        let appSources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: appSources, includingPropertiesForKeys: nil))
        var offenders: [String] = []
        for case let file as URL in files where file.pathExtension == "swift" {
            guard file.lastPathComponent != "StableNavigationDestination.swift" else { continue }
            let source = try String(contentsOf: file, encoding: .utf8)
            if source.contains(".navigationDestination(item:") { offenders.append(file.lastPathComponent) }
        }

        XCTAssertEqual(offenders, [], "Use stableNavigationDestination(item:) instead (#2094)")
    }
}
