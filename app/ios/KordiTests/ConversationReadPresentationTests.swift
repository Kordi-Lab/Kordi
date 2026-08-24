import ImageIO
import XCTest
@testable import Kordi

final class ConversationReadPresentationTests: XCTestCase {
    func testReactionChipOverlapsTheBubbleWithoutShrinkingItsTouchTarget() {
        XCTAssertEqual(MessageBubble.reactionChipVerticalLift, 14)
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

        for layout in [top, bottom] {
            XCTAssertGreaterThanOrEqual(layout.menuCenter.x - layout.menuWidth / 2, 12)
            XCTAssertLessThanOrEqual(layout.menuCenter.x + layout.menuWidth / 2, container.width - 12)
            XCTAssertGreaterThan(layout.menuCenter.y, 12)
            XCTAssertLessThan(layout.menuCenter.y, container.height - 12)
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
            XCTAssertEqual(
                layout.pickerCenter.y - layout.pickerHeight / 2,
                layout.reactionCenter.y - 26,
                accuracy: 0.001
            )
        }
        XCTAssertGreaterThan(top.menuCenter.y, top.reactionCenter.y)
        XCTAssertLessThan(bottom.menuCenter.y, bottom.reactionCenter.y)
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
}
