import XCTest

@MainActor
final class SubsessionConversationUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testCompletedSubsessionStaysReadableAcrossFiveEntries() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-background-stop", "--preview-completed-subsession"]
        app.launch()
        let open = app.descendants(matching: .any).matching(identifier: "preview-subsession-open").firstMatch
        for visit in 0..<5 {
            XCTAssertTrue(open.waitForExistence(timeout: 10))
            open.tap()
            let end = app.staticTexts["Completed task end marker."].firstMatch
            XCTAssertTrue(end.waitForExistence(timeout: 8), "Visit \(visit) must display the completed answer")
            XCTAssertTrue(end.isHittable, "Visit \(visit) must position the actual answer inside the viewport")
            let capture = XCTAttachment(screenshot: app.screenshot())
            capture.name = "Completed subsession visible on visit \(visit)"
            capture.lifetime = .keepAlways
            add(capture)
            app.navigationBars.buttons.firstMatch.tap()
        }
        app.terminate()
    }
}
