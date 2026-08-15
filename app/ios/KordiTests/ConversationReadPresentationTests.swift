import XCTest
@testable import Kordi

final class ConversationReadPresentationTests: XCTestCase {
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
