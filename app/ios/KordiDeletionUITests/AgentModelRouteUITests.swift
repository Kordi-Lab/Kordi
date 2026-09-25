import XCTest

/// Offline checks for the agent model sheet: separate route controls, Test
/// route, and routes whose saved account is gone.
final class AgentModelRouteUITests: ProviderUITestCase {
    /// The model sheet has separate Provider, Account, Model, and Thinking
    /// controls, and Test route reports the confirmed runner, account, and model
    /// for each selected account.
    func testModelSheetTestRouteReportsRunnerAccountAndModel() {
        let app = launch("--preview-agent-model")
        let provider = app.buttons["Provider"]
        let account = app.buttons["Account"]
        let model = app.buttons["Model"]
        let thinking = app.buttons["Thinking level"]
        XCTAssertTrue(provider.waitForExistence(timeout: 15))
        XCTAssertTrue(account.exists)
        XCTAssertTrue(model.exists)
        XCTAssertTrue(thinking.exists)
        XCTAssertEqual(provider.value as? String, "OpenAI")
        XCTAssertEqual(account.value as? String, "Work")
        XCTAssertEqual(model.value as? String, "gpt-5.6-sol")
        XCTAssertEqual(thinking.value as? String, "Medium")
        assertNoLoadFailure(in: app)
        capture("Agent model controls", app: app)

        runRouteTest(expectingAccount: "Work", model: "gpt-5.6-sol", in: app)

        account.tap()
        let personal = app.buttons["Personal"]
        XCTAssertTrue(personal.waitForExistence(timeout: 5))
        personal.tap()
        XCTAssertEqual(account.value as? String, "Personal")
        XCTAssertEqual(model.value as? String, "gpt-5.6-sol", "Changing the account must keep the model")
        XCTAssertFalse(element("agent-model-route-test-result", in: app).exists)

        runRouteTest(expectingAccount: "Personal", model: "gpt-5.6-sol", in: app)
        app.terminate()
    }

    /// Removing an account keeps the other one. A session routed to the removed
    /// account stays attached to it, shows Account unavailable, and cannot test
    /// or save until another account is chosen.
    func testRemovedRoutedAccountShowsUnavailableAndDisablesTestRoute() {
        let settings = launch("--preview-authentication-detail")
        let removeWork = settings.buttons["Remove Work"]
        XCTAssertTrue(removeWork.waitForExistence(timeout: 15))
        removeWork.tap()
        let confirm = settings.buttons["Remove account"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(settings.staticTexts["Work"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(settings.staticTexts["Personal"].exists)
        capture("Work removed and Personal kept", app: settings)
        settings.terminate()

        let app = launch("--preview-agent-model", "--preview-account-unavailable")
        let account = app.buttons["Account"]
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        XCTAssertEqual(account.value as? String, "Account unavailable")
        XCTAssertEqual(app.buttons["Provider"].value as? String, "OpenAI")
        XCTAssertEqual(app.buttons["Model"].value as? String, "gpt-5.6-sol")
        XCTAssertTrue(element("agent-model-account-unavailable", in: app).exists)
        XCTAssertFalse(app.buttons["agent-model-test-route"].isEnabled)
        XCTAssertFalse(app.buttons["agent-model-save"].isEnabled)
        capture("Routed account unavailable", app: app)

        account.tap()
        let personal = app.buttons["Personal"]
        XCTAssertTrue(personal.waitForExistence(timeout: 5))
        personal.tap()
        XCTAssertEqual(account.value as? String, "Personal")
        XCTAssertTrue(element("agent-model-account-unavailable", in: app).waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["agent-model-test-route"].isEnabled)
        capture("Another account explicitly selected", app: app)
        app.terminate()
    }

    /// Removing a provider's last account keeps the routed provider selected
    /// with Account unavailable instead of moving the route to another provider.
    func testRoutedProviderWithoutAccountsStaysSelectedAndUnavailable() {
        let app = launch("--preview-agent-model", "--preview-provider-unavailable")
        let provider = app.buttons["Provider"]
        let account = app.buttons["Account"]
        XCTAssertTrue(provider.waitForExistence(timeout: 15))
        XCTAssertEqual(provider.value as? String, "OpenAI")
        XCTAssertEqual(account.value as? String, "Account unavailable")
        XCTAssertEqual(app.buttons["Model"].value as? String, "gpt-5.6-sol")
        XCTAssertTrue(element("agent-model-account-unavailable", in: app).exists)
        XCTAssertFalse(app.buttons["agent-model-test-route"].isEnabled)
        XCTAssertFalse(app.buttons["agent-model-save"].isEnabled)
        capture("Routed provider without accounts", app: app)

        provider.tap()
        let anthropic = app.buttons["Anthropic"]
        XCTAssertTrue(anthropic.waitForExistence(timeout: 5))
        anthropic.tap()
        XCTAssertEqual(account.value as? String, "Team")
        XCTAssertTrue(element("agent-model-account-unavailable", in: app).waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["agent-model-test-route"].isEnabled)
        capture("Another provider explicitly selected", app: app)
        app.terminate()
    }

    private func runRouteTest(expectingAccount account: String, model: String, in app: XCUIApplication) {
        let testRoute = app.buttons["agent-model-test-route"]
        XCTAssertTrue(testRoute.isEnabled)
        testRoute.tap()
        let pending = element("agent-model-route-test-pending", in: app)
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        XCTAssertFalse(testRoute.isEnabled)
        capture("Test route pending for \(account)", app: app)

        let result = element("agent-model-route-test-result", in: app)
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        XCTAssertTrue(result.label.contains("Runner OMP"), result.label)
        XCTAssertTrue(result.label.contains(account), result.label)
        XCTAssertTrue(result.label.contains(model), result.label)
        for secret in ["token", "preview-token", "ios-codex:", "provider_auth_"] {
            XCTAssertFalse(result.label.lowercased().contains(secret), result.label)
        }
        XCTAssertFalse(pending.exists)
        capture("Test route result for \(account)", app: app)
    }
}
