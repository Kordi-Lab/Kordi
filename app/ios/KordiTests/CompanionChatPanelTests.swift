import XCTest
import SwiftUI
import Testing
@testable import Kordi

struct ConversationBoundaryTests {
@Test func threadReferencesResolveToTheSameKnownCloudMessage() throws {
    let wireId = "10000000-0000-4000-8000-000000000001"
    var root = ChatMessage(id:"group-payload",clientMessageId:"client-root",conversationId:"parent",conversationSequence:30,
        author:.agent,authorName:"Researcher",text:"Result",createdAt:.now,deliveryState:.delivered,errorMessage:nil,requestMessageId:nil)
    root.reactionTargetMessageId = wireId
    func reply(_ id: String, reference: String) -> ChatMessage {
        var row = ChatMessage(id:id,conversationId:"parent",conversationSequence:31,author:.person,authorName:"Peer",text:"Follow",
            createdAt:.now,deliveryState:.delivered,errorMessage:nil,requestMessageId:nil)
        row.messageAction = .thread(MessageActionSource(sourceSessionId:"parent",sourceMessageId:reference,senderLabel:"Researcher",textPreview:"Result",attachmentCount:0))
        return row
    }
    let projection = MessageThreadProjection(messages:[root,reply("one",reference:wireId),reply("two",reference:"collaboration-message:other-viewer:\(wireId)"),reply("three",reference:"client-root")])
    #expect(projection.mainMessages.map(\.id) == [root.id])
    #expect(projection.replyCount(rootID:root.id) == 3)
    #expect(projection.thread(rootID:wireId)?.root.id == root.id)
    #expect(projection.thread(rootID:"collaboration-message:other-viewer:\(wireId)")?.replies.count == 3)
    #expect(projection.thread(rootID:root.id)?.hasUnread(cursors:[wireId:30]) == true)
    #expect(projection.thread(rootID:root.id)?.hasUnread(cursors:[wireId:31]) == false)
    let unknown = MessageThreadProjection(messages:[root,reply("unknown",reference:"collaboration-message:elsewhere:20000000-0000-4000-8000-000000000002")])
    #expect(unknown.replyCount(rootID:root.id) == 0)
}

@Test @MainActor func hydrationAndBackfillKeepCloudOrderInsteadOfRequestAnchoredTime() {
    func row(_ id: String, sequence: Int64?, time: Double, author: MessageAuthor) -> ChatMessage {
        ChatMessage(id:id,conversationId:"parent",conversationSequence:sequence,author:author,authorName:"Participant",text:id,
            createdAt:Date(timeIntervalSince1970:time),deliveryState:sequence == nil ? .sending : .delivered,errorMessage:nil,requestMessageId:nil)
    }
    let rows = [row("A-request",sequence:28,time:1,author:.me),row("B-request",sequence:29,time:2,author:.me),
        row("B-answer",sequence:30,time:2.001,author:.agent),row("A-answer",sequence:31,time:1.001,author:.agent)]
    let pending = row("pending",sequence:nil,time:0,author:.me)
    let expected = ["A-request","B-request","B-answer","A-answer","pending"]
    #expect(AppModel.mergeProjectedMessages(rows,preservingLocalMessagesFrom:[pending]).map(\.id) == expected)
    #expect(AppModel.mergePartialProjection(Array(rows.suffix(2)),preserving:Array(rows.prefix(2))+[pending]).map(\.id) == expected)
}

@Test func threadReadCursorsRemainIndependentAndMonotonicAcrossDevices() throws {
    let key = "10000000-0000-4000-8000-000000000001"
    let data = try JSONSerialization.data(withJSONObject: ["root_message_id":key,"root_client_message_id":"client-root","last_read_sequence":2])
    let read = try JSONDecoder().decode(CloudThreadRead.self, from:data)
    let root = ChatMessage(id:key,conversationId:"parent",author:.agent,authorName:"Researcher",text:"Root",createdAt:.now,deliveryState:.delivered,errorMessage:nil,requestMessageId:nil)
    let reply = ChatMessage(id:"reply",conversationId:"parent",conversationSequence:2,author:.person,authorName:"Peer",text:"Reply",createdAt:.now,deliveryState:.delivered,errorMessage:nil,requestMessageId:nil)
    let thread = MessageThread(root:root,replies:[reply])
    #expect(thread.hasUnread(cursors:[:]))
    var cursors = CloudThreadRead.merging([read],into:[:])
    #expect(!thread.hasUnread(cursors:cursors))
    cursors = CloudThreadRead.merging([CloudThreadRead(rootMessageId:key,rootClientMessageId:"client-root",lastReadSequence:1)],into:cursors)
    #expect(cursors[key] == 2)
    let own = ChatMessage(id:"own",conversationId:"parent",conversationSequence:3,author:.me,authorName:"You",text:"Own reply",createdAt:.now,deliveryState:.delivered,errorMessage:nil,requestMessageId:nil)
    #expect(!MessageThread(root:root,replies:[reply,own]).hasUnread(cursors:cursors))
    let answer = ChatMessage(id:"agent",conversationId:"parent",conversationSequence:4,author:.agent,authorName:"Researcher",text:"New result",createdAt:.now,deliveryState:.delivered,errorMessage:nil,requestMessageId:nil)
    #expect(MessageThread(root:root,replies:[reply,own,answer]).hasUnread(cursors:cursors))
}

@Test func sharedTaskInstructionsUseAgentIdentityWithoutBecomingLiveAnswers() throws {
    let data = try JSONSerialization.data(withJSONObject: [
        "sessionId": "child", "parentSessionId": "parent", "parentRequestId": "root",
        "ownerAccountId": "owner", "agentId": "agent-one", "ownerDisplayName": "Owner",
        "agentDisplayName": "Researcher", "title": "Research", "status": "running", "version": 1,
        "updatedAt": "", "messages": [
            ["id": "brief", "role": "user", "senderAgentId": "agent-one", "text": "Compare sources", "timestampMs": 1],
            ["id": "human", "role": "user", "senderAccountId": "peer", "senderDisplayName": "Peer", "text": "Follow", "timestampMs": 2, "requestState": "queued"],
        ],
    ])
    var snapshot = try JSONDecoder().decode(CloudAgentSubsession.self, from: data)
    for account in ["owner", "peer"] {
        let rows = snapshot.chatMessages(accountId: account)
        #expect(rows.map(\.id) == ["brief", "runtime:child", "human"])
        #expect(rows[0].author == .agent)
        #expect(rows[0].authorName == "Researcher")
        #expect(rows[0].senderOwnerName == (account == "owner" ? "You" : "Owner"))
        #expect(rows[0].agentExecution == nil)
        #expect(rows[1].agentExecution?.completed == false)
        #expect(rows[2].author == (account == "peer" ? .me : .person))
        #expect(rows[2].agentQueuePosition == 1)
    }
    snapshot.messages.append(.init(id: "answer", role: "assistant", text: "Sources found", timestampMs: 3))
    #expect(snapshot.chatMessages(accountId: "peer").last?.agentExecution?.completed == false)
    snapshot.messages[0].senderAgentId = "unrelated-agent"
    #expect(snapshot.chatMessages(accountId: "peer").first?.author == .person)
}

@Test func askAgentPushesAChatPageInsteadOfResizingTheMainConversation() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let main = try String(contentsOf: root.appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift"), encoding: .utf8)
    let page = try String(contentsOf: root.appendingPathComponent("Kordi/Features/Conversation/CompanionChatPanel.swift"), encoding: .utf8)
    #expect(main.contains(".navigationDestination(isPresented: $showsCompanionPanel)"))
    #expect(!main.contains(".inspector(isPresented: $showsCompanionPanel)"))
    #expect(main.contains("if !showsCompanionPanel {"))
    #expect(main.contains("showsNavigationChrome ? .visible : .automatic"))
    #expect(page.contains("Back to conversation"))
    #expect(page.contains("Only you · Agent session"))
    #expect(!page.contains(".presentationDetents") && !page.contains(".inspectorColumnWidth"))
}

@Test func taskClockStopsOnCompletionAndDoesNotUseConversationAge() throws {
    let data = try JSONSerialization.data(withJSONObject: [
        "sessionId":"child", "parentSessionId":"parent", "parentRequestId":"request",
        "ownerAccountId":"owner", "agentId":"agent-one", "ownerDisplayName":"Owner", "agentDisplayName":"Researcher",
        "title":"Research", "status":"done", "executionBackend":"desktop", "startedAtMs":1000,
        "finishedAtMs":64000, "heartbeatAtMs":64000, "live":false, "queued":false,
    ])
    let task = try JSONDecoder().decode(CloudAgentSubsessionTask.self, from: data)
    #expect(task.statusLabel == "Done")
    #expect(task.elapsedLabel(at: Date(timeIntervalSince1970: 100000)) == "1m 3s")
    #expect(task.elapsedLabel(at: Date(timeIntervalSince1970: 200000)) == "1m 3s")
}

@Test func avatarsAndIdentityBoundMentions() throws {
    try subsessionIsAConversationWithIdentityBoundMentionsAndSharedQueue()
}

@Test func askAgentNeverSelectsAnotherOwnersAgentOrASharedSubsession() {
    func session(_ owner: String, child: String? = nil) -> ConversationSummary {
        ConversationSummary(id: "session-\(owner)-\(child ?? "private")", kind: .agent,
            peerAccountId: owner, agentId: "cloud-agent:\(owner)", ownerDisplayName: "Owner",
            displayName: "Research", lastMessage: "", lastActivityAt: .now, unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "session-\(owner)", subsessionId: child)
    }
    let own = session("owner")
    let shared = session("owner", child: "child")
    let external = session("peer")
    #expect(CompanionPanelCatalog.isPrivateOwnedSession(own, ownAccountID: "owner"))
    #expect(!CompanionPanelCatalog.isPrivateOwnedSession(shared, ownAccountID: "owner"))
    #expect(!CompanionPanelCatalog.isPrivateOwnedSession(external, ownAccountID: "owner"))
    #expect(CompanionPanelCatalog.existingSessions(excluding: external,
        conversations: [own, shared, external], ownAccountID: "owner").map(\.id) == [own.id])
}
}

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

    @MainActor
    func testPreviewSendSettlesLocallyWithoutRetry() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(
            model.conversations.first(where: { $0.id == "person:acct_maya" })
        )
        let initialCount = model.messages(for: conversation).count

        await model.send("Preview the entry motion", to: conversation)

        let messages = model.messages(for: conversation)
        XCTAssertEqual(messages.count, initialCount + 1)
        XCTAssertEqual(messages.last?.text, "Preview the entry motion")
        XCTAssertEqual(messages.last?.deliveryState, .read)
        XCTAssertNil(messages.last?.errorMessage)
        XCTAssertNil(model.errorMessage)
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

    func testComposerMenusDoNotExposeMemeShortcuts() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let composer = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ComposerView.swift"),
            encoding: .utf8
        )
        let conversation = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(composer.contains("Meme from Photos"))
        XCTAssertFalse(composer.contains("onChooseMeme"))
        XCTAssertFalse(conversation.contains("showMemePhotoPicker"))
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

    func testGroupStickerConfirmationKeepsTheCompactStickerSubtype() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/App/AppModel.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let groupSendStart = try XCTUnwrap(source.range(of: "if conversation.kind == .group {"))
        let directSendStart = try XCTUnwrap(
            source.range(of: "let wireBody: String", range: groupSendStart.upperBound..<source.endIndex)
        )
        let groupSend = source[groupSendStart.lowerBound..<directSendStart.lowerBound]

        XCTAssertTrue(groupSend.contains(
            "uploadedAttachments.map { $0.chatAttachment(messageKind: outgoingMessageKind) }"
        ))
        XCTAssertFalse(groupSend.contains("uploadedAttachments.map(\\.chatAttachment)"))
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
        let start = try XCTUnwrap(source.range(of: "private var messageEditor: some View"))
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
    func testUIKitEditorRehydratesPastedBlobEmojiAndCopiesItsStableToken() async throws {
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
        let pasteboardItems = UIPasteboard.general.items
        defer {
            UIPasteboard.general.items = pasteboardItems
            window.isHidden = true
        }
        let token = ":blob:blobwave:"
        UIPasteboard.general.string = token
        textView.paste(nil)
        try await Task.sleep(for: .milliseconds(50))
        controller.view.layoutIfNeeded()

        XCTAssertEqual(model.text, token)
        XCTAssertEqual(BlobEmojiComposerText.rawText(textView.attributedText), token)
        XCTAssertEqual(textView.text, "\u{FFFC}")

        textView.selectedRange = NSRange(location: 0, length: 1)
        textView.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, token)
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
        XCTAssertEqual(suggestion?.displayName, "Kordi")
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
