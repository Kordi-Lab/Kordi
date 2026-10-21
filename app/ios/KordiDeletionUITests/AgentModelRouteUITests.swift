import XCTest

/// Offline coverage for the composer model row, immediate picks, effort, and account recovery.
final class AgentModelRouteUITests: ProviderUITestCase {
    /// List pages are centred on the full window, below the status bar, whatever the keyboard did.
    private func assertPanelCentered(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let panel = element("agent-model-panel", in: app)
        XCTAssertTrue(panel.waitForExistence(timeout: 5), file: file, line: line)
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertLessThan(abs(panel.frame.midY - app.frame.midY), 8, file: file, line: line)
        XCTAssertGreaterThan(panel.frame.minY, 62, file: file, line: line)
        XCTAssertLessThanOrEqual(panel.frame.height, app.frame.height * 0.6 + 1, file: file, line: line)
    }

    func testModelPickAppliesWithoutSaveAndEffortPanelIsCentered() {
        let app = launch("--preview-agent-model", "-kordi.chatTheme.v2", "sand")
        let option = app.buttons["agent-model-option-openai/gpt-6-astra"]
        XCTAssertTrue(option.waitForExistence(timeout: 15))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        assertPanelCentered(in: app)
        XCTAssertFalse(app.buttons["agent-model-save"].exists)
        option.tap()
        XCTAssertFalse(option.exists)
        let pill = app.buttons["composer-model-picker"]
        XCTAssertFalse(pill.exists)
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        capture("Idle", app: app)
        editor.tap()
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        editor.typeText("Looks good, one more pass on the slider")
        capture("Typing", app: app)
        XCTAssertEqual(pill.value as? String, "GPT-6 Astra")
        app.buttons["composer-effort-picker"].tap()
        let slider = element("agent-effort-slider", in: app)
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        XCTAssertLessThan(abs(slider.frame.midX - app.frame.midX), 8)
        XCTAssertFalse(app.buttons["Reset effort to model default"].exists)
        XCTAssertFalse(app.staticTexts["More effort may take longer"].exists)
        // The keyboard steps aside under the full-screen blur and returns on close.
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        // Anchored above the resting two-row field: home indicator 34 + padding 9 + field 102
        // + gap 24 + panel padding 16 = 185 points from the bottom, whatever the keyboard did.
        XCTAssertLessThan(abs(slider.frame.maxY - (app.frame.maxY - 185)), 12)
        capture("Effort", app: app)
        element("agent-model-backdrop", in: app).tap()
        XCTAssertTrue(slider.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: GPT-6 Astra")).firstMatch.exists)
        app.terminate()
    }

    func testEffortKeepsDraftAndKeyboardAndModelMenuSitsAboveField() {
        let app = launch("--preview-agent-model")
        app.buttons["agent-model-option-openai/gpt-6-astra"].tap()
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Keep this draft")
        let pill = app.buttons["composer-model-picker"]
        pill.tap()
        let account = app.buttons["agent-model-account"]
        XCTAssertTrue(account.waitForExistence(timeout: 5))
        // Centred, below the status bar and the navigation header, at most 60% tall.
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        assertPanelCentered(in: app)
        capture("Models", app: app)
        XCTAssertGreaterThan(app.buttons["Close model picker"].frame.minY, 110)
        XCTAssertLessThan(abs(account.frame.midX - app.frame.midX), 8)
        account.tap()
        XCTAssertTrue(app.buttons["Personal"].waitForExistence(timeout: 5))
        assertPanelCentered(in: app)
        app.buttons["Close model picker"].tap()
        XCTAssertTrue(account.waitForNonExistence(timeout: 5))
        XCTAssertEqual(pill.value as? String, "GPT-6 Astra")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["composer-effort-picker"].tap()
        XCTAssertTrue(element("agent-effort-slider", in: app).waitForExistence(timeout: 5))
        element("agent-model-backdrop", in: app).tap()
        XCTAssertTrue(element("agent-effort-slider", in: app).waitForNonExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.terminate()
    }

    func testSendKeepsTranscriptAndBlurCollapsesComposer() {
        let app = launch("--preview-agent-model", "-kordi.chatTheme.v2", "sand")
        app.buttons["agent-model-option-openai/gpt-6-astra"].tap()
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Checking the floating composer")
        app.buttons["Send message"].tap()
        let sent = app.staticTexts["Checking the floating composer"]
        XCTAssertTrue(sent.waitForExistence(timeout: 5))
        XCTAssertTrue(sent.isHittable)
        XCTAssertLessThan(sent.frame.maxY, editor.frame.minY)
        // The keyboard stays up and the newest message stays visible above the field.
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists)
        editor.typeText("Second message under the glass")
        app.buttons["Send message"].tap()
        let newest = app.staticTexts["Second message under the glass"]
        XCTAssertTrue(newest.waitForExistence(timeout: 5))
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        XCTAssertTrue(keyboard.exists)
        XCTAssertTrue(newest.isHittable)
        XCTAssertLessThan(newest.frame.maxY, editor.frame.minY)
        XCTAssertGreaterThan(newest.frame.minY, 100)
        XCTAssertTrue(sent.exists)
        capture("After send", app: app)
        // Empty transcript space beside an outgoing bubble; timestamps and bubbles own their taps.
        sent.coordinate(withNormalizedOffset: CGVector(dx: -0.18, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["composer-model-picker"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("Collapsed after blur", app: app)
        app.terminate()
    }

    func testAccountPickAppliesImmediately() {
        let app = launch("--preview-agent-model")
        let account = app.buttons["agent-model-account"]
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        account.tap()
        let personal = app.buttons["Personal"]
        XCTAssertTrue(personal.waitForExistence(timeout: 5))
        assertPanelCentered(in: app)
        personal.tap()
        app.buttons["Close model picker"].tap()
        XCTAssertTrue(app.buttons["composer-model-picker"].waitForNonExistence(timeout: 5))
        app.textViews.firstMatch.tap()
        XCTAssertTrue(app.buttons["composer-model-picker"].waitForExistence(timeout: 5))
        app.buttons["composer-model-picker"].tap()
        XCTAssertTrue(app.buttons["agent-model-account"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["agent-model-account"].label, "Personal")
        app.buttons["agent-model-account"].tap()
        XCTAssertFalse(app.buttons["agent-model-test-route"].exists)
        XCTAssertFalse(app.staticTexts["Test route uses provider quota."].exists)
        capture("Accounts", app: app)
        app.terminate()
    }

    func testRemovedAccountRequiresExplicitReplacement() {
        let app = launch("--preview-agent-model", "--preview-account-unavailable")
        let unavailable = element("agent-model-account-unavailable", in: app)
        XCTAssertTrue(unavailable.waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons["composer-model-picker"].value as? String, "Account unavailable")
        app.buttons["agent-model-account"].tap()
        app.buttons["Personal"].tap()
        XCTAssertEqual(app.buttons["composer-model-picker"].value as? String, "GPT-5.6 Sol")
        app.terminate()
    }

    func testMissingProviderNeverSilentlyChangesAccount() {
        let app = launch("--preview-agent-model", "--preview-provider-unavailable")
        XCTAssertTrue(element("agent-model-account-unavailable", in: app).waitForExistence(timeout: 15))
        app.buttons["agent-model-account"].tap()
        XCTAssertTrue(app.staticTexts["No signed-in account. Connect one in Settings → Authentication."].exists)
        XCTAssertEqual(app.buttons["composer-model-picker"].value as? String, "Account unavailable")
        app.terminate()
    }

    func testProjectsListHierarchyCapture() {
        let app = launch("--preview-agent-page", "--preview-projects")
        XCTAssertTrue(app.staticTexts["website"].firstMatch.waitForExistence(timeout: 15))
        capture("Projects", app: app)
        app.terminate()
    }
}
