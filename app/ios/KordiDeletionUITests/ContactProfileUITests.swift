import XCTest

/// Offline coverage for the contact profile sheet: the avatar and the swipe
/// open it, the row still opens the chat.
final class ContactProfileUITests: ProviderUITestCase {
    private func mayaRow(in app: XCUIApplication) -> XCUIElement {
        app.staticTexts["Maya Chen"].firstMatch
    }

    func testAvatarOpensProfileAndRowOpensChat() {
        let app = launch("--preview-contacts")
        let name = mayaRow(in: app)
        XCTAssertTrue(name.waitForExistence(timeout: 15))

        // The avatar sits 56 points left of the name.
        name.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: -40, dy: 8))
            .tap()
        let close = element("contact-profile-close", in: app)
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Kordi ID"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Shared with you"].waitForExistence(timeout: 5))
        capture("Contact profile", app: app)

        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))

        name.tap()
        XCTAssertFalse(close.waitForExistence(timeout: 2))
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 5))
        capture("Chat after row tap", app: app)
    }

    func testSwipeOpensProfile() {
        let app = launch("--preview-contacts")
        let name = mayaRow(in: app)
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        name.swipeLeft()
        let profile = app.buttons["Profile"].firstMatch
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        profile.tap()
        XCTAssertTrue(element("contact-profile-close", in: app).waitForExistence(timeout: 5))
    }
}
