import XCTest

@MainActor
final class ContactsNavigationUITests: ProviderUITestCase {
    func testContactsGroupOffersEveryChannelAndReturnsToTheGroup() {
        let app = launch()
        let contacts = app.tabBars.buttons["Contacts"]
        XCTAssertTrue(contacts.waitForExistence(timeout: 15))
        contacts.tap()
        XCTAssertTrue(app.buttons["Grounding"].waitForExistence(timeout: 5))

        let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Mobile builders,")).firstMatch
        tap(group, in: app)
        XCTAssertTrue(app.navigationBars["Mobile builders"].waitForExistence(timeout: 5))
        let main = element("group-channel-session:group:mobile", in: app)
        let second = element("group-channel-session:group:mobile-release", in: app)
        XCTAssertTrue(main.waitForExistence(timeout: 5))
        XCTAssertTrue(second.exists)
        second.tap()
        XCTAssertTrue(app.buttons["conversation-title"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(main.waitForExistence(timeout: 5))
        main.tap()
        XCTAssertTrue(app.buttons["conversation-title"].waitForExistence(timeout: 5))
        app.terminate()
    }
}
