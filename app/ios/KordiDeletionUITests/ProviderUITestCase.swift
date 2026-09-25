import XCTest

/// Shared launch and interaction helpers for the provider-account UI tests.
/// Every launch uses preview data, so no test contacts Kordi Cloud, OMP, or a
/// provider sign-in service.
@MainActor
class ProviderUITestCase: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func launch(_ arguments: String...) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data"] + arguments
        app.launch()
        return app
    }

    func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func replace(_ field: XCUIElement, with text: String, in app: XCUIApplication) {
        XCTAssertTrue(reveal(field, in: app))
        // Tap the trailing edge so the cursor lands after the suggested name.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let existing = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + text)
    }

    func type(_ text: String, into field: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(reveal(field, in: app))
        field.tap()
        field.typeText(text)
    }

    func tap(_ element: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(reveal(element, in: app))
        element.tap()
    }

    /// Scrolls in short steps, down and then up, until the element can be tapped.
    /// Short drags avoid skipping rows that sit under the navigation bar.
    func reveal(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<8 {
            if element.exists && element.isHittable { return true }
            nudge(app, contentUp: true)
        }
        for _ in 0..<14 {
            if element.exists && element.isHittable { return true }
            nudge(app, contentUp: false)
        }
        return element.exists && element.isHittable
    }

    private func nudge(_ app: XCUIApplication, contentUp: Bool) {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: contentUp ? 0.6 : 0.35))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: contentUp ? 0.35 : 0.6))
        from.press(forDuration: 0.05, thenDragTo: to)
    }

    func assertNoLoadFailure(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'could not load'"))
        XCTAssertEqual(failure.count, 0, "Unexpected load failure text", file: file, line: line)
    }

    func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
