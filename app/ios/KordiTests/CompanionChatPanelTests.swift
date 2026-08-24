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

    func testEmojiPickerWaitsForTheSoftwareKeyboardToFold() {
        XCTAssertEqual(
            ComposerInputSurfaceMotion.delayBeforePresentingPicker(
                keyboardIsFocused: true,
                reduceMotion: false
            ),
            ComposerInputSurfaceMotion.duration
        )
        XCTAssertEqual(
            ComposerInputSurfaceMotion.delayBeforePresentingPicker(
                keyboardIsFocused: false,
                reduceMotion: false
            ),
            .zero
        )
        XCTAssertEqual(
            ComposerInputSurfaceMotion.delayBeforePresentingPicker(
                keyboardIsFocused: true,
                reduceMotion: true
            ),
            .zero
        )
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

    func testUserTapClaimsComposerFocusSynchronously() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ComposerView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "func textViewDidBeginEditing"))
        let end = try XCTUnwrap(source.range(of: "func textViewDidEndEditing"))
        let handler = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(handler.contains("parent.isFocused = true"))
        XCTAssertFalse(handler.contains("DispatchQueue.main.async"))
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
}
