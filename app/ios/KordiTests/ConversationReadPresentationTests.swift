import ImageIO
import UIKit
import XCTest
@testable import Kordi

final class ConversationReadPresentationTests: XCTestCase {
    func testReactionChipOverlapsTheBubbleWithoutShrinkingItsTouchTarget() {
        XCTAssertEqual(MessageBubble.reactionChipVerticalLift, 14)
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
        XCTAssertTrue(overlaySource.contains("AnyShape(MessageActionBackdrop(cutout: cutout))"))
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
        XCTAssertTrue(conversationSource.contains(".toolbarBackground(.visible"))
        XCTAssertTrue(conversationSource.contains("WindowOverlayPresenter("))
        XCTAssertTrue(conversationSource.contains("passthroughFrame:"))
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

        for layout in [top, bottom, media] {
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
        XCTAssertTrue(imageSource.contains("onTap: activate"))
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

    func testTabUnreadCountsDeduplicateGroupSpacesAndExcludeAgentTemplates() {
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
            MainTabUnreadCounts(chats: 2, agents: 1)
        )
        XCTAssertEqual(ConversationAttentionBadge.countLabel(120), "99+")
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

    private func conversation(
        id: String,
        kind: ConversationKind,
        unread: Int,
        groupSpaceId: String? = nil
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
            messageCount: 1
        )
    }
}
