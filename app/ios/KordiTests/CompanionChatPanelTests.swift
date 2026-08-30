import XCTest
import SwiftUI
@testable import Kordi

final class CompanionChatPanelTests: XCTestCase {
    func testDemoPreviewModePersistsAcrossDebugRelaunches() throws {
        let suiteName = "KordiPreviewModePersistenceTests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertTrue(KordiPreviewModePersistence.resolve(
            arguments: ["--preview-data"],
            launchRequested: true,
            defaults: defaults
        ))
        XCTAssertTrue(KordiPreviewModePersistence.resolve(
            arguments: [],
            launchRequested: false,
            defaults: defaults
        ))
        XCTAssertFalse(KordiPreviewModePersistence.resolve(
            arguments: ["--disable-preview-data"],
            launchRequested: false,
            defaults: defaults
        ))
    }

    @MainActor
    func testPreviewLaunchFlowKeepsTheLoadingPhaseUntilStart() {
        let launching = AppModel(previewMode: true, previewLaunchFlow: true)
        let immediate = AppModel(previewMode: true, previewLaunchFlow: false)

        XCTAssertEqual(launching.phase, .launching)
        XCTAssertEqual(immediate.phase, .signedIn)
    }

    func testNewChatMenuRoutesEveryActionToItsNavigationDestination() {
        XCTAssertEqual(
            NewChatMode.allCases.map(\.menuTitle),
            ["Chat with contact", "Chat with agent", "Start group", "Add contacts"]
        )
        XCTAssertEqual(
            NewChatMode.allCases.map(\.systemImage),
            ["message.fill", "sparkles", "person.3.fill", "person.badge.plus"]
        )
        XCTAssertEqual(NewChatMode.previewMode(arguments: ["--preview-new-chat"]), .contact)
        XCTAssertEqual(NewChatMode.previewMode(arguments: ["--preview-new-group"]), .group)
        XCTAssertEqual(NewChatMode.previewMode(arguments: ["--preview-add-contact"]), .addContact)
    }

    func testReplyPreviewKeepsItsRailBoundedAndCancelTargetAccessible() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "    private func replyPreview"))
        let end = try XCTUnwrap(source.range(of: "    private var attachmentTray"))
        let preview = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(preview.contains(".frame(width: 3, height: 32)"))
        XCTAssertTrue(preview.contains(".frame(width: 44, height: 44)"))
    }

    func testDraftPaneButtonAppearsAfterTheInlineComposerGrows() {
        XCTAssertFalse(ComposerDraftPaneLayout.showsExpandButton(
            editorHeight: 83,
            threshold: 84
        ))
        XCTAssertTrue(ComposerDraftPaneLayout.showsExpandButton(
            editorHeight: 84,
            threshold: 84
        ))
    }

    func testComposerTextViewHeightGrowsAndCapsAtSixLines() {
        XCTAssertEqual(ComposerTextViewLayout.height(
            fittingHeight: 20,
            lineHeight: 20,
            insets: 22
        ), 44)
        XCTAssertEqual(ComposerTextViewLayout.height(
            fittingHeight: 90,
            lineHeight: 20,
            insets: 22
        ), 90)
        XCTAssertEqual(ComposerTextViewLayout.height(
            fittingHeight: 300,
            lineHeight: 20,
            insets: 22
        ), 142)
    }

    func testMessageFieldSurfaceOwnsTheEditorHeight() {
        XCTAssertEqual(ComposerMessageFieldLayout.surfaceHeight(
            editorHeight: 44,
            controlHeight: 50,
            verticalPadding: 3
        ), 50)
        XCTAssertEqual(ComposerMessageFieldLayout.surfaceHeight(
            editorHeight: 100,
            controlHeight: 50,
            verticalPadding: 3
        ), 106)
    }

    func testAnimatedMessageFieldKeepsControlsBottomAnchored() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private var messageFieldContent"))
        let end = try XCTUnwrap(source.range(
            of: "private var messageEditor",
            range: start.upperBound..<source.endIndex
        ))
        let field = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(field.contains(".frame(height: messageFieldHeight, alignment: .bottom)"))
        XCTAssertTrue(field.contains(".transaction { $0.disablesAnimations = true }"))
    }

    func testComposerTextOnlyAvoidsTheVisibleControls() {
        XCTAssertEqual(
            ComposerTextExclusionLayout.rects(
                containerWidth: 280,
                contentHeight: 110,
                showsDraftButton: true
            ),
            [
                CGRect(x: 192, y: 66, width: 88, height: 44),
                CGRect(x: 236, y: 0, width: 44, height: 44)
            ]
        )
    }

    func testComposerEmojiHeightDoesNotOscillate() {
        let textView = UITextView(frame: CGRect(x: 0, y: 0, width: 230, height: 44))
        textView.font = .preferredFont(forTextStyle: .body)
        textView.textContainerInset = UIEdgeInsets(top: 11, left: 5, bottom: 11, right: 5)
        textView.textContainer.lineFragmentPadding = 0
        var measuredHeight: CGFloat = 44

        for count in 1...50 {
            textView.text = String(repeating: "😊", count: count)
            let previousHeight = measuredHeight
            measuredHeight = ComposerTextViewLayout.stableHeight(minimumHeight: 44) { candidate in
                let insets = textView.textContainerInset
                let containerWidth = textView.bounds.width - insets.left - insets.right
                let contentHeight = candidate - insets.top - insets.bottom
                textView.textContainer.exclusionPaths = ComposerTextExclusionLayout.rects(
                    containerWidth: containerWidth,
                    contentHeight: contentHeight,
                    showsDraftButton: candidate >= 84
                ).map { UIBezierPath(rect: $0) }
                let fittingHeight = textView.sizeThatFits(
                    CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
                ).height
                return ComposerTextViewLayout.height(
                    fittingHeight: fittingHeight,
                    lineHeight: textView.font?.lineHeight ?? 0,
                    insets: insets.top + insets.bottom
                )
            }
            XCTAssertGreaterThanOrEqual(measuredHeight, previousHeight)
        }
    }

    func testExpressivePickerMatchesTheVisibleKeyboardContentHeight() {
        XCTAssertEqual(
            ComposerKeyboardSurfaceLayout.contentHeight(
                keyboardFrame: CGRect(x: 0, y: 500, width: 390, height: 344),
                windowBounds: CGRect(x: 0, y: 0, width: 390, height: 844),
                bottomSafeAreaInset: 34
            ),
            310
        )
        XCTAssertNil(ComposerKeyboardSurfaceLayout.contentHeight(
            keyboardFrame: CGRect(x: 0, y: 844, width: 390, height: 344),
            windowBounds: CGRect(x: 0, y: 0, width: 390, height: 844),
            bottomSafeAreaInset: 34
        ))
        XCTAssertEqual(ComposerKeyboardSurfaceLayout.fallbackHeight(verticalSizeClass: .compact), 226)
        XCTAssertEqual(ComposerKeyboardSurfaceLayout.fallbackHeight(verticalSizeClass: .regular), 300)
    }

    func testExpressivePickerDoesNotOwnASecondLayoutAnimation() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertFalse(source.contains(".transition(expressivePickerTransition)"))
        XCTAssertFalse(source.contains(".animation(inputSurfaceAnimation, value: isExpressivePickerPresented)"))
    }

    func testExpressivePickerDoesNotDragTheNativeInputSurface() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ExpressiveMediaPicker.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertFalse(source.contains(".scrollDismissesKeyboard(.interactively)"))
        XCTAssertTrue(source.contains(".scrollDismissesKeyboard(.never)"))
    }

    func testKeyboardHostedPickerRoutesMediaImportThroughTheConversationPhotoPicker() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains("onRequestImport: parent.onRequestExpressiveMediaImport"))
        XCTAssertTrue(source.contains("isPresented: $isShowingExpressiveMediaPhotoPicker"))
        XCTAssertTrue(source.contains("preferredItemEncoding: .current"))
        XCTAssertFalse(source.contains("isShowingExpressiveMediaImporter"))
    }

    func testExpressiveLibraryAddUsesPhotosInsteadOfFiles() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ExpressiveMediaPicker.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains(".photosPicker("))
        XCTAssertTrue(source.contains("preferredItemEncoding: .current"))
        XCTAssertFalse(source.contains(".fileImporter("))
    }

    func testExpressiveMediaLibraryUsesAdaptiveRowsAndFixedThumbnails() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ExpressiveMediaPicker.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let panelStart = try XCTUnwrap(source.range(of: "private struct ExpressiveMediaLibraryPanel"))
        let thumbnailStart = try XCTUnwrap(source.range(of: "private struct LocalExpressiveMediaThumbnail"))
        let panel = source[panelStart.lowerBound..<thumbnailStart.lowerBound]
        let thumbnail = source[thumbnailStart.lowerBound...]

        XCTAssertTrue(panel.contains("LazyVGrid("))
        XCTAssertTrue(panel.contains("GridItem(.adaptive(minimum: 64, maximum: 64), spacing: 8)"))
        XCTAssertFalse(panel.contains("ScrollView(.horizontal"))
        XCTAssertTrue(thumbnail.contains(".scaledToFit()"))
        XCTAssertTrue(thumbnail.contains(".frame(width: 64, height: 64)"))
        XCTAssertTrue(thumbnail.contains(".clipped()"))
    }

    func testSavedMediaUsesTheNativeLongPressDeleteMenu() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ExpressiveMediaPicker.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains(".contextMenu {"))
        XCTAssertTrue(source.contains("Label(\"Delete\", systemImage: \"trash\")"))
        XCTAssertTrue(source.contains(".accessibilityAction(named: \"Delete"))
        XCTAssertTrue(source.contains("model.removeExpressiveMedia(entry)"))
    }

    func testConversationRowsRenderTheLatestStickerPreview() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Chats/ConversationRow.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains("conversation.lastAttachment"))
        XCTAssertTrue(source.contains("conversation.previewText"))
        XCTAssertTrue(source.contains("ConversationAttachmentThumbnail"))
        XCTAssertTrue(source.contains(".scaledToFit()"))
    }

    func testStaleEndEditingCallbackCannotCancelRestoredKeyboardFocus() {
        XCTAssertFalse(ComposerFocusReconciliation.shouldApply(
            focused: false,
            textViewIsFirstResponder: true,
            currentFocus: true
        ))
        XCTAssertTrue(ComposerFocusReconciliation.shouldApply(
            focused: false,
            textViewIsFirstResponder: false,
            currentFocus: true
        ))
    }

    func testUserTapClaimsKeyboardFocusSynchronously() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "func textViewDidBeginEditing"))
        let end = try XCTUnwrap(source.range(of: "func textViewDidEndEditing"))
        let handler = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(handler.contains("parent.isFocused = true"))
        XCTAssertTrue(handler.contains("if !parent.isFocused"))
        XCTAssertFalse(handler.contains("DispatchQueue.main.async"))
    }

    func testKeyboardButtonRequestsUIKitFocusAfterPickerRemoval() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private func showKeyboard()"))
        let end = try XCTUnwrap(source.range(of: "private var inputSurfaceAnimation"))
        let handler = source[start.lowerBound..<end.lowerBound]
        let dismissal = try XCTUnwrap(handler.range(of: "dismissExpressivePicker()"))
        let focusState = try XCTUnwrap(handler.range(of: "isFocused = true"))
        let focusRequest = try XCTUnwrap(handler.range(of: "keyboardFocusRequest &+= 1"))

        XCTAssertLessThan(dismissal.lowerBound, focusState.lowerBound)
        XCTAssertLessThan(focusState.lowerBound, focusRequest.lowerBound)
    }

    func testOpeningExpressivePickerKeepsItsNativeInputViewFocused() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private var messageEditor"))
        let end = try XCTUnwrap(source.range(
            of: "private var messageFieldAnimation",
            range: start.upperBound..<source.endIndex
        ))
        let editor = source[start.lowerBound..<end.lowerBound]

        XCTAssertFalse(editor.contains("dismissExpressivePicker()"))
        XCTAssertTrue(editor.contains("if isFocused, !isExpressivePickerPresented"))
    }

    func testUIKitFocusRequestActivatesTheActualEditor() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "func updateUIView"))
        let end = try XCTUnwrap(source.range(of: "private func updateHeight"))
        let update = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(update.contains("lastHandledKeyboardFocusRequest != keyboardFocusRequest"))
        XCTAssertTrue(update.contains("DispatchQueue.main.async"))
        XCTAssertTrue(update.contains("textView.becomeFirstResponder()"))
    }

    @MainActor
    func testUIKitEditorKeepsFocusAfterTheFirstTextUpdate() async throws {
        let controller = UIHostingController(
            rootView: ComposerTextViewFocusHarness(appModel: AppModel(previewMode: true))
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))

        let textView = try XCTUnwrap(firstTextView(in: controller.view))
        XCTAssertTrue(textView.isFirstResponder)

        textView.text = "V"
        textView.delegate?.textViewDidChange?(textView)
        try await Task.sleep(for: .milliseconds(50))
        controller.view.layoutIfNeeded()

        XCTAssertEqual(textView.text, "V")
        XCTAssertTrue(textView.isFirstResponder)
        window.isHidden = true
    }

    func testUnchangedBindingNeverOverwritesNewKeyboardText() {
        XCTAssertFalse(ComposerTextReconciliation.shouldApplyBindingText(
            bindingChanged: false,
            bindingMatchesLatestEditorText: false,
            hasMarkedText: false,
            isComposingText: false
        ))
        XCTAssertFalse(ComposerTextReconciliation.shouldApplyBindingText(
            bindingChanged: true,
            bindingMatchesLatestEditorText: true,
            hasMarkedText: false,
            isComposingText: false
        ))
        XCTAssertFalse(ComposerTextReconciliation.shouldApplyBindingText(
            bindingChanged: true,
            bindingMatchesLatestEditorText: false,
            hasMarkedText: true,
            isComposingText: true
        ))
        XCTAssertTrue(ComposerTextReconciliation.shouldApplyBindingText(
            bindingChanged: true,
            bindingMatchesLatestEditorText: false,
            hasMarkedText: false,
            isComposingText: false
        ))
    }

    @MainActor
    func testUIKitEditorCommitsTextBeforeAnUnrelatedViewRefresh() async throws {
        let model = ComposerTextViewInputSurfaceModel()
        model.isExpressivePickerPresented = false
        let controller = UIHostingController(
            rootView: ComposerTextViewInputSurfaceHarness(
                model: model,
                appModel: AppModel(previewMode: true)
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))

        let textView = try XCTUnwrap(firstTextView(in: controller.view))
        textView.text = "This draft must survive"
        textView.selectedRange = NSRange(location: textView.text.utf16.count, length: 0)
        textView.delegate?.textViewDidChange?(textView)

        XCTAssertEqual(model.text, "This draft must survive")
        model.objectWillChange.send()
        controller.view.layoutIfNeeded()
        XCTAssertEqual(textView.text, "This draft must survive")
        window.isHidden = true
    }

    @MainActor
    func testUIKitEditorKeepsASelectedKeyboardCandidate() async throws {
        let model = ComposerTextViewInputSurfaceModel()
        model.isExpressivePickerPresented = false
        let controller = UIHostingController(
            rootView: ComposerTextViewInputSurfaceHarness(
                model: model,
                appModel: AppModel(previewMode: true)
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))

        let textView = try XCTUnwrap(firstTextView(in: controller.view))
        textView.setMarkedText("pin", selectedRange: NSRange(location: 3, length: 0))
        textView.delegate?.textViewDidChange?(textView)
        XCTAssertEqual(model.text, "")

        textView.setMarkedText("candidate", selectedRange: NSRange(location: 9, length: 0))
        textView.unmarkText()
        textView.delegate?.textViewDidChangeSelection?(textView)
        XCTAssertEqual(model.text, "candidate")

        model.objectWillChange.send()
        controller.view.layoutIfNeeded()
        XCTAssertEqual(textView.text, "candidate")
        window.isHidden = true
    }

    @MainActor
    func testNativeKeyboardDismissalCompletesBeforeSwiftUIFocusReconciles() async throws {
        let model = ComposerTextViewInputSurfaceModel()
        model.isExpressivePickerPresented = false
        let controller = UIHostingController(
            rootView: ComposerTextViewInputSurfaceHarness(
                model: model,
                appModel: AppModel(previewMode: true)
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))

        let textView = try XCTUnwrap(firstTextView(in: controller.view))
        XCTAssertTrue(textView.isFirstResponder)

        textView.resignFirstResponder()
        controller.view.layoutIfNeeded()

        XCTAssertFalse(textView.isFirstResponder)
        XCTAssertTrue(model.isFocused)

        try await Task.sleep(for: .milliseconds(50))
        controller.view.layoutIfNeeded()

        XCTAssertFalse(model.isFocused)
        XCTAssertFalse(textView.isFirstResponder)
        window.isHidden = true
    }

    @MainActor
    func testExpressivePickerReplacesKeyboardThroughNativeInputView() async throws {
        let model = ComposerTextViewInputSurfaceModel()
        let controller = UIHostingController(
            rootView: ComposerTextViewInputSurfaceHarness(
                model: model,
                appModel: AppModel(previewMode: true)
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))

        let textView = try XCTUnwrap(firstTextView(in: controller.view))
        XCTAssertTrue(textView.isFirstResponder)
        XCTAssertTrue(textView.inputView is ComposerExpressiveInputView)

        model.isExpressivePickerPresented = false
        try await Task.sleep(for: .milliseconds(50))
        controller.view.layoutIfNeeded()

        XCTAssertNil(textView.inputView)
        XCTAssertTrue(textView.isFirstResponder)

        model.isFocused = false
        try await Task.sleep(for: .milliseconds(50))
        controller.view.layoutIfNeeded()

        XCTAssertFalse(textView.isFirstResponder)
        window.isHidden = true
    }

    @MainActor
    func testHostedExpressivePickerOpensMediaLibraryWithExplicitModel() async throws {
        let controller = UIHostingController(
            rootView: ExpressiveMediaPicker(
                model: AppModel(previewMode: true),
                height: 300,
                isSending: false,
                onInsertEmoji: { _ in },
                onSendMedia: { _ in },
                allowsSearch: false
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 300))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))

        let tabPicker = try XCTUnwrap(firstSegmentedControl(in: controller.view))
        XCTAssertEqual(tabPicker.numberOfSegments, 3)

        tabPicker.selectedSegmentIndex = 1
        tabPicker.sendActions(for: .valueChanged)
        try await Task.sleep(for: .milliseconds(100))
        controller.view.layoutIfNeeded()

        XCTAssertEqual(tabPicker.selectedSegmentIndex, 1)
        window.isHidden = true
    }

    func testMentionPickerGrowsWithResultsUntilItsMaximumHeight() {
        XCTAssertEqual(
            ComposerMentionPickerLayout.height(
                targetCount: 3,
                rowHeight: 46,
                chromeHeight: 36,
                maximumHeight: 264
            ),
            174
        )
        XCTAssertEqual(
            ComposerMentionPickerLayout.height(
                targetCount: 20,
                rowHeight: 46,
                chromeHeight: 36,
                maximumHeight: 264
            ),
            264
        )
    }

    func testEmojiInsertionUsesTheCurrentUTF16Caret() {
        let replacement = replacingComposerText(
            "Hi world",
            selection: ComposerTextSelection(location: 3, length: 0),
            with: "👋"
        )

        XCTAssertEqual(replacement.text, "Hi 👋world")
        XCTAssertEqual(replacement.selection, ComposerTextSelection(location: 5, length: 0))
    }

    func testEmojiInsertionReplacesTheSelectedText() {
        let replacement = replacingComposerText(
            "Ship later",
            selection: ComposerTextSelection(location: 5, length: 5),
            with: "🚀"
        )

        XCTAssertEqual(replacement.text, "Ship 🚀")
        XCTAssertEqual(replacement.selection, ComposerTextSelection(location: 7, length: 0))
    }

    func testEmojiInsertionClampsAStaleSelectionAfterTextIsCleared() {
        let replacement = replacingComposerText(
            "",
            selection: ComposerTextSelection(location: 20, length: 4),
            with: "✨"
        )

        XCTAssertEqual(replacement.text, "✨")
        XCTAssertEqual(replacement.selection, ComposerTextSelection(location: 1, length: 0))
    }

    func testContactChatSuggestsTheMostRecentAgentSession() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let olderAgent = conversation(
            id: "older-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 10)
        )
        let newerAgent = conversation(
            id: "newer-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 20)
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source, olderAgent, newerAgent],
            ownAccountID: "acct_me"
        )

        XCTAssertEqual(suggestion?.id, newerAgent.id)
    }

    func testAgentChatStartsAFreshSessionForTheSameAgent() {
        let source = conversation(
            id: "active-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 20)
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source],
            ownAccountID: "acct_me",
            randomID: "companion-test",
            now: Date(timeIntervalSince1970: 40)
        )

        XCTAssertEqual(suggestion?.id, "agent-session:session:self-agent:companion-test")
        XCTAssertEqual(suggestion?.agentId, source.agentId)
        XCTAssertNotEqual(suggestion?.sessionId, source.sessionId)
    }

    func testContactChatStartsAFreshSessionWhenOnlyAnAgentTemplateExists() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let template = ConversationSummary(
            id: "agent-template:session:self-agent:default",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "My Kordi",
            lastMessage: "Your private cloud agent",
            lastActivityAt: Date(timeIntervalSince1970: 20),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:self-agent:default",
            agentDisplayName: "My Kordi"
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source, template],
            ownAccountID: "acct_me",
            randomID: "empty-state",
            now: Date(timeIntervalSince1970: 40)
        )
        let existing = CompanionPanelCatalog.existingSessions(
            excluding: source,
            conversations: [source, template],
            ownAccountID: "acct_me"
        )

        XCTAssertEqual(suggestion?.id, "agent-session:session:self-agent:empty-state")
        XCTAssertEqual(suggestion?.displayName, "My Kordi")
        XCTAssertEqual(existing, [])
    }

    func testContactChatStartsDefaultAgentSessionWithoutExistingAgentData() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )

        let suggestion = CompanionPanelCatalog.suggestedConversation(
            for: source,
            conversations: [source],
            ownAccountID: "acct_me",
            randomID: "provider-only",
            now: Date(timeIntervalSince1970: 40)
        )

        XCTAssertEqual(suggestion?.id, "agent-session:session:self-agent:provider-only")
        XCTAssertEqual(suggestion?.displayName, "My Kordi")
        XCTAssertEqual(suggestion?.peerAccountId, "acct_me")
    }

    func testExistingSessionMenuExcludesTheSourceAndOrdersByRecentActivity() {
        let source = conversation(
            id: "source",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let olderAgent = conversation(
            id: "older-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 10)
        )
        let newerAgent = conversation(
            id: "newer-agent",
            kind: .agent,
            date: Date(timeIntervalSince1970: 20)
        )

        let sessions = CompanionPanelCatalog.existingSessions(
            excluding: source,
            conversations: [source, olderAgent, newerAgent],
            ownAccountID: "acct_me"
        )

        XCTAssertEqual(sessions.map(\.id), [newerAgent.id, olderAgent.id])
    }

    func testExistingSessionMenuExcludesEmptyCanonicalAgentPlaceholder() {
        let source = conversation(
            id: "source",
            kind: .person,
            date: Date(timeIntervalSince1970: 30)
        )
        let placeholder = ConversationSummary(
            id: "agent-session:session:self-agent:empty",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "My Kordi",
            lastMessage: "No messages yet",
            lastActivityAt: Date(timeIntervalSince1970: 20),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:self-agent:empty",
            agentDisplayName: "My Kordi",
            messageCount: 0
        )

        XCTAssertEqual(
            CompanionPanelCatalog.existingSessions(
                excluding: source,
                conversations: [source, placeholder],
                ownAccountID: "acct_me"
            ),
            []
        )
    }

    func testContextIncludesOnlyTheSixMostRecentReferenceLines() {
        let source = conversation(
            id: "contact",
            kind: .person,
            date: Date(timeIntervalSince1970: 20)
        )
        let messages = (1...7).map { index in
            message(
                id: "message-\(index)",
                text: index == 7 ? String(repeating: "a", count: 260) : "Message \(index)",
                author: index.isMultiple(of: 2) ? .me : .person
            )
        }

        let context = CompanionChatContextBuilder.make(
            source: source,
            messages: messages,
            selfName: "Alex"
        )

        XCTAssertTrue(context.referenceText.contains("Reference: Current chat"))
        XCTAssertTrue(context.referenceText.contains("Session id: session:contact"))
        XCTAssertTrue(context.referenceText.contains("Participants: Alex, Contact"))
        XCTAssertFalse(context.referenceText.contains("Message 1"))
        XCTAssertTrue(context.referenceText.contains("Message 2"))
        XCTAssertTrue(context.referenceText.contains(String(repeating: "a", count: 239) + "…"))
    }

    func testAgentPromptCompositionDoesNotChangeTheVisibleRequestText() {
        let request = "Summarize the decisions"
        let context = "Reference: Current chat\nSession: Maya Chen"

        XCTAssertEqual(
            AgentPromptContext.compose(userText: request, referenceText: context),
            "\(context)\n\nRequest:\n\(request)"
        )
        XCTAssertEqual(
            AgentPromptContext.compose(userText: request, referenceText: nil),
            request
        )
    }

    private func conversation(
        id: String,
        kind: ConversationKind,
        date: Date
    ) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: kind,
            peerAccountId: kind == .agent ? "acct_me" : "acct_contact",
            agentId: kind == .agent ? "agent_research" : nil,
            ownerDisplayName: kind == .agent ? "Alex" : "Contact",
            displayName: kind == .agent ? "Research session" : "Contact",
            lastMessage: "Latest message",
            lastActivityAt: date,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: kind == .agent ? .ready : nil,
            sessionId: "session:\(id)",
            agentDisplayName: kind == .agent ? "Research Agent" : nil
        )
    }

    private func message(
        id: String,
        text: String,
        author: MessageAuthor
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: "contact",
            author: author,
            authorName: author == .me ? "You" : "Contact",
            text: text,
            createdAt: Date(),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil
        )
    }

    @MainActor
    private func firstTextView(in view: UIView) -> UITextView? {
        if let textView = view as? UITextView {
            return textView
        }
        return view.subviews.lazy.compactMap(firstTextView(in:)).first
    }

    @MainActor
    private func firstSegmentedControl(in view: UIView) -> UISegmentedControl? {
        if let segmentedControl = view as? UISegmentedControl {
            return segmentedControl
        }
        return view.subviews.lazy.compactMap(firstSegmentedControl(in:)).first
    }
}

private struct ComposerTextViewFocusHarness: View {
    let appModel: AppModel
    @State private var text = ""
    @State private var selection = ComposerTextSelection(location: 0, length: 0)
    @State private var isFocused = true
    @State private var isExpressivePickerPresented = false
    @State private var measuredHeight: CGFloat = 44

    var body: some View {
        ComposerTextView(
            model: appModel,
            text: $text,
            selection: $selection,
            isFocused: $isFocused,
            isExpressivePickerPresented: $isExpressivePickerPresented,
            keyboardFocusRequest: 1,
            expressivePickerHeight: 300,
            isSending: false,
            onInsertEmoji: { _ in },
            onSendExpressiveMedia: { _ in },
            onRequestExpressiveMediaImport: { _ in },
            measuredHeight: $measuredHeight,
            draftButtonThreshold: 84,
            accessibilityLabel: "Message"
        )
        .frame(height: measuredHeight)
    }
}

@MainActor
private final class ComposerTextViewInputSurfaceModel: ObservableObject {
    @Published var isExpressivePickerPresented = true
    @Published var isFocused = true
    @Published var text = ""
}

private struct ComposerTextViewInputSurfaceHarness: View {
    @ObservedObject var model: ComposerTextViewInputSurfaceModel
    let appModel: AppModel
    @State private var selection = ComposerTextSelection(location: 0, length: 0)
    @State private var measuredHeight: CGFloat = 44

    var body: some View {
        ComposerTextView(
            model: appModel,
            text: $model.text,
            selection: $selection,
            isFocused: $model.isFocused,
            isExpressivePickerPresented: $model.isExpressivePickerPresented,
            keyboardFocusRequest: 1,
            expressivePickerHeight: 300,
            isSending: false,
            onInsertEmoji: { _ in },
            onSendExpressiveMedia: { _ in },
            onRequestExpressiveMediaImport: { _ in },
            measuredHeight: $measuredHeight,
            draftButtonThreshold: 84,
            accessibilityLabel: "Message"
        )
        .frame(height: measuredHeight)
    }
}
