import XCTest
@testable import Kordi

@MainActor
final class LocalMessageStoreTests: XCTestCase {
    func testCacheIsAccountScopedWhenConversationAndMessageIDsOverlap() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:shared-contact"
        let firstConversation = conversation(id: conversationID, displayName: "First account chat")
        let secondConversation = conversation(id: conversationID, displayName: "Second account chat")
        let firstMessage = message(id: "shared-message", conversationID: conversationID, text: "First account")
        let secondMessage = message(id: "shared-message", conversationID: conversationID, text: "Second account")

        store.saveConversations([firstConversation], accountId: "account-a")
        store.saveMessages([firstMessage], conversationId: conversationID, accountId: "account-a")
        store.saveConversations([secondConversation], accountId: "account-b")
        store.saveMessages([secondMessage], conversationId: conversationID, accountId: "account-b")

        XCTAssertEqual(store.loadConversations(accountId: "account-a").map(\.displayName), ["First account chat"])
        XCTAssertEqual(store.loadConversations(accountId: "account-b").map(\.displayName), ["Second account chat"])
        XCTAssertEqual(store.loadMessages(accountId: "account-a", conversationId: conversationID).map(\.text), ["First account"])
        XCTAssertEqual(store.loadMessages(accountId: "account-b", conversationId: conversationID).map(\.text), ["Second account"])

        store.clear(accountId: "account-a")

        XCTAssertTrue(store.loadConversations(accountId: "account-a").isEmpty)
        XCTAssertTrue(store.loadMessages(accountId: "account-a", conversationId: conversationID).isEmpty)
        XCTAssertEqual(store.loadMessages(accountId: "account-b", conversationId: conversationID), [secondMessage])
    }

    func testPartialProjectionUpdatesKnownRowsWithoutErasingCachedHistory() {
        let conversationID = "person:shared-contact"
        let cachedEarlier = message(id: "earlier", conversationID: conversationID, text: "Earlier message")
        let cachedLatest = message(id: "latest", conversationID: conversationID, text: "Cached latest")
        let projectedLatest = message(id: "latest", conversationID: conversationID, text: "Synced latest")

        let merged = AppModel.mergePartialProjection(
            [projectedLatest],
            preserving: [cachedEarlier, cachedLatest]
        )

        XCTAssertEqual(merged.map(\.id), ["earlier", "latest"])
        XCTAssertEqual(merged.map(\.text), ["Earlier message", "Synced latest"])
    }

    func testPartialProjectionReplacesPreviousAgentSnapshotForSameRequest() {
        let previous = message(
            id: "processing-1",
            conversationID: "agent-session",
            text: "Inspecting files",
            author: .agent,
            requestMessageID: "request-1"
        )
        let current = message(
            id: "processing-2",
            conversationID: "agent-session",
            text: "Inspecting files and running tests",
            author: .agent,
            requestMessageID: "request-1"
        )

        let merged = AppModel.mergePartialProjection([current], preserving: [previous])

        XCTAssertEqual(merged, [current])
    }

    func testCacheRoundTripsLinkedBackgroundSessions() throws {
        let store = try LocalMessageStore(inMemory: true)
        let session = try XCTUnwrap(BackgroundAgentSession(wire: .init(
            sessionId: "session-child",
            turnId: "turn-child",
            title: "Review runtime",
            status: "running"
        )))
        let message = ChatMessage(
            id: "agent-response",
            conversationId: "person:shared-contact",
            author: .agent,
            authorName: "My Kordi",
            text: "Background session started",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: "request",
            backgroundAgentSessions: [session]
        )

        store.saveMessages(
            [message],
            conversationId: message.conversationId,
            accountId: "account-a"
        )

        XCTAssertEqual(
            store.loadMessages(
                accountId: "account-a",
                conversationId: message.conversationId
            ).first?.backgroundAgentSessions,
            [session]
        )
    }

    func testCacheOmitsAgentSessionIdentityMarkers() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "agent:my-kordi"
        let identity = ChatMessage(
            id: "agent-identity",
            conversationId: conversationID,
            author: .me,
            authorName: "You",
            text: "",
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: CloudMessageCodec.agentSessionIdentityMessageKind
        )
        let visible = message(id: "visible", conversationID: conversationID, text: "Hello")

        store.saveMessages([identity, visible], conversationId: conversationID, accountId: "account-a")

        XCTAssertEqual(
            store.loadMessages(accountId: "account-a", conversationId: conversationID),
            [visible]
        )
    }

    private func conversation(id: String, displayName: String) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: .person,
            peerAccountId: "shared-contact",
            agentId: nil,
            ownerDisplayName: displayName,
            displayName: displayName,
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:shared-contact"
        )
    }

    private func message(
        id: String,
        conversationID: String,
        text: String,
        author: MessageAuthor = .person,
        requestMessageID: String? = nil
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: conversationID,
            author: author,
            authorName: author == .agent ? "My Kordi" : "Shared contact",
            text: text,
            createdAt: Date(timeIntervalSince1970: id == "earlier" ? 1 : 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: requestMessageID
        )
    }
}
