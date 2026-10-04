import XCTest

@MainActor
final class MessageLayoutUITests: ProviderUITestCase {
    func testThreadsSeparatesDatesAndKeepsMessageTimesCompact() {
        let app = launch("--preview-contact-chat", "--preview-thread-dates", "-kordi.messageLayout.v1", "threads", "-kordi.appearance", "light")
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 15))
        let source = element("message-m5", in: app)
        XCTAssertTrue(reveal(source, in: app))
        let dividers = app.descendants(matching: .any).matching(identifier: "thread-date-divider")
        XCTAssertEqual(dividers.count, 2)
        for divider in dividers.allElementsBoundByIndex {
            XCTAssertFalse(divider.label.contains(":"))
            XCTAssertTrue(divider.label.contains(String(Calendar.current.component(.year, from: Date()))))
        }
        let time = element("thread-message-time-m5", in: app)
        XCTAssertTrue(time.exists)
        XCTAssertTrue(time.label.contains(":"))
        XCTAssertFalse(time.label.contains(String(Calendar.current.component(.year, from: Date()))))
        capture("Daily date dividers with time-only message headers", app: app)
        app.terminate()
    }

    func testDarkThreadsSendsQuotedReplyInTheMainConversation() {
        let app = launch("--preview-contact-chat", "-kordi.messageLayout.v1", "threads", "-kordi.appearance", "dark")
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 15))
        let source = element("message-m5", in: app)
        XCTAssertTrue(reveal(source, in: app))
        source.press(forDuration: 0.5)
        XCTAssertTrue(app.buttons["Close message actions"].waitForExistence(timeout: 5))
        capture("Dark Threads actions with a clean preview", app: app)
        app.buttons["Quote"].tap()
        XCTAssertTrue(app.buttons["Remove quote"].waitForExistence(timeout: 5))
        let editor = app.textViews["Message Maya Chen"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("A main conversation quote in Threads.")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["A main conversation quote in Threads."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Remove quote"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Add photo, video, or file"].exists)
        capture("Quoted reply sent in the main conversation", app: app)
        app.terminate()
    }

    func testThreadsPersistsAndKeepsQuoteAndMessageActions() {
        var app = launch("--preview-appearance")
        let picker = app.segmentedControls["message-layout-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 15))
        picker.buttons["Threads"].tap()
        XCTAssertTrue(picker.buttons["Threads"].isSelected)
        capture("Threads selected in Appearance", app: app)
        app.terminate()

        app = launch("--preview-contact-chat")
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 15))
        let quote = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Quoted message from")).firstMatch
        XCTAssertTrue(reveal(quote, in: app))
        capture("Continuous messages with quoted source", app: app)
        quote.tap()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].exists)

        let message = element("message-m5", in: app)
        XCTAssertTrue(reveal(message, in: app))
        message.press(forDuration: 0.5)
        XCTAssertTrue(app.buttons["Close message actions"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Quote"].exists)
        XCTAssertTrue(app.buttons["Open discussion"].exists)
        XCTAssertTrue(app.buttons["Forward"].exists)
        XCTAssertTrue(app.buttons["Select"].exists)
        capture("All message actions in Threads", app: app)
        app.buttons["Close message actions"].tap()
        app.terminate()

        app = launch("--preview-appearance")
        let restored = app.segmentedControls["message-layout-picker"]
        XCTAssertTrue(restored.waitForExistence(timeout: 15))
        XCTAssertTrue(restored.buttons["Threads"].isSelected)
        restored.buttons["Chat"].tap()
        app.terminate()
    }
}
