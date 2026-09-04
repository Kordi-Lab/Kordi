import ImageIO
import UIKit
import XCTest
@testable import Kordi

final class ConversationReadPresentationTests: XCTestCase {
    func testAgentSessionShowsQueuedRequestsWithoutRunningPlaceholders() {
        let messages = agentQueueFixture()
        let projected = AgentSessionQueuePresentation.apply(to: messages, kind: .agent)
        XCTAssertNil(projected.first { $0.id == "request-1" }?.agentQueuePosition)
        XCTAssertEqual(projected.first { $0.id == "request-2" }?.agentQueuePosition, 1)
        XCTAssertEqual(projected.first { $0.id == "request-3" }?.agentQueuePosition, 2)
        XCTAssertEqual(projected.filter { $0.author == .agent }.map(\.requestMessageId), ["request-1"])
        XCTAssertEqual(messages.first { $0.id == "request-2" }?.deliveryState, .delivered)
    }

    func testAgentQueueAdvancesAfterSuccessFailureOrCancellation() {
        for phase: AgentExecutionSnapshot.Phase in [.complete, .failed, .cancelled] {
            var messages = agentQueueFixture()
            var terminal = messages.first { $0.id == "response-1" }!
            terminal.agentExecution = AgentExecutionSnapshot(
                phase: phase, summary: "Finished", steps: [], thinkingText: nil,
                tools: nil, startedAtMs: 1_000, updatedAtMs: 4_000, completed: true
            )
            messages.append(terminal)
            let projected = AgentSessionQueuePresentation.apply(to: messages, kind: .agent)
            XCTAssertNil(projected.first { $0.id == "request-2" }?.agentQueuePosition)
            XCTAssertEqual(projected.first { $0.id == "request-3" }?.agentQueuePosition, 1)
            XCTAssertTrue(projected.contains { $0.id == "response-2" })
        }
    }

    func testGroupAndContactRequestsDoNotUseTheAgentSessionQueue() {
        let messages = agentQueueFixture()
        for kind: ConversationKind in [.group, .person] {
            XCTAssertEqual(AgentSessionQueuePresentation.apply(to: messages, kind: kind), messages)
        }
    }

    private func agentQueueFixture() -> [ChatMessage] {
        (1...3).flatMap { index -> [ChatMessage] in
            let createdAt = Date(timeIntervalSince1970: Double(index))
            let request = ChatMessage(
                id: "request-\(index)", conversationId: "agent-session:test",
                author: .me, authorName: "You", text: "Message \(index)",
                createdAt: createdAt, deliveryState: .delivered,
                errorMessage: nil, requestMessageId: nil
            )
            let response = ChatMessage(
                id: "response-\(index)", conversationId: request.conversationId,
                author: .agent, authorName: "Kordi", text: "processing...",
                createdAt: createdAt.addingTimeInterval(0.001), deliveryState: .delivered,
                errorMessage: nil, requestMessageId: request.id,
                agentExecution: AgentExecutionSnapshot(
                    phase: .preparing, summary: "Preparing", steps: [], thinkingText: nil,
                    tools: nil, startedAtMs: Double(index) * 1_000,
                    updatedAtMs: Double(index) * 1_000, completed: false
                )
            )
            return [request, response]
        }
    }

    func testAgentSendAcknowledgementDoesNotWaitForRuntimeCompletion() throws {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi")
        let source = try String(
            contentsOf: iosDirectory.appendingPathComponent("App/AppModel.swift"),
            encoding: .utf8
        )
        let sendStart = try XCTUnwrap(source.range(of: "    func send(\n"))
        let sendEnd = try XCTUnwrap(source.range(
            of: "    func retry(",
            range: sendStart.upperBound..<source.endIndex
        ))
        let send = source[sendStart.lowerBound..<sendEnd.lowerBound]
        XCTAssertTrue(send.contains("startAgentRunInBackground("))
        XCTAssertFalse(send.contains("await startAgentRun("))

        let pollStart = try XCTUnwrap(source.range(of: "    private func pollForAgentReply("))
        let pollEnd = try XCTUnwrap(source.range(
            of: "    private struct MessageHistoryLoadResult",
            range: pollStart.upperBound..<source.endIndex
        ))
        XCTAssertFalse(source[pollStart.lowerBound..<pollEnd.lowerBound].contains("loadConversation("))
    }

    func testEmptyConversationLoadingHasVisibleProgress() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/ConversationInitialLoadingView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("ProgressView(\"Loading conversation…\")"))
    }

    func testChatDeleteShowsImmediateStableAlertPresentation() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(source.contains("Task.sleep(for: .milliseconds(180))"))
        XCTAssertEqual(source.components(separatedBy: "deleteTarget = conversation").count - 1, 2)
        XCTAssertTrue(source.contains(".alert(\n            \"Delete this chat from your list?\""))
        XCTAssertTrue(source.contains("It will return only when a new visible message arrives."))
        XCTAssertFalse(source.contains("deleteTarget.map { \"delete:"))
        XCTAssertFalse(source.contains(".id(deleteTarget?.sessionId"))
        XCTAssertFalse(source.contains("listLayoutIdentity"))
        XCTAssertFalse(source.contains(".confirmationDialog(\n            \"Delete this chat from your list?\""))
        XCTAssertEqual(
            source.components(separatedBy: "Button(role: .destructive) {")
                .dropFirst()
                .filter { $0.prefix(160).contains("requestDelete") }
                .count,
            2,
            "Only context-menu delete actions may be destructive before confirmation"
        )
    }

    func testArchivedChatsRemainOpenableAndGroupSessionsStayGrouped() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("@State private var selectedConversation: ConversationSummary?"))
        XCTAssertTrue(source.contains(".navigationDestination(item: $selectedConversation)"))
        XCTAssertTrue(source.contains("GroupSpaceCatalog.build(\n            conversations: conversations"))
        XCTAssertTrue(source.contains("Task { _ = await model.restoreGroupSpace(space) }"))
    }

    func testArchiveAndRestoreUpdateTheListBeforeWaitingForCloud() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/AppModel.swift"),
            encoding: .utf8
        )
        let boundaries = [
            ("func archiveGroupSpace", "func restoreGroupSpace"),
            ("func restoreGroupSpace", "func archiveConversation"),
            ("func archiveConversation", "func restoreConversation"),
            ("func restoreConversation", "private func moveConversations"),
        ]

        for (startMarker, endMarker) in boundaries {
            let start = try XCTUnwrap(source.range(of: startMarker))
            let end = try XCTUnwrap(source.range(
                of: endMarker,
                range: start.upperBound..<source.endIndex
            ))
            let action = source[start.lowerBound..<end.lowerBound]
            let beginMutation = try XCTUnwrap(action.range(of: "beginSessionVisibilityMutation()"))
            let localUpdate = try XCTUnwrap(action.range(of: "moveConversations("))
            let cloudRequest = try XCTUnwrap(action.range(of: "try await"))
            XCTAssertTrue(action.contains("defer { endSessionVisibilityMutation() }"))
            XCTAssertLessThan(beginMutation.lowerBound, localUpdate.lowerBound)
            XCTAssertLessThan(localUpdate.lowerBound, cloudRequest.lowerBound)
        }
    }

    func testPinUpdatesTheListBeforeWaitingForCloud() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/AppModel.swift"),
            encoding: .utf8
        )
        let boundaries = [
            ("func setConversationPinned", "func setConversationMuted"),
            ("func setGroupSpacePinned", "func setGroupSpaceMuted"),
        ]

        for (startMarker, endMarker) in boundaries {
            let start = try XCTUnwrap(source.range(of: startMarker))
            let end = try XCTUnwrap(source.range(
                of: endMarker,
                range: start.upperBound..<source.endIndex
            ))
            let action = source[start.lowerBound..<end.lowerBound]
            let beginMutation = try XCTUnwrap(action.range(of: "beginSessionVisibilityMutation()"))
            let localUpdate = try XCTUnwrap(action.range(of: "if pinned {"))
            let cloudRequest = try XCTUnwrap(action.range(of: "try await"))
            XCTAssertTrue(action.contains("defer { endSessionVisibilityMutation() }"))
            XCTAssertEqual(action.components(separatedBy: "if pinned {").count - 1, 1)
            XCTAssertLessThan(beginMutation.lowerBound, localUpdate.lowerBound)
            XCTAssertLessThan(localUpdate.lowerBound, cloudRequest.lowerBound)
        }
    }

    func testVisibilitySnapshotCannotOverwriteAnOverlappingOptimisticMutation() {
        XCTAssertTrue(SessionVisibilitySnapshotPolicy.shouldApply(
            startRevision: 4,
            currentRevision: 4,
            pendingMutationCount: 0
        ))
        XCTAssertFalse(SessionVisibilitySnapshotPolicy.shouldApply(
            startRevision: 4,
            currentRevision: 6,
            pendingMutationCount: 0
        ))
        XCTAssertFalse(SessionVisibilitySnapshotPolicy.shouldApply(
            startRevision: 4,
            currentRevision: 4,
            pendingMutationCount: 1
        ))
    }

    func testDeleteUpdatesTheListBeforeWaitingForCloud() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/AppModel.swift"),
            encoding: .utf8
        )
        let start = try XCTUnwrap(source.range(of: "func deleteConversation"))
        let end = try XCTUnwrap(source.range(
            of: "private func removeConversationLocally",
            range: start.upperBound..<source.endIndex
        ))
        let action = source[start.lowerBound..<end.lowerBound]
        let beginMutation = try XCTUnwrap(action.range(of: "beginSessionVisibilityMutation()"))
        let cloudRequest = try XCTUnwrap(action.range(of: "try await api.deleteSession"))
        let visibilityCheck = try XCTUnwrap(action.range(of: "try? await api.listSessionVisibility"))
        let localRemoval = try XCTUnwrap(action.range(of: "removeConversationLocally(conversation)"))
        let rollback = try XCTUnwrap(action.range(of: "conversations.append(contentsOf: visibleRows)"))

        XCTAssertTrue(action.contains("defer { endSessionVisibilityMutation() }"))
        XCTAssertLessThan(beginMutation.lowerBound, localRemoval.lowerBound)
        XCTAssertLessThan(localRemoval.lowerBound, cloudRequest.lowerBound)
        XCTAssertLessThan(cloudRequest.lowerBound, visibilityCheck.lowerBound)
        XCTAssertLessThan(visibilityCheck.lowerBound, rollback.lowerBound)
        XCTAssertTrue(action.contains("conversations.append(contentsOf: visibleRows)"))
        XCTAssertTrue(action.contains("archivedConversations.append(contentsOf: archivedRows)"))
    }

    func testGroupSessionRowsShowOnlyTheLatestMessagePreview() throws {
        let chatsDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Chats")
        let source = try String(
            contentsOf: chatsDirectory.appendingPathComponent("GroupSpaceRow.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("BlobEmojiPreviewText(text: session.lastMessage.nonEmpty ?? \"No messages yet\")"))
        XCTAssertFalse(source.contains("messageCountText"))
    }

    func testGroupExpansionScopesAnimationToTheChevron() throws {
        let chatsDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Chats")
        let homeSource = try String(
            contentsOf: chatsDirectory.appendingPathComponent("ChatHomeView.swift"),
            encoding: .utf8
        )
        let rowSource = try String(
            contentsOf: chatsDirectory.appendingPathComponent("GroupSpaceRow.swift"),
            encoding: .utf8
        )
        let groupToggles = homeSource.components(separatedBy: "private func toggleGroupSpace").dropFirst()

        XCTAssertEqual(groupToggles.count, 2)
        for suffix in groupToggles {
            let end = suffix.range(of: "\n    private func ")?.lowerBound ?? suffix.endIndex
            XCTAssertFalse(suffix[..<end].contains("withAnimation"))
        }
        XCTAssertTrue(rowSource.contains("accessibilityReduceMotion ? nil : .snappy(duration: 0.22)"))
        XCTAssertTrue(rowSource.contains("value: isExpanded"))
    }

    func testPinRebuildsOnlyTheActiveChatListLayouts() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("private var pinLayoutIdentity: [String]"))
        XCTAssertTrue(source.contains("model.pinnedSessionIds.map { \"session:"))
        XCTAssertTrue(source.contains("model.pinnedGroupSpaceIds.map { \"group:"))
        XCTAssertEqual(source.components(separatedBy: ".id(pinLayoutIdentity)").count - 1, 2)
        XCTAssertFalse(source.contains("listLayoutIdentity"))
    }

    func testContactsRemainVisibleWithoutAChatAndProfileUsesDirectChatAction() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features")
        let contacts = try String(
            contentsOf: root.appendingPathComponent("Contacts/ContactsView.swift"),
            encoding: .utf8
        )
        let details = try String(
            contentsOf: root.appendingPathComponent("Conversation/SessionDetailSheet.swift"),
            encoding: .utf8
        )
        let app = try String(
            contentsOf: root.deletingLastPathComponent().appendingPathComponent("App/KordiApp.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(contacts.contains("if let conversation = model.conversations.first"))
        XCTAssertTrue(contacts.contains("if let conversation = model.conversationForContact(contact)"))
        XCTAssertTrue(contacts.contains("NavigationLink(value: conversation)"))
        XCTAssertTrue(contacts.contains(".task { _ = await model.restoreConversationIfNeeded(conversation) }"))
        XCTAssertTrue(contacts.contains(".navigationDestination(for: ConversationSummary.self)"))
        XCTAssertFalse(contacts.contains("selectedConversation"))
        XCTAssertTrue(app.contains("ContactsView()"))
        XCTAssertTrue(details.contains("case .person: [.call, .video, .mute, .chat]"))
        XCTAssertFalse(details.contains("case .person: [.call, .video, .mute, .more]"))
    }

    func testReactionChipOverlapsTheBubbleWithoutShrinkingItsTouchTarget() {
        XCTAssertEqual(MessageBubble.reactionChipVerticalLift, 14)
    }

    func testEditedMessageStateRoundTripsAndDrivesBubbleMetadata() throws {
        let editedAt = Date(timeIntervalSince1970: 2)
        let message = ChatMessage(
            id: "edited-message",
            conversationId: "conversation",
            author: .person,
            authorName: "Mira",
            text: "Updated text",
            createdAt: Date(timeIntervalSince1970: 1),
            editedAt: editedAt,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )
        let decoded = try JSONDecoder().decode(
            ChatMessage.self,
            from: JSONEncoder().encode(message)
        )
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/MessageBubble.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(decoded.isEdited)
        XCTAssertEqual(decoded.editedAt, editedAt)
        XCTAssertTrue(source.contains("Text(\"edited\", comment:"))
        XCTAssertTrue(source.contains("if message.isEdited"))
    }

    func testMessageActionsExposeEditAndBothDeletionScopes() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let actionSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )
        let conversationSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )
        let composerSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ComposerView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(actionSource.contains("actionButton(\"Edit\""))
        XCTAssertTrue(actionSource.contains("\"Delete\","))
        XCTAssertTrue(actionSource.contains("deleteChoiceButton(deleteForEveryoneLabel)"))
        XCTAssertTrue(actionSource.contains("deleteChoiceButton(\"Delete for me\")"))
        XCTAssertTrue(actionSource.contains("isConfirmingDelete = true"))
        XCTAssertTrue(conversationSource.contains("? \"Delete for everyone\""))
        XCTAssertTrue(conversationSource.contains(": \"Delete for me and \\(conversation.displayName)\""))
        XCTAssertFalse(conversationSource.contains("\"Delete this message?\""))
        XCTAssertTrue(conversationSource.contains("activeDeleteParticle = particlePresentation"))
        XCTAssertTrue(conversationSource.contains("try? await Task.sleep(for: .milliseconds(34))"))
        XCTAssertFalse(conversationSource.contains("value: visibleTimelineRows.map(\\.id)"))
        XCTAssertTrue(conversationSource.contains("editingMessage: editTarget"))
        XCTAssertTrue(composerSource.contains("editPreview(editingMessage)"))
        XCTAssertTrue(composerSource.contains("Text(\"Edit message\")"))
        XCTAssertFalse(conversationSource.contains("MessageEditSheet("))
    }

    func testMessageDeleteReflowMovesOnlyEarlierRowsByDeletedHeight() {
        XCTAssertEqual(
            MessageDeleteReflow.affectedIDs(
                deleting: "third",
                orderedIDs: ["first", "second", "third", "fourth"]
            ),
            ["first", "second"]
        )
        XCTAssertTrue(
            MessageDeleteReflow.affectedIDs(
                deleting: "missing",
                orderedIDs: ["first", "second"]
            ).isEmpty
        )
        XCTAssertEqual(
            MessageDeleteReflow.offset(isAffected: false, distance: 48, progress: 0),
            0
        )
        XCTAssertEqual(
            MessageDeleteReflow.offset(isAffected: true, distance: 48, progress: 0),
            -48
        )
        XCTAssertEqual(
            MessageDeleteReflow.offset(isAffected: true, distance: 48, progress: 0.5),
            -24
        )
        XCTAssertEqual(
            MessageDeleteReflow.offset(isAffected: true, distance: 48, progress: 1),
            0
        )
        XCTAssertEqual(
            MessageDeleteReflow.offset(isAffected: true, distance: -48, progress: 0),
            0
        )
    }

    func testMessageBubblesUseThemeAwareContrastForRepliesLinksAndMentions() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let markdownSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MarkdownMessageContent.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(bubbleSource.contains("lightAppearanceBubbleTintColor"))
        XCTAssertTrue(bubbleSource.contains("chatTheme == .quiet ? .clear"))
        XCTAssertFalse(bubbleSource.contains("chatTheme.peerText.opacity(0.07)"))
        XCTAssertTrue(bubbleSource.contains("chatTheme.peerText.opacity(0.12)"))
        XCTAssertTrue(bubbleSource.contains("replyPreviewBackgroundColor"))
        XCTAssertTrue(bubbleSource.contains("inlineAccent: bubbleInlineAccentColor"))
        XCTAssertTrue(markdownSource.contains("@Entry var messageInlineAccent: Color? = nil"))
        XCTAssertTrue(markdownSource.contains("inlineAccent ?? KordiTheme.signalBlue"))
    }

    func testSyntheticConversationPreviewExposesThemeControls() throws {
        let appSource = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/KordiApp.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(appSource.contains("--preview-theme-controls"))
        XCTAssertTrue(appSource.contains("PreviewThemeControls("))
        XCTAssertTrue(appSource.contains("ForEach(KordiChatTheme.allCases)"))
        XCTAssertTrue(appSource.contains("ForEach(AppAppearance.allCases)"))
    }

    func testDeleteResurrectionPreviewAddsFreshUnreadMayaMessage() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/App/PreviewData.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("--preview-delete-resurrection"))
        XCTAssertTrue(source.contains("maya-delete-resurrection"))
        XCTAssertTrue(source.contains("New message after deletion — this chat is back."))
    }

    func testReactionChipsMatchTheAvatarEdgeAndMacOSSurface() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/MessageBubble.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("scrollAnchor: message.author == .me ? .trailing : .leading"))
        XCTAssertTrue(source.contains(".defaultScrollAnchor(scrollAnchor)"))
        XCTAssertTrue(source.contains(".background(Color(uiColor: .tertiarySystemFill), in: Capsule())"))
        XCTAssertFalse(source.contains("KordiTheme.agentViolet.opacity(0.14)"))
    }

    func testThreadRepliesShareOneAccessoryRowAndCannotNest() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let conversationSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )
        let actionSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(bubbleSource.contains("MessageBubbleAccessoryRow("))
        XCTAssertTrue(bubbleSource.contains("!message.reactions.isEmpty || threadReplyCount > 0"))
        XCTAssertTrue(conversationSource.contains("allowsQuotedReplies: scopedThreadRootMessageID == nil"))
        XCTAssertTrue(conversationSource.contains("allowsThreadReply: scopedThreadRootMessageID == nil"))
        XCTAssertTrue(conversationSource.contains("content.navigationDestination(item: $activeRootMessageID)"))
        XCTAssertTrue(conversationSource.contains("threadReturnMessageID = trackedMessageID ??"))
        XCTAssertTrue(conversationSource.contains("rememberViewport(in: messages)"))
        XCTAssertTrue(conversationSource.contains("proxy.scrollTo(returnMessageID, anchor: initialViewport.scrollAnchor)"))
        XCTAssertTrue(conversationSource.contains("isNavigationReturnPending: threadReturnMessageID != nil"))
        XCTAssertTrue(conversationSource.contains("contentOffsetY: geometry.contentOffset.y"))
        XCTAssertTrue(conversationSource.contains("exactScrollRestoreRequest = ConversationScrollRestoreRequest("))
        XCTAssertTrue(conversationSource.contains("restoreThreadReturnPosition(using: proxy)"))
        XCTAssertTrue(conversationSource.contains("threadReturnMessageID != nil || threadReturnScrollOffsetY != nil"))
        XCTAssertTrue(conversationSource.contains("trackedMessageID = nil"))
        XCTAssertTrue(conversationSource.contains("didRestoreContentOffset("))
        XCTAssertTrue(conversationSource.contains("scopedThreadRootMessageID.map"))
        XCTAssertTrue(actionSource.contains("actionButton(\"Reply in conversation\""))
        XCTAssertTrue(actionSource.contains("actionButton(\"Reply in thread\""))
        XCTAssertFalse(actionSource.contains("showsReplyDestinations"))
    }

    func testMessageActionsStopConversationPanningAfterTheHoldWins() {
        XCTAssertFalse(MessageGestureArbitration.allowsSimultaneousRecognition(
            with: UIPanGestureRecognizer()
        ))
        XCTAssertTrue(MessageGestureArbitration.allowsSimultaneousRecognition(
            with: UITapGestureRecognizer()
        ))
        XCTAssertEqual(MessageBubble.actionLongPressDuration, 0.5)
    }

    func testMessageActionsAllowManualTextSelectionOnlyAfterOpening() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")

        let markdownSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MarkdownMessageContent.swift"),
            encoding: .utf8
        )
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let overlaySource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )
        let conversationSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("ConversationView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(markdownSource.contains("SelectableMessageTextView("))
        XCTAssertTrue(markdownSource.contains("textView.isSelectable = true"))
        XCTAssertTrue(markdownSource.contains("textView.isScrollEnabled = false"))
        XCTAssertFalse(markdownSource.contains("textView.selectedRange = NSRange("))
        XCTAssertFalse(markdownSource.contains("textView.becomeFirstResponder()"))
        XCTAssertTrue(bubbleSource.contains("allowsTextSelection: isActionPresented"))
        XCTAssertTrue(bubbleSource.contains("onSelectedTextChange: onSelectedTextChange"))
        XCTAssertTrue(bubbleSource.contains("isHighlighted || isSelected"))
        XCTAssertTrue(bubbleSource.contains("value: showsSelectionHighlight"))
        XCTAssertTrue(bubbleSource.contains(".accessibilityAddTraits(isSelected ? .isSelected : [])"))
        XCTAssertTrue(overlaySource.contains("MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author)"))
        XCTAssertTrue(overlaySource.contains("readers: readReceiptReaders"))
        XCTAssertTrue(overlaySource.contains("readers.prefix(4)"))
        XCTAssertTrue(overlaySource.contains("size: avatarSize"))
        XCTAssertTrue(overlaySource.contains("MessageDeliveryGlyph(state: .read"))
        XCTAssertFalse(overlaySource.contains("cornerSize: CGSize(width: 18, height: 18)"))
        XCTAssertTrue(overlaySource.contains("eoFill: true"))
        XCTAssertTrue(overlaySource.contains("Button(action: onDismiss)"))
        XCTAssertTrue(overlaySource.contains("mediaAttachment == nil"))
        XCTAssertTrue(overlaySource.contains("AnyShape(Rectangle())"))
        XCTAssertTrue(overlaySource.contains("sourceFrame.offsetBy("))
        XCTAssertTrue(overlaySource.contains(".ignoresSafeArea()"))
        XCTAssertTrue(overlaySource.contains("MessageActionWindowOverlayView"))
        XCTAssertTrue(overlaySource.contains("passthroughFrame.contains(point)"))
        XCTAssertTrue(overlaySource.contains("withDuration: 0.18"))
        XCTAssertTrue(overlaySource.contains("UIAccessibility.isReduceMotionEnabled"))
        XCTAssertTrue(overlaySource.contains(".curveEaseOut"))
        XCTAssertFalse(overlaySource.contains("acceptsInput"))
        XCTAssertTrue(overlaySource.contains("actionButton(\"Select\""))
        XCTAssertTrue(conversationSource.contains("@State private var selectedMessageText: String?"))
        XCTAssertTrue(conversationSource.contains("selectedMessageText?.nonEmpty ?? message.text"))
        XCTAssertTrue(conversationSource.contains("selectedMessageText = nil"))
        XCTAssertTrue(conversationSource.contains("toggleSelection(message.id)"))
        XCTAssertFalse(conversationSource.contains("messageActionAcceptsInput"))
        XCTAssertTrue(conversationSource.contains(".scrollDisabled(messageActionMessage != nil)"))
        XCTAssertFalse(conversationSource.contains("proxy.scrollTo(row.id, anchor: .bottom)"))
        XCTAssertFalse(conversationSource.contains(".toolbarBackground(.visible"))
        XCTAssertTrue(conversationSource.contains(".toolbar(navigationBarVisibility, for: .navigationBar)"))
        XCTAssertTrue(conversationSource.contains("showsNavigationChrome ? .visible : .hidden"))
        XCTAssertFalse(conversationSource.contains("showsNavigationChrome && messageActionMessage == nil ? .visible : .hidden"))
        XCTAssertTrue(conversationSource.contains("WindowOverlayPresenter("))
        XCTAssertTrue(conversationSource.contains("passthroughFrame:"))
        XCTAssertTrue(conversationSource.contains("MessageReadReceiptPresentation.label("))
    }

    func testDirectReadReceiptProjectsAndNamesThePeer() throws {
        let directConversation = conversation(id: "direct", kind: .person, unread: 0)
        let projected = CloudDirectMessageProjector.project(
            [CloudMessageDTO(
                messageId: "msg_read",
                fromAccountId: "acct_me",
                toAccountId: "acct_peer",
                body: "Seen message",
                createdAt: "2026-08-29T10:00:00Z",
                deliveredAt: "2026-08-29T10:00:01Z",
                readAt: "2026-08-29T10:00:02Z",
                readByAccountIds: [],
                direction: "outgoing",
                sessionId: directConversation.sessionId
            )],
            conversation: directConversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first)
        let readers = MessageReadReceiptPresentation.readers(
            for: message,
            in: directConversation
        )

        XCTAssertEqual(message.readByAccountIds, ["acct_peer"])
        XCTAssertEqual(message.readByCount, 1)
        XCTAssertEqual(message.deliveryState.label, "Seen")
        XCTAssertEqual(readers.map(\.displayName), ["Conversation"])
        XCTAssertEqual(
            MessageReadReceiptPresentation.label(for: message, readers: readers),
            "1 Seen"
        )
    }

    func testMessageActionsDoNotMoveTimelineDuringViewportChange() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldKeepLatestVisibleAfterViewportChange(
            hasRevealedInitialViewport: true,
            wasAtLatest: true,
            isMessageActionPresented: true,
            previousViewportSize: CGSize(width: 390, height: 700),
            currentViewportSize: CGSize(width: 390, height: 744)
        ))
    }

    func testCachedThreadTimelineRendersWithoutAnotherConversationLoad() {
        XCTAssertTrue(ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: "root",
            messageCount: 1
        ))
        XCTAssertFalse(ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: "root",
            messageCount: 0
        ))
        XCTAssertFalse(ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: nil,
            messageCount: 1
        ))
    }

    func testBlobEmojiCatalogAndRecentsAreSharedDeduplicatedAndBounded() throws {
        XCTAssertEqual(BlobEmojiCatalog.all.count, 547)
        XCTAssertEqual(BlobEmojiCatalog.all.filter(\.animated).count, 173)
        var stored = "[]"
        for emoji in BlobEmojiCatalog.all.prefix(30) {
            stored = BlobEmojiRecentStore.recording(emoji.id, in: stored)
        }
        let selectedID = BlobEmojiCatalog.all[10].id
        stored = BlobEmojiRecentStore.recording(selectedID, in: stored)
        let recent = BlobEmojiRecentStore.ids(from: stored)

        XCTAssertEqual(recent.first, selectedID)
        XCTAssertEqual(recent.count, 24)
        XCTAssertEqual(recent.filter { $0 == selectedID }.count, 1)
        XCTAssertNotNil(BlobEmojiCatalog.assetURL(for: BlobEmojiCatalog.all[0]))
        let animated = try XCTUnwrap(BlobEmojiCatalog.all.first(where: \.animated))
        let animatedURL = try XCTUnwrap(BlobEmojiCatalog.assetURL(for: animated))
        let animatedSource = try XCTUnwrap(CGImageSourceCreateWithURL(animatedURL as CFURL, nil))
        XCTAssertGreaterThan(CGImageSourceGetCount(animatedSource), 1)
        let decoded = try XCTUnwrap(AnimatedImageDecoder.image(
            at: animatedURL,
            animated: true,
            maximumPixelSize: 64
        ))
        XCTAssertGreaterThan(decoded.images?.count ?? 1, 1)
    }

    func testQuickReactionImagesAreBundledAndPrewarmed() async throws {
        let animated = try XCTUnwrap(BlobEmojiCatalog.all.first(where: \.animated))
        let storedRecents = BlobEmojiRecentStore.recording(animated.id, in: "[]")
        let reactions = BlobEmojiCatalog.quickReactions(
            storedRecentEmojiIDs: storedRecents
        )

        XCTAssertEqual(reactions.count, 6)
        XCTAssertEqual(reactions.first, animated)
        XCTAssertTrue(reactions.allSatisfy {
            BlobEmojiCatalog.assetURL(for: $0) != nil
        })

        await BlobEmojiCatalog.prewarmQuickReactions(
            storedRecentEmojiIDs: storedRecents
        )

        XCTAssertTrue(reactions.allSatisfy {
            BlobEmojiCatalog.cachedImage(for: $0, animated: false) != nil
        })
    }

    func testReactionMutationAddsTogglesAndRemovesWithoutDuplicates() {
        let added = AppModel.updatingReaction(
            "👍",
            accountId: "acct_me",
            active: true,
            in: []
        )
        XCTAssertEqual(added, [MessageReaction(value: "👍", accountIds: ["acct_me"])])
        XCTAssertEqual(
            AppModel.updatingReaction(
                "👍",
                accountId: "acct_me",
                active: true,
                in: added
            ),
            added
        )
        XCTAssertTrue(
            AppModel.updatingReaction(
                "👍",
                accountId: "acct_me",
                active: false,
                in: added
            ).isEmpty
        )
    }

    func testActionOverlayStaysInsideTopAndBottomEdges() {
        let container = CGSize(width: 390, height: 700)
        let top = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 20, y: 70, width: 180, height: 70),
            containerSize: container,
            showsReactions: true,
            reactionCount: 4,
            actionCount: 5
        )
        let bottom = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 190, y: 590, width: 180, height: 70),
            containerSize: container,
            showsReactions: true,
            reactionCount: 4,
            actionCount: 5
        )
        let media = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 190, y: 280, width: 180, height: 240),
            containerSize: container,
            showsReactions: true,
            reactionCount: 4,
            actionCount: 8
        )
        let visibleMedia = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 150, y: 427, width: 228, height: 394),
            containerSize: CGSize(width: 390, height: 874),
            showsReactions: true,
            reactionCount: 6,
            actionCount: 7
        )
        let deleteConfirmation = MessageActionOverlayLayout.make(
            sourceFrame: CGRect(x: 190, y: 590, width: 180, height: 70),
            containerSize: container,
            showsReactions: false,
            reactionCount: 0,
            actionCount: 2,
            forcedMenuIsBelow: bottom.menuIsBelow
        )

        for layout in [top, bottom, media, deleteConfirmation] {
            XCTAssertGreaterThanOrEqual(layout.menuCenter.x - layout.menuWidth / 2, 12)
            XCTAssertLessThanOrEqual(layout.menuCenter.x + layout.menuWidth / 2, container.width - 12)
            XCTAssertGreaterThan(layout.menuCenter.y, 12)
            XCTAssertLessThan(layout.menuCenter.y, container.height - 12)
            XCTAssertGreaterThanOrEqual(layout.menuCenter.y - layout.menuHeight / 2, 12)
            XCTAssertLessThanOrEqual(
                layout.menuCenter.y + layout.menuHeight / 2,
                container.height - 12
            )
            XCTAssertGreaterThan(layout.reactionCenter.y, 12)
            XCTAssertLessThan(layout.reactionCenter.y, container.height - 12)
            XCTAssertGreaterThanOrEqual(layout.pickerCenter.x - layout.pickerWidth / 2, 12)
            XCTAssertLessThanOrEqual(
                layout.pickerCenter.x + layout.pickerWidth / 2,
                container.width - 12
            )
            XCTAssertGreaterThanOrEqual(layout.pickerCenter.y - layout.pickerHeight / 2, 12)
            XCTAssertLessThanOrEqual(
                layout.pickerCenter.y + layout.pickerHeight / 2,
                container.height - 12
            )
            XCTAssertLessThanOrEqual(
                layout.pickerCenter.y - layout.pickerHeight / 2,
                layout.reactionCenter.y - 26 + 0.001
            )
        }
        XCTAssertGreaterThan(top.menuCenter.y, top.reactionCenter.y)
        XCTAssertLessThan(bottom.menuCenter.y, bottom.reactionCenter.y)
        XCTAssertLessThanOrEqual(
            media.menuCenter.y + media.menuHeight / 2 + 8,
            media.reactionCenter.y - 26
        )
        XCTAssertEqual(visibleMedia.menuHeight, 318)
        XCTAssertEqual(visibleMedia.pickerHeight, 520)
        XCTAssertEqual(deleteConfirmation.menuHeight, 98)
        XCTAssertEqual(deleteConfirmation.menuIsBelow, bottom.menuIsBelow)
    }

    func testImageLongPressUsesTheFullMessageActionMenu() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let bubbleSource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let overlaySource = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageActionSheets.swift"),
            encoding: .utf8
        )
        let imageSource = bubbleSource.components(separatedBy: "private struct MessageImageAttachment")[1]
            .components(separatedBy: "private enum MessageImagePresentation")[0]
        let gestureSource = bubbleSource.components(separatedBy: "enum MessageGestureArbitration")[1]
            .components(separatedBy: "private struct MessageImageAttachment")[0]
        let collectionSource = bubbleSource.components(separatedBy: "private struct MessageImageCollection")[1]
            .components(separatedBy: "enum MessageImageStack")[0]

        XCTAssertFalse(imageSource.contains(".contextMenu {"))
        XCTAssertFalse(imageSource.contains(".simultaneousGesture("))
        XCTAssertFalse(imageSource.contains("MessageImageGestureSurface"))
        XCTAssertFalse(imageSource.contains("Button(action: activate)"))
        XCTAssertTrue(imageSource.contains("MessageInteractionGestureBridge("))
        XCTAssertTrue(imageSource.contains("onTap: opensPreview ? activate : nil"))
        XCTAssertTrue(imageSource.contains("onLongPress: openActions"))
        XCTAssertTrue(gestureSource.contains("UILongPressGestureRecognizer"))
        XCTAssertTrue(gestureSource.contains("UITapGestureRecognizer"))
        XCTAssertTrue(gestureSource.contains("recognizer.require(toFail: longPressRecognizer)"))
        XCTAssertTrue(gestureSource.contains("current as? UIScrollView"))
        XCTAssertTrue(gestureSource.contains("recognizer.cancelsTouchesInView = false"))
        XCTAssertFalse(imageSource.contains(".onGeometryChange(for: CGRect.self)"))
        XCTAssertTrue(gestureSource.contains("attachmentView.convert(attachmentView.bounds, to: window)"))
        XCTAssertTrue(imageSource.contains("onRequestActions(frame)"))
        XCTAssertTrue(collectionSource.contains("if presentation.isStackPreview"))
        XCTAssertTrue(collectionSource.contains("onPrepareActions(nil)"))
        XCTAssertTrue(collectionSource.contains("isExpanded = true"))
        XCTAssertTrue(collectionSource.contains("collapsedInteractionSurface"))
        XCTAssertTrue(bubbleSource.contains("!hasImageAttachments"))
        XCTAssertFalse(bubbleSource.contains("suppressesNextActionPresentation"))
        XCTAssertTrue(bubbleSource.contains("isActionPresented, actionAttachment == nil"))
        XCTAssertTrue(overlaySource.contains("actionButton(\"Review\""))
        XCTAssertTrue(overlaySource.contains("\"Download / Save to Files\""))
        XCTAssertTrue(overlaySource.contains("\"Add to \\(mediaKind.libraryName)\""))
        XCTAssertTrue(overlaySource.contains("\"Share\","))
        XCTAssertTrue(overlaySource.contains("systemImage: \"square.and.arrow.up\""))
        XCTAssertTrue(overlaySource.contains("action: onShareMessage"))
    }

    func testGroupedMessageImagesRenderBeforeTheirSeparateBubble() throws {
        let conversationDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation")
        let source = try String(
            contentsOf: conversationDirectory.appendingPathComponent("MessageBubble.swift"),
            encoding: .utf8
        )
        let messageSurface = source.components(separatedBy: "private var messageSurface")[1]
            .components(separatedBy: "private var imageCollection")[0]
        let bubbleContents = source.components(separatedBy: "private var bubbleContents")[1]
            .components(separatedBy: "private var usesBorderlessImageSurface")[0]

        XCTAssertTrue(messageSurface.contains("} else if usesDetachedImageGroup {"))
        XCTAssertTrue(messageSurface.contains("imageCollection\n                bubbleSurface"))
        XCTAssertTrue(bubbleContents.contains("!usesDetachedImageGroup"))
    }

    func testOnlyTerminalContentMessagesAllowReactions() {
        let message = ChatMessage(
            id: "message",
            conversationId: "conversation",
            author: .person,
            authorName: "Peer",
            text: "Hello",
            createdAt: .now,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            reactionTargetMessageId: "018f47c2-9f4c-7a5e-b001-000000000001"
        )
        XCTAssertTrue(MessageBubble.allowsReactions(for: message))
        var failed = message
        failed.deliveryState = .failed
        XCTAssertFalse(MessageBubble.allowsReactions(for: failed))

        var previewOnly = message
        previewOnly.reactionTargetMessageId = nil
        XCTAssertFalse(MessageBubble.allowsReactions(for: previewOnly))
        XCTAssertTrue(MessageBubble.allowsReactions(for: previewOnly, isPreviewMode: true))
    }

    func testReadPresentationRequiresVisibleForegroundLatestTranscript() {
        XCTAssertTrue(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: true,
                isAppForeground: true,
                isAtLatest: true
            ).canMarkRead
        )
        XCTAssertFalse(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: false,
                isAppForeground: true,
                isAtLatest: true
            ).canMarkRead
        )
        XCTAssertFalse(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: true,
                isAppForeground: false,
                isAtLatest: true
            ).canMarkRead
        )
        XCTAssertFalse(
            ConversationReadPresentation(
                conversationID: "conversation",
                isPresented: true,
                isAppForeground: true,
                isAtLatest: false
            ).canMarkRead
        )
    }

    @MainActor
    func testUnreadClearsOnlyWhenPreviewConversationBecomesReadable() throws {
        let model = AppModel(previewMode: true)
        let conversationID = "person:acct_maya"
        let presentationID = UUID()
        let initialUnread = try XCTUnwrap(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount
        )
        XCTAssertGreaterThan(initialUnread, 0)

        model.updateConversationReadPresentation(
            id: presentationID,
            conversationID: conversationID,
            isPresented: true,
            isAppForeground: false,
            isAtLatest: true
        )
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
            initialUnread
        )

        model.updateConversationReadPresentation(
            id: presentationID,
            conversationID: conversationID,
            isPresented: true,
            isAppForeground: true,
            isAtLatest: false
        )
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
            initialUnread
        )

        model.updateConversationReadPresentation(
            id: presentationID,
            conversationID: conversationID,
            isPresented: true,
            isAppForeground: true,
            isAtLatest: true
        )
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
            0
        )
    }

    func testTabUnreadCountsSumMessagesAndExcludeHiddenSessionsAndAgentTemplates() {
        let conversations = [
            conversation(id: "person", kind: .person, unread: 2),
            conversation(id: "group-main", kind: .group, unread: 3, groupSpaceId: "space"),
            conversation(id: "group-followup", kind: .group, unread: 1, groupSpaceId: "space"),
            conversation(id: "agent-session", kind: .agent, unread: 4),
            conversation(id: "agent-template:unused", kind: .agent, unread: 9),
        ]

        XCTAssertEqual(
            MainTabUnreadCounts.build(
                conversations: conversations
            ),
            MainTabUnreadCounts(chats: 6, agents: 4)
        )
        XCTAssertEqual(MainTabUnreadCounts.build(conversations: conversations).total, 10)
        XCTAssertEqual(
            MainTabUnreadCounts.build(
                conversations: conversations,
                mutedSessionIds: ["session:group-main", "session:agent-session"]
            ),
            MainTabUnreadCounts(chats: 3, agents: 0)
        )
        XCTAssertEqual(ConversationAttentionBadge.countLabel(120), "99+")
    }

    func testOnlyCloudGroupOwnersAndAdminsCanRenameChannels() {
        func group(role: String) -> ConversationSummary {
            ConversationSummary(
                id: "group-\(role)",
                kind: .group,
                peerAccountId: "acct_peer",
                agentId: nil,
                ownerDisplayName: "Group",
                displayName: "channel",
                lastMessage: "",
                lastActivityAt: .distantPast,
                unreadCount: 0,
                avatarSource: nil,
                agentActivity: nil,
                sessionId: "session:group:\(role)",
                groupParticipants: [
                    CloudGroupParticipant(
                        accountId: "acct_me",
                        displayName: "Me",
                        avatarUrl: nil,
                        role: role
                    )
                ]
            )
        }

        XCTAssertTrue(group(role: "owner").canManageGroup(accountId: "acct_me"))
        XCTAssertTrue(group(role: "admin").canManageGroup(accountId: "acct_me"))
        XCTAssertFalse(group(role: "member").canManageGroup(accountId: "acct_me"))
    }

    @MainActor
    func testAppModelDeletesLegacyLocalSessionTitleOverrides() {
        let key = "kordi.session-title-overrides"
        UserDefaults.standard.set(["session:group:old": "Local title"], forKey: key)

        _ = AppModel(previewMode: true)

        XCTAssertNil(UserDefaults.standard.object(forKey: key))
    }

    func testVisibleAndLegacyMentionsAdvanceUnreadState() throws {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi")
        let viewSource = try String(
            contentsOf: iosDirectory
                .appendingPathComponent("Features/Conversation/ConversationView.swift"),
            encoding: .utf8
        )
        let modelSource = try String(
            contentsOf: iosDirectory.appendingPathComponent("App/AppModel.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(viewSource.contains("onScrollVisibilityChange(threshold: 0.5)"))
        XCTAssertTrue(viewSource.contains("isPendingMention: pendingMentionMessageIDs.contains(message.id)"))
        XCTAssertTrue(modelSource.contains("throughSequence: message.conversationSequence"))
        XCTAssertTrue(modelSource.contains("let lastReadSequence = max("))
        XCTAssertTrue(modelSource.contains("$0 > lastReadSequence"))
        XCTAssertFalse(modelSource.contains("guard pendingMentionCount(for: conversation) == 0"))
        XCTAssertFalse(modelSource.contains("&& pendingMentionCount(for: $0) == 0"))
    }

    @MainActor
    func testPreviewChatListActionsUpdateVisibleState() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(
            model.conversations.first { $0.id == "person:acct_maya" }
        )

        let didPin = await model.setConversationPinned(conversation, pinned: true)
        XCTAssertTrue(didPin)
        XCTAssertTrue(model.pinnedSessionIds.contains(conversation.sessionId))
        let didMute = await model.setConversationMuted(conversation, muted: true)
        XCTAssertTrue(didMute)
        XCTAssertTrue(model.mutedSessionIds.contains(conversation.sessionId))

        let readConversation = try XCTUnwrap(
            model.conversations.first { $0.id == "person:acct_ethan" }
        )
        let didMarkUnread = await model.setConversationUnread(readConversation, unread: true)
        XCTAssertTrue(didMarkUnread)
        XCTAssertTrue(model.markedUnreadSessionIds.contains(readConversation.sessionId))
        XCTAssertEqual(
            model.conversations.first { $0.id == readConversation.id }?.unreadCount,
            1
        )
        await model.markConversationRead(readConversation)
        XCTAssertFalse(model.markedUnreadSessionIds.contains(readConversation.sessionId))
        XCTAssertEqual(
            model.conversations.first { $0.id == readConversation.id }?.unreadCount,
            0
        )

        let didArchive = await model.archiveConversation(conversation)
        XCTAssertTrue(didArchive)
        XCTAssertFalse(model.conversations.contains { $0.sessionId == conversation.sessionId })
        XCTAssertTrue(model.archivedConversations.contains { $0.sessionId == conversation.sessionId })

        let didRestore = await model.restoreConversation(conversation)
        XCTAssertTrue(didRestore)
        XCTAssertTrue(model.conversations.contains { $0.sessionId == conversation.sessionId })
        XCTAssertFalse(model.archivedConversations.contains { $0.sessionId == conversation.sessionId })

        let didDelete = await model.deleteConversation(conversation)
        XCTAssertTrue(didDelete)
        XCTAssertFalse(model.conversations.contains { $0.sessionId == conversation.sessionId })
        XCTAssertFalse(model.mutedSessionIds.contains(conversation.sessionId))
    }

    @MainActor
    func testDeletingAChatKeepsTheContactAndAllowsStartingChatAgain() async throws {
        let model = AppModel(previewMode: true)
        let contact = try XCTUnwrap(model.contacts.first { $0.accountId == "acct_maya" })
        let conversation = try XCTUnwrap(
            model.conversations.first { $0.kind == .person && $0.peerAccountId == contact.accountId }
        )

        let didDelete = await model.deleteConversation(conversation)
        XCTAssertTrue(didDelete)
        XCTAssertTrue(model.contacts.contains { $0.accountId == contact.accountId })
        XCTAssertFalse(model.conversations.contains { $0.sessionId == conversation.sessionId })

        let reopenedConversation = model.conversationForContact(contact)
        let reopened = try XCTUnwrap(reopenedConversation)
        XCTAssertEqual(reopened.peerAccountId, contact.accountId)

        let didRestore = await model.restoreConversationIfNeeded(reopened)
        XCTAssertTrue(didRestore)
        XCTAssertTrue(model.conversations.contains { $0.sessionId == reopened.sessionId })
    }

    @MainActor
    func testPreviewGroupActionsApplyToEverySessionAtomically() async throws {
        let model = AppModel(previewMode: true)
        let space = try XCTUnwrap(
            GroupSpaceCatalog.build(
                conversations: model.conversations,
                ownAccountId: model.account?.accountId ?? "",
                pinnedSessionIds: model.pinnedSessionIds
            ).first { $0.displayName == "Mobile builders" }
        )
        let sessionIds = Set(space.sessions.map(\.sessionId))
        XCTAssertEqual(space.preferenceId, "session:group:mobile")

        let didPin = await model.setGroupSpacePinned(space, pinned: true)
        XCTAssertTrue(didPin)
        XCTAssertTrue(model.pinnedGroupSpaceIds.contains(space.preferenceId))
        XCTAssertTrue(model.pinnedSessionIds.isDisjoint(with: sessionIds))

        let pinnedSession = try XCTUnwrap(space.sessions.first)
        let didPinSession = await model.setConversationPinned(pinnedSession, pinned: true)
        XCTAssertTrue(didPinSession)
        XCTAssertTrue(model.pinnedSessionIds.contains(pinnedSession.sessionId))
        XCTAssertTrue(model.pinnedGroupSpaceIds.contains(space.preferenceId))

        let didUnpinGroup = await model.setGroupSpacePinned(space, pinned: false)
        XCTAssertTrue(didUnpinGroup)
        XCTAssertFalse(model.pinnedGroupSpaceIds.contains(space.preferenceId))
        XCTAssertTrue(model.pinnedSessionIds.contains(pinnedSession.sessionId))
        let didRepinGroup = await model.setGroupSpacePinned(space, pinned: true)
        XCTAssertTrue(didRepinGroup)
        let didMute = await model.setGroupSpaceMuted(space, muted: true)
        XCTAssertTrue(didMute)
        XCTAssertTrue(sessionIds.isSubset(of: model.mutedSessionIds))

        await model.markGroupSpaceRead(space)
        XCTAssertTrue(
            model.conversations
                .filter { sessionIds.contains($0.sessionId) }
                .allSatisfy { !$0.hasUnreadAttention }
        )

        let didArchive = await model.archiveGroupSpace(space)
        XCTAssertTrue(didArchive)
        XCTAssertFalse(model.conversations.contains { sessionIds.contains($0.sessionId) })
        XCTAssertEqual(
            Set(model.archivedConversations.map(\.sessionId)).intersection(sessionIds),
            sessionIds
        )
        XCTAssertTrue(model.pinnedSessionIds.isDisjoint(with: sessionIds))
        XCTAssertFalse(model.pinnedGroupSpaceIds.contains(space.preferenceId))

        let archivedSpace = try XCTUnwrap(
            GroupSpaceCatalog.build(
                conversations: model.archivedConversations,
                ownAccountId: model.account?.accountId ?? ""
            ).first { $0.id == space.id }
        )
        XCTAssertEqual(Set(archivedSpace.sessions.map(\.sessionId)), sessionIds)

        let didRestore = await model.restoreGroupSpace(archivedSpace)
        XCTAssertTrue(didRestore)
        XCTAssertTrue(sessionIds.isSubset(of: Set(model.conversations.map(\.sessionId))))
        XCTAssertTrue(model.archivedConversations.allSatisfy { !sessionIds.contains($0.sessionId) })
    }

    @MainActor
    func testMessageNotificationPreferencesPersistPerDevice() throws {
        let suiteName = "KordiNotificationPreferencesTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let coordinator = KordiNotificationCoordinator(defaults: defaults)
        XCTAssertTrue(coordinator.messagesEnabled)
        XCTAssertTrue(coordinator.previewsEnabled)

        coordinator.setPreference(.messages, enabled: false)
        coordinator.setPreference(.previews, enabled: false)

        let restored = KordiNotificationCoordinator(defaults: defaults)
        XCTAssertFalse(restored.messagesEnabled)
        XCTAssertFalse(restored.previewsEnabled)
        XCTAssertTrue(restored.soundEnabled)
        XCTAssertTrue(restored.badgeEnabled)
    }

    func testNotificationAuthorizationRequestsAutomaticallyOnlyAfterLogin() {
        XCTAssertTrue(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: true,
            state: .notDetermined
        ))
        XCTAssertFalse(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: false,
            state: .notDetermined
        ))
        XCTAssertFalse(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: true,
            state: .authorized
        ))
        XCTAssertFalse(shouldAutomaticallyRequestNotificationAuthorization(
            accountAvailable: true,
            state: .denied
        ))
    }

    private func conversation(
        id: String,
        kind: ConversationKind,
        unread: Int,
        groupSpaceId: String? = nil,
        forkedFromSessionId: String? = nil
    ) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: kind,
            peerAccountId: "acct_peer",
            agentId: kind == .agent ? "agent" : nil,
            ownerDisplayName: "Conversation",
            displayName: "Conversation",
            lastMessage: "Latest message",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: unread,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:\(id)",
            groupSpaceId: groupSpaceId,
            messageCount: 1,
            forkedFromSessionId: forkedFromSessionId
        )
    }
}
