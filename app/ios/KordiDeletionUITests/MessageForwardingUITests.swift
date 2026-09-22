import XCTest

@MainActor
final class MessageForwardingUITests: XCTestCase {
    func testSearchPublicIdentityAndForwardToSelectedGroup() {
        let app = launch()
        let search = app.textFields["forward-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["forward-submit"].isEnabled)
        app.buttons["People"].tap()
        search.tap()
        search.typeText("284106395")
        let result = destinations(app).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertTrue(result.label.contains("Direct message"))
        XCTAssertTrue(result.label.contains("Maya"))
        capture("Search by public identity", app: app)
        app.buttons["Clear search"].tap()
        app.buttons["Groups"].tap()
        let group = destinations(app).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 5))
        group.tap()
        XCTAssertTrue(app.staticTexts["forward-selection"].exists)
        XCTAssertTrue(app.buttons["forward-submit"].isEnabled)
        capture("Selected group with context", app: app)
        app.buttons["forward-submit"].tap()
        XCTAssertTrue(app.staticTexts["forward-success"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["forward-success"].label, "Message forwarded")
        XCTAssertFalse(app.textFields["forward-search"].exists)
        capture("Compact translucent success", app: app)
        XCTAssertFalse(app.buttons["Done"].exists)
        XCTAssertTrue(app.staticTexts["forward-success"].waitForNonExistence(timeout: 5))
        app.terminate()
    }

    func testBatchForwardAtLargeTextSize() {
        let app = launch(batch: true, largeText: true)
        XCTAssertTrue(app.textFields["forward-search"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Forward 4 messages"].exists)
        XCTAssertFalse(app.textFields["Add a comment (optional)"].exists)
        app.buttons["Groups"].tap()
        destinations(app).firstMatch.tap()
        capture("Batch forwarding with large text", app: app)
        let send = app.buttons["forward-submit"]
        XCTAssertTrue(send.isHittable)
        send.tap()
        XCTAssertTrue(app.staticTexts["forward-success"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["forward-success"].label, "Messages forwarded")
        app.terminate()
    }

    private func launch(batch: Bool = false, largeText: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-forward-message"]
        if batch { app.launchArguments.append("--preview-forward-batch") }
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", largeText ? "UICTContentSizeCategoryXXXL" : "UICTContentSizeCategoryM"]
        app.launch()
        return app
    }

    private func destinations(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "forward-destination-"))
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
