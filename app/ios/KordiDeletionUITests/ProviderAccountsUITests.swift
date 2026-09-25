import XCTest

/// Offline checks for the multi-account provider flow in the Beta app.
final class ProviderAccountsUITests: ProviderUITestCase {
    /// Settings → Authentication lists the bundled OMP providers and the
    /// OpenAI family with both saved ChatGPT accounts.
    func testCatalogListsOMPProvidersAndChatGPTWithTwoSavedAccounts() {
        let app = launch("--preview-authentication")
        let search = app.textFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        let searchPrompt = search.placeholderValue ?? search.label
        XCTAssertGreaterThanOrEqual(providerCount(in: searchPrompt), 60, searchPrompt)

        let openAI = app.buttons["connected-provider-openai"]
        XCTAssertTrue(openAI.waitForExistence(timeout: 5))
        XCTAssertTrue(openAI.label.contains("OpenAI"), openAI.label)
        XCTAssertTrue(openAI.label.contains("2 saved accounts"), openAI.label)
        XCTAssertTrue(openAI.label.contains("Work"), openAI.label)
        XCTAssertTrue(openAI.label.contains("Personal"), openAI.label)
        assertNoLoadFailure(in: app)
        capture("Provider catalog with saved ChatGPT accounts", app: app)

        search.tap()
        search.typeText("Anthropic")
        let anthropic = providerRow("Anthropic", in: app)
        XCTAssertTrue(anthropic.waitForExistence(timeout: 5))
        XCTAssertTrue(anthropic.label.contains("Claude Pro/Max"), anthropic.label)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == 'Anthropic (Claude Pro/Max)'")).count, 0)
        capture("Short name with qualifier subtitle", app: app)
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Anthropic".count))

        for provider in ["Cerebras", "Mistral"] {
            search.tap()
            search.typeText(provider)
            let row = providerRow(provider, in: app)
            XCTAssertTrue(row.waitForExistence(timeout: 5), "\(provider) is missing from the OMP catalog")
            capture("OMP-only provider \(provider)", app: app)
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: provider.count))
        }
        assertNoLoadFailure(in: app)
        app.terminate()
    }

    /// Layer 1 has no inputs: Saved accounts and one Add account row. Layer 2
    /// lists OpenAI's three iPhone methods; each opens its own login screen.
    func testDetailHasNoInputsAndOpenAIPickerListsThreeMethods() {
        let app = launch("--preview-authentication-detail")
        XCTAssertTrue(app.staticTexts["Work"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Personal"].exists)
        XCTAssertTrue(app.buttons["Remove Work"].exists)
        assertCopyRules(fullName: "OpenAI", in: app)
        XCTAssertTrue(app.buttons["provider-start-chat"].isEnabled)
        XCTAssertTrue(app.staticTexts["ChatGPT account · Active"].exists)
        XCTAssertEqual(app.textFields.count, 0, "The provider detail has no inputs")
        XCTAssertEqual(app.secureTextFields.count, 0, "The provider detail has no inputs")
        let add = app.buttons["provider-add-account"]
        XCTAssertTrue(add.exists)
        XCTAssertTrue(add.label.contains("Device code, ChatGPT sign-in, API key"), add.label)
        capture("Layer 1 OpenAI accounts", app: app)

        add.tap()
        XCTAssertTrue(app.navigationBars["Add OpenAI account"].waitForExistence(timeout: 5))
        XCTAssertEqual(methodRows(in: app).count, 3)
        XCTAssertLessThan(
            app.buttons["provider-login-method-openai-codex-device"].frame.minY,
            app.buttons["provider-login-method-openai-codex"].frame.minY,
            "Device code is the first method on iPhone"
        )
        for title in ["Browser sign-in", "Device code", "API key"] {
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch.exists, title)
        }
        capture("Layer 2 OpenAI methods", app: app)

        app.buttons["provider-login-method-openai"].tap()
        XCTAssertTrue(app.navigationBars["API key · OpenAI"].waitForExistence(timeout: 5))
        let hint = app.staticTexts["provider-login-key-instructions"]
        XCTAssertTrue(hint.label.contains("OPENAI_API_KEY"), hint.label)
        XCTAssertEqual(app.buttons["provider-login-save-key"].label, "Save")
        assertNoLoadFailure(in: app)
        capture("Layer 3 OpenAI API key", app: app)
        app.terminate()
    }

    /// ChatGPT device login: the code, Copy code, Open sign-in page with a
    /// copyable link, and a waiting line. Cancel in the navigation bar ends it.
    func testChatGPTDeviceCodeShowsCodeActionsAndWaitingState() {
        let app = launch("--preview-login-steps=openai-codex-device")
        let code = app.staticTexts["provider-login-device-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Device code · OpenAI"].exists)
        XCTAssertEqual(code.label, "PRVW-2468")
        XCTAssertEqual(app.buttons["provider-login-copy-code"].label, "Copy code")
        XCTAssertEqual(app.buttons["provider-login-open-url"].label, "Open sign-in page")
        XCTAssertTrue(app.staticTexts["provider-login-url"].label.hasPrefix("https://"))
        XCTAssertTrue(app.buttons["provider-login-copy-link"].exists)
        let waiting = element("provider-login-waiting", in: app)
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        XCTAssertTrue(waiting.label.contains("Waiting"), waiting.label)
        capture("ChatGPT device code waiting", app: app)

        app.buttons["provider-login-copy-code"].tap()
        XCTAssertTrue(code.exists, "Copying keeps the attempt open")

        let cancel = app.navigationBars.buttons["provider-login-cancel"]
        XCTAssertTrue(cancel.exists)
        cancel.tap()
        XCTAssertTrue(app.navigationBars["Add OpenAI account"].waitForExistence(timeout: 5))
        XCTAssertFalse(code.exists)
        capture("ChatGPT device code canceled", app: app)
        app.terminate()
    }

    /// API key: one method skips the picker. OMP's instructions, console link,
    /// and placeholder. After Save the screen keeps verifying while OMP checks
    /// the key; a rejected key ends the sign-in with Try again, and a valid key
    /// is saved and Done returns to the provider with the account highlighted.
    func testAPIKeyLoginShowsOMPInstructionsAndSavesTheAccount() {
        let app = launch("--preview-login-steps=cerebras")
        XCTAssertTrue(app.navigationBars["API key · Cerebras"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.navigationBars["Add Cerebras account"].exists)
        let instructions = app.staticTexts["provider-login-key-instructions"]
        XCTAssertEqual(instructions.label, "Copy your API key from the Cerebras dashboard.")
        XCTAssertTrue(app.links["provider-login-get-key"].exists || app.buttons["provider-login-get-key"].exists)
        let key = app.secureTextFields["provider-api-key"]
        XCTAssertEqual(key.placeholderValue, "csk-...")
        XCTAssertEqual(app.textFields["provider-login-label"].value as? String, "Work")
        XCTAssertFalse(app.buttons["provider-login-save-key"].isEnabled)
        capture("API key screen with OMP instructions", app: app)

        replace(app.textFields["provider-login-label"], with: "Team key", in: app)
        type("invalid-key", into: key, in: app)
        tap(app.buttons["provider-login-save-key"], in: app)
        let status = element("provider-login-status", in: app)
        let verifying = NSPredicate(format: "label CONTAINS 'Verifying with OMP'")
        expectation(for: verifying, evaluatedWith: status)
        waitForExpectations(timeout: 5)
        let reopened = app.secureTextFields["provider-login-input"]
        XCTAssertFalse(reopened.waitForExistence(timeout: 1), "The key field stays closed while OMP checks the key")
        let error = app.staticTexts["provider-login-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        XCTAssertEqual(error.label, "OMP did not accept that value. Check it and start again.")
        XCTAssertFalse(reopened.exists, "A rejected key ends the sign-in")
        capture("API key rejected by OMP", app: app)

        tap(app.buttons["provider-login-retry"], in: app)
        XCTAssertTrue(key.waitForExistence(timeout: 5))
        type("csk-synthetic", into: key, in: app)
        tap(app.buttons["provider-login-save-key"], in: app)
        expectation(for: verifying, evaluatedWith: status)
        waitForExpectations(timeout: 5)
        capture("API key verifying with OMP", app: app)
        finish(expecting: "Team key", in: app)
        capture("API key account saved", app: app)

        app.buttons["provider-start-chat"].tap()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 10), "Start chat opens a new agent chat")
        capture("Start chat opened", app: app)
        app.terminate()
    }

    /// Browser sign-in: the auth link with instructions and a copyable URL,
    /// then the paste step appended below it, then progress and completion.
    func testOAuthLoginAppendsStepsInOrderAndReturnsWithTheAccount() {
        let app = launch("--preview-login-steps=anthropic")
        let open = app.buttons["provider-login-open-url"]
        XCTAssertTrue(open.waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Browser sign-in · Anthropic"].exists)
        let instructions = app.staticTexts["provider-login-instructions"]
        XCTAssertTrue(instructions.label.hasPrefix("Complete login in your browser."), instructions.label)
        XCTAssertTrue(app.staticTexts["provider-login-url"].exists)
        let hint = app.staticTexts["provider-login-localhost-hint"]
        XCTAssertEqual(hint.label, "After you approve, the browser lands on a localhost page that cannot load. Copy that page's full address and paste it below.")
        XCTAssertFalse(app.textFields["provider-login-input"].exists, "The hint appears before the paste field")
        capture("OAuth sign-in link", app: app)

        open.tap()
        let paste = app.textFields["provider-login-input"]
        XCTAssertTrue(paste.waitForExistence(timeout: 10))
        XCTAssertEqual(paste.placeholderValue, "Full address from the browser, or the code")
        XCTAssertTrue(hint.exists, "The hint stays while waiting for the address")
        XCTAssertLessThan(open.frame.minY, paste.frame.minY, "The paste step is appended below the link")
        capture("OAuth paste step appended", app: app)

        type("synthetic-code", into: paste, in: app)
        tap(app.buttons["provider-login-submit"], in: app)
        let answer = app.staticTexts["provider-login-answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        XCTAssertEqual(answer.label, "synthetic-code", "Earlier answers stay visible")
        XCTAssertTrue(open.exists, "The sign-in link stays in the transcript")
        finish(expecting: "Work", in: app)
        assertCopyRules(fullName: "Anthropic (Claude Pro/Max)", in: app)
        capture("OAuth account saved", app: app)
        app.terminate()
    }

    /// Anthropic offers Browser sign-in and API key; Groq has one method and
    /// skips the picker.
    func testMethodPickerCountsAndSingleMethodSkip() {
        let anthropic = launch("--preview-login-steps=anthropic:api-key")
        XCTAssertTrue(anthropic.navigationBars["API key · Anthropic"].waitForExistence(timeout: 15))
        XCTAssertTrue(anthropic.staticTexts["provider-login-key-instructions"].label.contains("ANTHROPIC_API_KEY"))
        anthropic.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(anthropic.navigationBars["Add Anthropic account"].waitForExistence(timeout: 5))
        XCTAssertEqual(methodRows(in: anthropic).count, 2)
        capture("Layer 2 Anthropic methods", app: anthropic)
        anthropic.terminate()

        let groq = launch("--preview-login-steps=groq")
        XCTAssertTrue(groq.navigationBars["API key · Groq"].waitForExistence(timeout: 15))
        groq.navigationBars.buttons.element(boundBy: 0).tap()
        let add = groq.buttons["provider-add-account"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        XCTAssertTrue(add.label.contains("API key"), add.label)
        XCTAssertFalse(groq.navigationBars["Add Groq account"].exists)
        XCTAssertFalse(groq.buttons["provider-start-chat"].isEnabled, "Start chat needs a saved account")
        capture("Groq single method", app: groq)
        groq.terminate()
    }

    /// The Custom API form requires a model ID, saves on the provider screen,
    /// highlights the new account, and lets its model be edited in place.
    func testCustomAPIFormHighlightsTheSavedAccount() {
        let app = launch("--preview-login-steps=custom")
        let base = app.textFields["custom-base-url"]
        XCTAssertTrue(base.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["provider-start-chat"].isEnabled)
        let modelField = app.textFields["custom-model-id"]
        XCTAssertEqual(modelField.placeholderValue, "deepseek-chat")
        XCTAssertTrue(app.staticTexts["The model name your endpoint serves, sent as the Chat Completions model field."].exists)
        type("Lab endpoint", into: app.textFields["custom-label"], in: app)
        type("https://api.example.com/v1", into: base, in: app)
        type("synthetic-key", into: app.secureTextFields["custom-api-key"], in: app)
        XCTAssertFalse(app.buttons["custom-save"].isEnabled, "A model ID is required")
        type("deepseek-chat", into: modelField, in: app)
        tap(app.buttons["custom-save"], in: app)
        app.swipeDown()
        assertReturned(with: "Lab endpoint", active: true, in: app)
        XCTAssertEqual(app.staticTexts["saved-account-detail"].label, "Custom API · deepseek-chat · Active")
        capture("Custom API account saved", app: app)

        app.buttons["Edit Lab endpoint"].tap()
        XCTAssertEqual(modelField.value as? String, "deepseek-chat")
        type("https://api.example.com/v1", into: base, in: app)
        type("synthetic-key", into: app.secureTextFields["custom-api-key"], in: app)
        replace(modelField, with: "deepseek-reasoner", in: app)
        tap(app.buttons["custom-save"], in: app)
        app.swipeDown()
        let detail = app.staticTexts["saved-account-detail"]
        let updated = NSPredicate(format: "label == 'Custom API · deepseek-reasoner · Active'")
        expectation(for: updated, evaluatedWith: detail)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(app.staticTexts.matching(identifier: "saved-account-detail").count, 1, "Editing replaces the same account")
        XCTAssertTrue(app.buttons["provider-start-chat"].isEnabled)
        capture("Custom API model edited", app: app)
        app.terminate()
    }

    /// Device code: the code from OMP's "Enter code: {user_code}" text, Copy
    /// code, Open sign-in page, and OMP's waiting progress.
    func testDeviceCodeLoginShowsCodeAndCopyCode() {
        let app = launch("--preview-login-steps=kimi-code")
        let code = app.staticTexts["provider-login-device-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 15))
        XCTAssertEqual(code.label, "PRVW-2468")
        XCTAssertTrue(app.buttons["provider-login-copy-code"].exists)
        XCTAssertTrue(app.buttons["provider-login-open-url"].exists)
        let waiting = element("provider-login-waiting", in: app)
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        let progressed = NSPredicate(format: "label CONTAINS 'browser authorization'")
        expectation(for: progressed, evaluatedWith: waiting)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(code.exists, "The code stays visible while OMP waits")
        capture("Device code waiting for approval", app: app)
        app.terminate()
    }

    /// Vendor token: a secret prompt uses masked entry, the answer stays
    /// hidden in the transcript, and the account is saved.
    func testCustomLoginPromptUsesMaskedEntryAndSavesTheAccount() {
        let app = launch("--preview-login-steps=cloudflare-ai-gateway")
        let prompt = app.staticTexts["provider-login-prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Vendor token · Cloudflare AI Gateway"].exists)
        let secret = app.secureTextFields["provider-login-input"]
        XCTAssertTrue(secret.exists, "A secret prompt must use masked entry")
        XCTAssertFalse(app.textFields["provider-login-input"].exists)
        XCTAssertFalse(app.buttons["provider-login-submit"].isEnabled)
        capture("Custom prompt with masked entry", app: app)

        type("gateway-token", into: secret, in: app)
        tap(app.buttons["provider-login-submit"], in: app)
        let answer = app.staticTexts["provider-login-answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        XCTAssertEqual(answer.label, "Hidden", "Secret answers stay hidden")
        finish(expecting: "Work", in: app)
        capture("Custom login account saved", app: app)
        app.terminate()
    }

    private func providerRow(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    /// The full OMP name appears once, in the detail header, and "Sign in"
    /// appears at most twice on the screen.
    private func assertCopyRules(fullName: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let named = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", fullName))
        XCTAssertEqual(named.count, 1, "The full provider name must appear once", file: file, line: line)
        let signIn = NSPredicate(format: "label CONTAINS 'Sign in'")
        let signInCount = app.staticTexts.matching(signIn).count + app.buttons.matching(signIn).count
        XCTAssertLessThanOrEqual(signInCount, 2, file: file, line: line)
    }

    private func methodRows(in app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'provider-login-method-'"))
    }

    /// Waits for "Signed in as" with Done and Start chat, then for the automatic
    /// return to the provider screen with the new account highlighted and active.
    private func finish(
        expecting label: String,
        active: Bool = true,
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let completed = app.staticTexts["provider-login-completed"]
        XCTAssertTrue(completed.waitForExistence(timeout: 15), file: file, line: line)
        XCTAssertEqual(completed.label, "Signed in as \(label)", file: file, line: line)
        XCTAssertTrue(app.buttons["provider-login-done"].exists, file: file, line: line)
        XCTAssertTrue(app.buttons["provider-login-start-chat"].exists, file: file, line: line)
        assertReturned(with: label, active: active, in: app, file: file, line: line)
    }

    private func assertReturned(
        with label: String,
        active: Bool,
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let added = app.staticTexts["saved-account-new"]
        XCTAssertTrue(added.waitForExistence(timeout: 10), "The provider screen highlights the new account", file: file, line: line)
        XCTAssertEqual(added.label, label, file: file, line: line)
        XCTAssertTrue(added.isHittable, "The new account is scrolled into view", file: file, line: line)
        XCTAssertFalse(app.staticTexts["provider-login-completed"].exists, "The login screen closes on its own", file: file, line: line)
        let details = app.staticTexts.matching(identifier: "saved-account-detail")
        let activeRows = (0..<details.count).map { details.element(boundBy: $0).label }.filter { $0.hasSuffix("Active") }
        XCTAssertEqual(activeRows.count, 1, file: file, line: line)
        if active {
            XCTAssertEqual(details.count, 1, "The only account is the active one", file: file, line: line)
        }
        let startChat = app.buttons["provider-start-chat"]
        XCTAssertTrue(startChat.exists && startChat.isEnabled, "Start chat is enabled", file: file, line: line)
    }

    private func providerCount(in prompt: String) -> Int {
        let digits = prompt.split(whereSeparator: { !$0.isNumber }).first.map(String.init) ?? ""
        return Int(digits) ?? 0
    }
}
