import XCTest

final class AccessibilityReproductionTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testScenarioCompletesWithAccessibilityInspection() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Probe complete"].waitForExistence(timeout: 45))
        app.terminate()
    }
}
