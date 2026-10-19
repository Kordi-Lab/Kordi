import XCTest

/// Offline coverage for the compact model pill, immediate picks, effort, and account recovery.
final class AgentModelRouteUITests: ProviderUITestCase {
    func testModelPickAppliesWithoutSaveAndEffortHasReset() {
        let app = launch("--preview-agent-model", "-kordi.chatTheme.v1", "sand")
        let option = app.buttons["agent-model-option-openai/gpt-6-astra"]
        XCTAssertTrue(option.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["agent-model-save"].exists)
        option.tap()
        let pill = app.buttons["composer-model-picker"]
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        XCTAssertEqual(pill.value as? String, "GPT-6 Astra")
        XCTAssertFalse(option.exists)
        let composerTop = pill.frame.minY
        app.buttons["composer-effort-picker"].tap()
        let slider = element("agent-effort-slider", in: app)
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(slider.frame.maxY, composerTop - 44)
        XCTAssertLessThan(slider.frame.maxY, composerTop)
        XCTAssertLessThanOrEqual(slider.frame.width, 200)
        XCTAssertFalse(app.staticTexts["More effort may take longer"].exists)
        capture("Compact effort selection", app: app)
        app.buttons["Reset effort to model default"].tap()
        app.buttons["composer-effort-picker"].tap()
        XCTAssertEqual(app.buttons["composer-effort-picker"].value as? String, "Default")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: GPT-6 Astra")).firstMatch.exists)
        capture("Compact model and effort picker", app: app)
        app.terminate()
    }

    func testEffortKeepsDraftAndKeyboardAndModelMenuUsesPillAnchor() {
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
        XCTAssertLessThan(account.frame.maxY, pill.frame.minY)
        XCTAssertGreaterThan(account.frame.maxY, editor.frame.minY)
        app.buttons["Close model picker"].tap()
        app.buttons["composer-effort-picker"].tap()
        XCTAssertTrue(element("agent-effort-slider", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        app.buttons["composer-effort-picker"].tap()
        XCTAssertEqual(editor.value as? String, "Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        app.terminate()
    }

    func testAccountPickAppliesImmediately() {
        let app = launch("--preview-agent-model")
        let account = app.buttons["agent-model-account"]
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        account.tap()
        let personal = app.buttons["Personal"]
        XCTAssertTrue(personal.waitForExistence(timeout: 5))
        personal.tap()
        app.buttons["Close model picker"].tap()
        app.buttons["composer-model-picker"].tap()
        XCTAssertTrue(app.buttons["agent-model-account"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["agent-model-account"].label, "Personal")
        app.buttons["agent-model-account"].tap()
        XCTAssertFalse(app.buttons["agent-model-test-route"].exists)
        XCTAssertFalse(app.staticTexts["Test route uses provider quota."].exists)
        capture("Compact account picker", app: app)
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
}
