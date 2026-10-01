import XCTest

@MainActor
final class ChatProjectUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testMoveProjectSessionAndReturnToRecents() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-agent-page", "--preview-projects"]
        app.launch()
        let session = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Plan the mobile release,")).firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.tap()
        let project = app.buttons["kordi"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        XCTAssertTrue(app.navigationBars["Choose project"].waitForExistence(timeout: 5))
        let pickerCapture = XCTAttachment(screenshot: app.screenshot())
        pickerCapture.name = "Projects available below the composer"
        pickerCapture.lifetime = .keepAlways
        add(pickerCapture)
        app.buttons["website"].firstMatch.tap()
        XCTAssertTrue(app.buttons["website"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["website"].firstMatch.tap()
        XCTAssertTrue(app.buttons["No project"].waitForExistence(timeout: 5))
        app.buttons["No project"].tap()
        XCTAssertTrue(app.buttons["Choose project"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["Recents"].waitForExistence(timeout: 5))
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        app.buttons["Recents"].tap()
        XCTAssertEqual(app.buttons["Recents"].value as? String, "Collapsed")
        XCTAssertFalse(session.exists, "The detached session belongs to Recents, not a project folder")
        let recentsCapture = XCTAttachment(screenshot: app.screenshot())
        recentsCapture.name = "Detached session is hidden when Recents collapses"
        recentsCapture.lifetime = .keepAlways
        add(recentsCapture)
        app.buttons["Recents"].tap()
        XCTAssertEqual(app.buttons["Recents"].value as? String, "Expanded")
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        app.terminate()
    }
}
