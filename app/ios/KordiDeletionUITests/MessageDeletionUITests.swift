import XCTest

@MainActor
final class MessageDeletionUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTextDeletionClosesMenuAndPreservesNeighbor() {
        let app = launchTextDeletion()
        let target = message("m5", in: app)
        capture("Text before deletion", app: app)
        app.buttons["Delete"].tap()
        let confirm = app.buttons["Delete for me"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        for frame in 1...3 {
            capture("Particle transition frame \(frame)", app: app)
            Thread.sleep(forTimeInterval: 0.15)
        }
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
        XCTAssertTrue(target.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        XCTAssertTrue(message("m4-voice", in: app).exists)
        capture("Text after deletion", app: app)
        app.terminate()
    }

    func testPhotoDeletionForEveryoneClosesMenuAndKeepsComposerInteractive() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-media-messages", "--preview-message-delete-photo"]
        app.launch()
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 15))
        capture("Photos before deletion", app: app)
        app.buttons["Delete"].tap()
        let confirm = app.buttons["Delete for me and Maya Chen"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        for frame in 1...3 {
            capture("Particle transition frame \(frame)", app: app)
            Thread.sleep(forTimeInterval: 0.15)
        }
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        capture("Photos after deletion", app: app)
        let composer = app.buttons["Add photo, video, or file"]
        XCTAssertTrue(composer.isHittable)
        composer.tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5))
        capture("Composer responds after photo deletion", app: app)
        app.terminate()
    }

    func testTextDeletionAnimationHitches() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Hitch metrics require iOS 26.") }
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTHitchMetric(application: app)], options: options) {
            openTextMenu(in: app)
            app.buttons["Delete"].tap()
            XCTAssertTrue(app.buttons["Delete for me"].waitForExistence(timeout: 5))
            startMeasuring()
            app.buttons["Delete for me"].tap()
            XCTAssertTrue(app.buttons["Delete for me"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(message("m5", in: app).waitForNonExistence(timeout: 5))
            XCTAssertTrue(message("m4-voice", in: app).exists)
            stopMeasuring()
            app.terminate()
        }
    }

    private func launchTextDeletion() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        openTextMenu(in: app)
        return app
    }

    private func openTextMenu(in app: XCUIApplication) {
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-message-delete"]
        for _ in 0..<3 {
            app.launch()
            if app.buttons["Delete"].waitForExistence(timeout: 10) { return }
            app.terminate()
        }
        XCTFail("The offline message action preview did not open.")
    }

    private func message(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "message-\(id)").firstMatch
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
