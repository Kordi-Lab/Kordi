import XCTest

@MainActor
final class TrajectoryExpansionUITests: XCTestCase {
    func testBriefConversationExpansionRecording() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-short-trajectory", "--preview-brief-trajectory"]
        app.launch()
        defer { app.terminate() }
        let header = app.buttons["Worked for 3s"].firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 15))
        let earlier = app.staticTexts["One"].firstMatch
        let initialY = earlier.frame.minY
        for _ in 0..<3 {
            header.tap()
            XCTAssertEqual(header.value as? String, "Expanded")
            XCTAssertEqual(earlier.frame.minY, initialY, accuracy: 2)
            header.tap()
            XCTAssertEqual(header.value as? String, "Collapsed")
            XCTAssertEqual(earlier.frame.minY, initialY, accuracy: 2)
        }
    }

    func testRealTrajectoryTapsKeepEarlierMessagesInPlace() throws {
        try checkTaps(keyboardInitiallyOpen: false)
    }

    func testTrajectoryTapKeepsKeyboardAndEarlierMessagesStable() throws {
        try checkTaps(keyboardInitiallyOpen: true)
    }

    func testBlankTimelineTapStillDismissesKeyboard() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-short-trajectory"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["Worked for 3s"].firstMatch.waitForExistence(timeout: 15))
        app.textViews.firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: 15, dy: app.navigationBars.firstMatch.frame.maxY + 8)
        ).tap()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.keyboards.firstMatch)
        wait(for: [dismissed], timeout: 5)
    }

    private func checkTaps(keyboardInitiallyOpen: Bool) throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-short-trajectory"]
        app.launch()
        defer { app.terminate() }
        let header = app.buttons["Worked for 3s"].firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 15))
        let request = app.staticTexts["Check the next sample when ready."].firstMatch
        XCTAssertTrue(request.waitForExistence(timeout: 5))
        if keyboardInitiallyOpen {
            app.textViews.firstMatch.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }
        for cycle in 0..<4 {
            let initialHeader = header.frame
            let initialRequest = request.frame
            header.tap()
            XCTAssertEqual(header.value as? String, "Expanded")
            if keyboardInitiallyOpen { XCTAssertTrue(app.keyboards.firstMatch.exists) }
            XCTAssertEqual(request.frame.minY, initialRequest.minY, accuracy: 2,
                "Expanding must not move the earlier message on cycle \(cycle)")
            XCTAssertEqual(header.frame.minY, initialHeader.minY, accuracy: 2)
            let capture = XCTAttachment(screenshot: app.screenshot())
            capture.name = "Synthetic real-tap trajectory cycle \(cycle)"
            capture.lifetime = .keepAlways
            add(capture)
            header.tap()
            XCTAssertEqual(header.value as? String, "Collapsed")
        }
    }
}
