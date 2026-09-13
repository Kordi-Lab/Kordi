import Foundation
import Testing
@testable import Kordi

@Suite(.serialized, .timeLimit(.minutes(1)))
struct MessageNotificationCleanupTests {
    @MainActor
    private func model() throws -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NotificationCleanupURLProtocol.self]
        let api = CloudAPIClient(
            baseURL: try #require(URL(string: "http://127.0.0.1:1")),
            session: URLSession(configuration: configuration)
        )
        return AppModel(api: api, cache: try LocalMessageStore(inMemory: true), previewMode: true)
    }

    private func payload(
        account: String = "acct_me", session: String = "chat", message: String = "server-message",
        sequence: Any? = nil, root: String? = nil
    ) throws -> KordiMessageNotificationPayload {
        var info: [AnyHashable: Any] = [
            "notification_type": "message", "account_id": account,
            "session_id": session, "message_id": message
        ]
        info["message_sequence"] = sequence
        info["thread_root_id"] = root
        return try #require(KordiMessageNotificationPayload(info))
    }

    private func message(conversation: String = "chat", sequence: Int64 = 42) -> ChatMessage {
        ChatMessage(
            id: "local-message", clientMessageId: "client-message", conversationId: conversation,
            conversationSequence: sequence, author: .person, authorName: "Sender", text: "Message",
            createdAt: Date(), deliveryState: .delivered, errorMessage: nil,
            requestMessageId: nil, reactionTargetMessageId: "server-message"
        )
    }

    @Test func decodesNumericAndStringSequencesWithoutBreakingOldPushes() throws {
        #expect(try payload(sequence: 42).messageSequence == 42)
        #expect(try payload(sequence: "42").messageSequence == 42)
        #expect(try payload().messageSequence == nil)
        for invalid: Any in [true, -1, 0, 1.5, "unknown", NSNull()] {
            #expect(try payload(sequence: invalid).messageSequence == nil)
        }
    }

    @Test func keepsNewerMessagesEvenWhenTheirConversationWasOpened() throws {
        let state = KordiMessageNotificationReadState(lastReadSequence: 42, threadReadCursors: [:], messages: [])
        #expect(try state.contains(payload(sequence: 40)))
        #expect(try state.contains(payload(sequence: 42)))
        #expect(try !state.contains(payload(sequence: 43)))
        #expect(try !state.contains(payload()))
    }

    @Test func threadReadsUseTheirOwnBoundary() throws {
        let state = KordiMessageNotificationReadState(
            lastReadSequence: 100, threadReadCursors: ["root": 42], messages: []
        )
        #expect(try state.contains(payload(sequence: 42, root: "root")))
        #expect(try !state.contains(payload(sequence: 43, root: "root")))
        #expect(try !state.contains(payload(sequence: 41, root: "other-root")))
        let threadOnly = KordiMessageNotificationReadState(
            lastReadSequence: 0, threadReadCursors: ["root": 42], messages: []
        )
        #expect(try !threadOnly.contains(payload(sequence: 42)))
    }

    @Test func oldPushesResolveCachedAliasesAndPreserveUnknownMessages() throws {
        let state = KordiMessageNotificationReadState(
            lastReadSequence: 42, threadReadCursors: ["root": 42], messages: [message()]
        )
        for id in ["local-message", "server-message", "client-message"] {
            #expect(try state.contains(payload(message: id)))
            #expect(try state.contains(payload(message: id, root: "root")))
        }
        #expect(try !state.contains(payload(message: "not-cached")))
        #expect(try !state.contains(payload(root: "unread-root")))
    }

    @Test func ignoresNonMessageAndMalformedThreadPayloads() {
        let base: [AnyHashable: Any] = [
            "notification_type": "message", "account_id": "acct_me", "session_id": "chat", "message_id": "m"
        ]
        #expect(KordiMessageNotificationPayload(["calendarEventId": "event"]) == nil)
        for root: Any in ["", 123] {
            var info = base
            info["thread_root_id"] = root
            #expect(KordiMessageNotificationPayload(info) == nil)
        }
    }

    @Test @MainActor func cleanupFollowsReadChangesAndKeepsUnrelatedNotifications() async throws {
        let model = try model()
        let conversation = try #require(model.conversations.first { $0.id == "person:acct_maya" })
        let other = try #require(model.conversations.first { $0.id == "person:acct_ethan" })
        model.upsertPreviewMessage(message(conversation: conversation.id))
        let store = FakeMessageNotificationStore()
        store.notifications = [
            .init(identifier: "old", payload: try payload(session: conversation.sessionId, sequence: 41)),
            .init(identifier: "read", payload: try payload(session: conversation.sessionId, sequence: 42)),
            .init(identifier: "legacy", payload: try payload(session: conversation.sessionId)),
            .init(identifier: "new", payload: try payload(session: conversation.sessionId, sequence: 43)),
            .init(identifier: "other", payload: try payload(session: other.sessionId, sequence: 42)),
            .init(identifier: "account", payload: try payload(account: "someone-else", session: conversation.sessionId, sequence: 42)),
            .init(identifier: "thread", payload: try payload(session: conversation.sessionId, sequence: 42, root: "root"))
        ]
        let coordinator = KordiNotificationCoordinator(messageNotificationStore: store)
        coordinator.configure(model: model)
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.removed.isEmpty)
        model.markConversationOpened(conversation)
        for _ in 0..<100 where store.removed.isEmpty {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(Set(store.removed) == ["old", "read", "legacy"])
        #expect(Set(store.notifications.map(\.identifier)) == ["new", "other", "account", "thread"])
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.removed.count == 3)
    }

    @Test @MainActor func logoutDuringNotificationFetchDoesNotClearAnotherAccountsNotifications() async throws {
        let model = try model()
        let conversation = try #require(model.conversations.first { $0.id == "person:acct_maya" })
        model.upsertPreviewMessage(message(conversation: conversation.id))
        model.markConversationOpened(conversation)
        let store = FakeMessageNotificationStore()
        store.notifications = [.init(identifier: "read", payload: try payload(session: conversation.sessionId, sequence: 42))]
        store.beforeReturning = { await model.signOut() }
        let coordinator = KordiNotificationCoordinator(messageNotificationStore: store)
        coordinator.configure(model: model)
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.removed.isEmpty)
    }

    @Test @MainActor func appliesReadProgressThatArrivesWhileFetchingNotifications() async throws {
        let model = try model()
        let conversation = try #require(model.conversations.first { $0.id == "person:acct_maya" })
        model.upsertPreviewMessage(message(conversation: conversation.id))
        let store = FakeMessageNotificationStore()
        store.notifications = [.init(identifier: "read", payload: try payload(session: conversation.sessionId, sequence: 42))]
        store.beforeReturning = { model.markConversationOpened(conversation) }
        let coordinator = KordiNotificationCoordinator(messageNotificationStore: store)
        coordinator.configure(model: model)
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.removed == ["read"])
    }

    @Test @MainActor func coalescesAnotherCleanupRequestDuringTheFetch() async throws {
        let model = try model()
        let store = FakeMessageNotificationStore()
        let coordinator = KordiNotificationCoordinator(messageNotificationStore: store)
        store.beforeReturning = { coordinator.scheduleNotificationCleanup() }
        coordinator.configure(model: model)
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.fetchCount == 2)
    }

    @Test @MainActor func replacingTheModelDuringTheFetchDoesNotUseItsOldReadState() async throws {
        let oldModel = try model()
        let newModel = try model()
        let conversation = try #require(oldModel.conversations.first { $0.id == "person:acct_maya" })
        oldModel.upsertPreviewMessage(message(conversation: conversation.id))
        oldModel.markConversationOpened(conversation)
        let store = FakeMessageNotificationStore()
        store.notifications = [.init(identifier: "read", payload: try payload(session: conversation.sessionId, sequence: 42))]
        let coordinator = KordiNotificationCoordinator(messageNotificationStore: store)
        store.beforeReturning = { coordinator.configure(model: newModel) }
        coordinator.configure(model: oldModel)
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.removed.isEmpty)
    }

    @Test @MainActor func reconcilesAlreadyReadArchivedConversations() async throws {
        let model = try model()
        let conversation = try #require(model.conversations.first { $0.id == "person:acct_maya" })
        model.upsertPreviewMessage(message(conversation: conversation.id))
        model.markConversationOpened(conversation)
        #expect(await model.archiveConversation(conversation))
        let store = FakeMessageNotificationStore()
        store.notifications = [.init(identifier: "archived", payload: try payload(session: conversation.sessionId, sequence: 42))]
        let coordinator = KordiNotificationCoordinator(messageNotificationStore: store)
        coordinator.configure(model: model)
        await coordinator.scheduleNotificationCleanup().value
        #expect(store.removed == ["archived"])
    }

    @Test @MainActor func devicePreviewMessagesOpenOfflineAndUseTheRealReadBoundary() async throws {
        let model = try model()
        model.installNotificationCleanupPreviewMessages()
        let conversation = try #require(model.conversations.first { $0.id == "person:acct_maya" })
        let messages = try #require(model.messagesByConversation[conversation.id])
        #expect(messages.count == 3)
        let last = try #require(messages.last)
        let route = try await model.loadThread(in: conversation, messageId: last.id)
        #expect(!route.isThread)
        #expect(route.target == last.id)
        let notification = try payload(session: conversation.sessionId, message: last.id, sequence: 3)
        #expect(!model.isMessageNotificationRead(notification))
        model.markConversationOpened(conversation)
        #expect(model.isMessageNotificationRead(notification))
    }
}

private final class NotificationCleanupURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
private final class FakeMessageNotificationStore: KordiMessageNotificationStore {
    var notifications: [KordiDeliveredMessageNotification] = []
    var removed: [String] = []
    var fetchCount = 0
    var beforeReturning: (() async -> Void)?

    func deliveredMessages() async -> [KordiDeliveredMessageNotification] {
        fetchCount += 1
        let action = beforeReturning
        beforeReturning = nil
        await action?()
        return notifications
    }

    func removeDeliveredMessages(withIdentifiers identifiers: [String]) {
        removed.append(contentsOf: identifiers)
        notifications.removeAll { identifiers.contains($0.identifier) }
    }
}
