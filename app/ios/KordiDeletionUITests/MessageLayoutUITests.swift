import XCTest

@MainActor
final class MessageLayoutUITests: ProviderUITestCase {
    func testAskAgentUsesNativeHeaderAndPreservesSessionActions() {
        let app = launch("--preview-contact-chat", "-kordi.appearance", "light")
        let parentTitle = app.buttons["conversation-title"]
        XCTAssertTrue(parentTitle.waitForExistence(timeout: 15))
        let parentTitleFrame = parentTitle.frame
        capture("Conversation native header", app: app)
        app.buttons["Ask Agent"].tap()

        let title = element("companion-title", in: app)
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        let navigationBar = app.navigationBars.firstMatch
        XCTAssertTrue(navigationBar.descendants(matching: .any)["companion-title"].exists)
        XCTAssertEqual(title.frame.midX, app.frame.midX, accuracy: 2)
        XCTAssertEqual(title.frame.midY, parentTitleFrame.midY, accuracy: 2)
        XCTAssertEqual(title.frame.height, parentTitleFrame.height, accuracy: 2)
        capture("Ask Agent aligned native header", app: app)

        let sessionMenu = app.buttons["companion-session-menu"]
        XCTAssertTrue(sessionMenu.exists)
        let previousSession = sessionMenu.value as? String
        sessionMenu.tap()
        XCTAssertTrue(app.buttons["Switch session"].waitForExistence(timeout: 5))
        app.buttons["New session"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertNotEqual(sessionMenu.value as? String, previousSession)
        XCTAssertTrue(navigationBar.descendants(matching: .any)["companion-title"].exists)

        // Native navigation retains the interactive edge-swipe back gesture.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.45))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45))
        start.press(forDuration: 0.1, thenDragTo: end)
        XCTAssertTrue(parentTitle.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Ask Agent"].exists)
        app.terminate()
    }

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
        XCTAssertTrue(element("thread-message-actions-sheet", in: app).waitForExistence(timeout: 5))
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
        let threads = element("appearance-option-threads", in: app)
        XCTAssertTrue(threads.waitForExistence(timeout: 15))
        threads.tap()
        XCTAssertTrue(threads.isSelected)
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
        let sheet = element("thread-message-actions-sheet", in: app)
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(sheet.frame.width, app.frame.width * 0.9)
        XCTAssertGreaterThan(sheet.frame.minY, app.frame.height * 0.3)
        XCTAssertTrue(app.buttons["Quote"].exists)
        XCTAssertTrue(app.buttons["thread-action-reply"].exists)
        XCTAssertTrue(app.buttons["Forward"].exists)
        XCTAssertFalse(app.buttons["More Actions"].exists)
        XCTAssertTrue(app.buttons["Select"].exists)
        sheet.swipeUp()
        XCTAssertGreaterThan(sheet.frame.minY, app.frame.height * 0.3)
        capture("Scrollable actions in the compact native Threads sheet", app: app)
        tap(app.buttons["Select"], in: app)
        XCTAssertTrue(app.staticTexts["1 selected"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        app.terminate()

        app = launch("--preview-appearance")
        let restored = element("appearance-option-threads", in: app)
        XCTAssertTrue(restored.waitForExistence(timeout: 15))
        XCTAssertTrue(restored.isSelected)
        element("appearance-option-chat", in: app).tap()
        app.terminate()
    }

    func testThreadsReplyOpensDiscussionAndKeepsParentDraft() {
        let app = launch("--preview-native-design", "-kordi.messageLayout.v1", "threads")
        let editor = app.textViews["Message main"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        editor.tap()
        editor.typeText("Keep the draft after replying in a discussion.")
        // Return from details to dismiss the keyboard before targeting a row.
        // The floating toolbar can overlap a partially visible message.
        let title = element("conversation-title", in: app)
        title.tap()
        XCTAssertTrue(app.buttons["Members"].waitForExistence(timeout: 5))
        app.buttons["Back"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let parent = element("message-gm1", in: app)
        XCTAssertTrue(reveal(parent, in: app))
        parent.press(forDuration: 0.5)
        let reply = app.buttons["thread-action-reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        capture("Threads actions with a compact reaction strip and action list", app: app)
        reply.tap()
        XCTAssertTrue(element("thread-title", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(element("message-native-thread-3", in: app).exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("Keep the draft") == true)
        app.terminate()
    }

    func testThreadsForwardWaitsForActionSheetDismissal() {
        let app = launch("--preview-native-design", "--preview-contact-chat", "-kordi.messageLayout.v1", "threads")
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 15))
        let source = element("message-m5", in: app)
        XCTAssertTrue(reveal(source, in: app))
        source.press(forDuration: 0.5)
        let forward = app.buttons["thread-action-forward"]
        XCTAssertTrue(forward.waitForExistence(timeout: 5))
        forward.tap()
        XCTAssertTrue(app.textFields["forward-search"].waitForExistence(timeout: 5))
        XCTAssertFalse(element("thread-message-actions-sheet", in: app).exists)
        XCTAssertFalse(app.buttons["forward-submit"].isEnabled)
        app.terminate()
    }

    func testThreadsDeleteKeepsConfirmationAndNeighboringMessage() {
        let app = launch("--preview-contact-chat", "-kordi.messageLayout.v1", "threads")
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 15))
        let source = element("message-m5", in: app)
        XCTAssertTrue(reveal(source, in: app))
        source.press(forDuration: 0.5)
        let sheet = element("thread-message-actions-sheet", in: app)
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["More Actions"].exists)
        sheet.swipeUp()
        tap(app.buttons["Delete"], in: app)
        let confirm = app.buttons["Delete for me"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Back to message actions"].exists)
        confirm.tap()
        XCTAssertTrue(source.waitForNonExistence(timeout: 10))
        XCTAssertFalse(element("thread-message-actions-sheet", in: app).exists)
        XCTAssertTrue(reveal(element("message-m4-voice", in: app), in: app))
        XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
        app.terminate()
    }
}

@MainActor
final class NativeChromeUITests: ProviderUITestCase {
    func testConversationTitlesStayCenteredWithLongContext() {
        for flag in ["--preview-contact-chat", "--preview-native-agent"] {
            let app = launch("--preview-native-design", flag)
            let title = element("conversation-title", in: app)
            XCTAssertTrue(title.waitForExistence(timeout: 15))
            XCTAssertEqual(title.frame.midX, app.frame.midX, accuracy: 2)
            XCTAssertTrue(title.isHittable)
            XCTAssertTrue(element("conversation-details", in: app).isHittable)
            capture("Centered title with native background blur", app: app)
            app.terminate()
        }
    }

    func testFullAppKeepsDiscussionBackAndAccountNavigation() {
        let app = launch("--preview-native-samples", "--preview-expanded-groups", "-kordi.messageLayout.v1", "chat")
        let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "main")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 15))
        tap(group, in: app)
        let title = element("conversation-title", in: app)
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        XCTAssertTrue(app.buttons["Members"].waitForExistence(timeout: 5))
        app.buttons["Back"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))

        let parent = element("message-gm1", in: app)
        XCTAssertTrue(reveal(parent, in: app))
        parent.press(forDuration: 0.5)
        XCTAssertTrue(app.buttons["Open discussion"].waitForExistence(timeout: 5))
        app.buttons["Open discussion"].tap()
        XCTAssertTrue(element("thread-title", in: app).waitForExistence(timeout: 5))
        capture("Approved thread in the complete app navigation", app: app)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.tabBars.buttons["Account"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Account"].tap()
        XCTAssertTrue(element("settings-appearance", in: app).waitForExistence(timeout: 5))
        capture("Compact Settings in the complete app", app: app)
        app.terminate()
    }

    func testSettingsShowsAndPersistsInlinePreferences() {
        var app = launch("--preview-native-design", "--preview-account")
        XCTAssertTrue(element("settings-appearance", in: app).waitForExistence(timeout: 15))

        choose(["dark", "threads", "sand"], in: app)
        assertSelected(["dark", "threads", "sand"], in: app)
        closeAppearance(in: app)
        app.terminate()

        app = launch("--preview-native-design", "--preview-account")
        XCTAssertTrue(element("settings-appearance", in: app).waitForExistence(timeout: 15))
        openAppearance(in: app)
        assertSelected(["dark", "threads", "sand"], in: app)
        closeAppearance(in: app)
        choose(["system", "chat", "quiet"], in: app)
        closeAppearance(in: app)

        tap(element("settings-notifications", in: app), in: app)
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        for route in ["profile", "active-sessions", "authentication"] {
            XCTAssertTrue(reveal(element("settings-\(route)", in: app), in: app))
        }
        capture("Compact Settings with saved inline values", app: app)
        app.buttons["Close"].tap()
        XCTAssertTrue(app.buttons["Group conversation"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testTitleDetailsAndDiscussionBackPreserveDraft() {
        let app = launch("--preview-native-design", "-kordi.messageLayout.v1", "chat")
        let title = element("conversation-title", in: app)
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        let editor = app.textViews["Message main"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Keep this draft while reviewing the thread.")
        title.tap()
        capture("Conversation details opened from the glass title", app: app)
        XCTAssertTrue(app.buttons["Members"].waitForExistence(timeout: 5))
        app.buttons["Back"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("Keep this draft") == true)

        let parent = element("message-gm1", in: app)
        XCTAssertTrue(reveal(parent, in: app))
        parent.press(forDuration: 0.5)
        XCTAssertTrue(app.buttons["Open discussion"].waitForExistence(timeout: 5))
        app.buttons["Open discussion"].tap()
        let threadTitle = element("thread-title", in: app)
        XCTAssertTrue(threadTitle.waitForExistence(timeout: 5))
        XCTAssertTrue(threadTitle.label.contains("3 replies"))
        XCTAssertTrue(element("message-native-thread-1", in: app).exists)
        XCTAssertTrue(element("message-native-thread-3", in: app).exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("Keep this draft") == true)
        XCTAssertTrue(parent.isHittable)
        capture("Native discussion returns to the parent and keeps its draft", app: app)
        app.terminate()
    }

    func testAccessibilitySettingsKeepsValuesAndDestinationsReachable() {
        let app = launch("--preview-native-design", "--preview-account", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL")
        let row = element("settings-appearance", in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertTrue(reveal(row, in: app))
        XCTAssertGreaterThan(row.frame.height, 48)
        choose(["threads"], in: app)
        openAppearance(in: app)
        assertSelected(["threads"], in: app)
        closeAppearance(in: app)
        for route in ["profile", "notifications", "appearance", "active-sessions", "authentication"] {
            XCTAssertTrue(reveal(element("settings-\(route)", in: app), in: app))
        }
        choose(["chat"], in: app)
        closeAppearance(in: app)
        capture("Settings expands for accessibility text sizes", app: app)
        app.terminate()
    }

    /// Opens Appearance, selects each option, and stays on the screen.
    private func choose(_ options: [String], in app: XCUIApplication) {
        openAppearance(in: app)
        for option in options {
            let selection = element("appearance-option-\(option)", in: app)
            XCTAssertTrue(selection.waitForExistence(timeout: 5))
            tap(selection, in: app)
            XCTAssertTrue(selection.isSelected)
        }
    }

    private func assertSelected(_ options: [String], in app: XCUIApplication) {
        for option in options {
            let selection = element("appearance-option-\(option)", in: app)
            XCTAssertTrue(reveal(selection, in: app))
            XCTAssertTrue(selection.isSelected, "The saved preference should stay selected in Appearance.")
        }
    }

    private func openAppearance(in app: XCUIApplication) {
        if app.navigationBars["Appearance"].exists { return }
        tap(element("settings-appearance", in: app), in: app)
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 5))
    }

    private func closeAppearance(in app: XCUIApplication) {
        guard app.navigationBars["Appearance"].exists else { return }
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(element("settings-appearance", in: app).waitForExistence(timeout: 5))
    }
}
