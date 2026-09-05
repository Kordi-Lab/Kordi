import XCTest
@testable import Kordi

@MainActor
final class LocalMessageStoreTests: XCTestCase {
    func testIncrementalCacheSavesPreserveUpdatesAndReinsertDeletedMessages() throws {
        let store = try LocalMessageStore(inMemory: true)
        let accountID = "synthetic-account"
        let conversationID = "synthetic-direct"
        var messages = (0..<100).map {
            message(id: "synthetic-\($0)", conversationID: conversationID, text: "Original \($0)")
        }
        store.saveMessages(messages, conversationId: conversationID, accountId: accountID)
        messages[50].text = "Edited"
        messages[51].deliveryState = .read
        store.saveMessages(messages, conversationId: conversationID, accountId: accountID)
        XCTAssertEqual(
            store.loadMessages(accountId: accountID, conversationId: conversationID),
            messages.sorted(by: ChatMessage.timelinePrecedes)
        )
        store.deleteMessages([messages[50].id], accountId: accountID)
        store.saveMessages(messages, conversationId: conversationID, accountId: accountID)
        XCTAssertEqual(store.loadMessages(accountId: accountID, conversationId: conversationID).count, 100)
        store.clear(accountId: accountID)
        store.saveMessages(messages, conversationId: conversationID, accountId: accountID)
        XCTAssertEqual(
            store.loadMessages(accountId: accountID, conversationId: conversationID),
            messages.sorted(by: ChatMessage.timelinePrecedes)
        )
    }

    func testConversationCacheKeepsLatestStickerPreview() throws {
        let store = try LocalMessageStore(inMemory: true)
        var source = conversation(id: "person:sticker", displayName: "Sticker chat")
        source.lastMessage = "Sticker"
        source.lastAttachment = ChatAttachment(
            attachmentId: "att-sticker",
            name: "kirby.png",
            kind: .image,
            subtype: .sticker,
            mimeType: "image/png",
            sizeBytes: 1_024,
            previewURL: "data:image/png;base64,preview"
        )

        store.saveConversations([source], accountId: "account-a")

        let restored = try XCTUnwrap(store.loadConversations(accountId: "account-a").first)
        XCTAssertEqual(restored.lastMessage, "Sticker")
        XCTAssertEqual(restored.lastAttachment, source.lastAttachment)
    }

    func testBlankLegacyConversationPreviewIsRepairedFromCachedStickerMessage() {
        let source = conversation(id: "person:sticker", displayName: "Sticker chat")
        let sticker = ChatAttachment(
            attachmentId: "att-sticker",
            name: "kirby.png",
            kind: .image,
            subtype: .sticker,
            mimeType: "image/png",
            sizeBytes: 1_024,
            previewURL: "data:image/png;base64,preview"
        )
        let latest = ChatMessage(
            id: "sticker-message",
            conversationId: source.id,
            author: .me,
            authorName: "You",
            text: "",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            attachments: [sticker],
            messageKind: "sticker"
        )

        let repaired = AppModel.restoringConversationPreview(source, latest: latest)

        XCTAssertEqual(repaired.previewText, "Sticker")
        XCTAssertEqual(repaired.lastAttachment, sticker)
    }

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
        XCTAssertEqual(
            store.loadMessagePage(
                accountId: "account-a",
                conversationId: conversationID,
                limit: 64
            ).messages.map(\.text),
            ["First account"]
        )
        XCTAssertEqual(
            store.loadMessagePage(
                accountId: "account-b",
                conversationId: conversationID,
                limit: 64
            ).messages.map(\.text),
            ["Second account"]
        )

        store.clear(accountId: "account-a")

        XCTAssertTrue(store.loadConversations(accountId: "account-a").isEmpty)
        XCTAssertTrue(store.loadMessages(accountId: "account-a", conversationId: conversationID).isEmpty)
        XCTAssertEqual(store.loadMessages(accountId: "account-b", conversationId: conversationID), [secondMessage])
    }

    func testPartialProjectionPersistsWithoutErasingCachedHistory() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:shared-contact"
        let cachedEarlier = message(id: "earlier", conversationID: conversationID, text: "Earlier message")
        let cachedLatest = message(id: "latest", conversationID: conversationID, text: "Cached latest")
        let projectedLatest = message(id: "latest", conversationID: conversationID, text: "Synced latest")

        store.saveMessages(
            [cachedEarlier, cachedLatest],
            conversationId: conversationID,
            accountId: "account-a"
        )
        let merged = AppModel.mergePartialProjection(
            [projectedLatest],
            preserving: [cachedEarlier, cachedLatest]
        )
        store.saveMessages(merged, conversationId: conversationID, accountId: "account-a")

        XCTAssertEqual(merged.map(\.id), ["earlier", "latest"])
        XCTAssertEqual(merged.map(\.text), ["Earlier message", "Synced latest"])
        XCTAssertEqual(
            store.loadMessages(accountId: "account-a", conversationId: conversationID),
            merged
        )
    }

    func testDeletingCachedMessageRemovesRowsAndLatestPageProjection() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:deleted-message"
        let kept = message(id: "kept", conversationID: conversationID, text: "Keep")
        let deleted = message(id: "deleted", conversationID: conversationID, text: "Delete")
        store.saveMessages(
            [kept, deleted],
            conversationId: conversationID,
            accountId: "account-a"
        )

        store.deleteMessages([deleted.id], accountId: "account-a")

        XCTAssertEqual(
            store.loadMessages(accountId: "account-a", conversationId: conversationID),
            [kept]
        )
        XCTAssertEqual(
            store.loadMessagePage(
                accountId: "account-a",
                conversationId: conversationID,
                limit: 20
            ).messages,
            [kept]
        )
    }

    func testCacheRoundTripsMessageReactions() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:reaction-contact"
        var reacted = message(
            id: "reaction-message",
            conversationID: conversationID,
            text: "Reacted"
        )
        reacted.reactions = [
            MessageReaction(value: "❤️", accountIds: ["acct_a", "acct_b"])
        ]
        reacted.reactionTargetMessageId = "018f47c2-9f4c-7a5e-b001-000000000001"

        store.saveMessages(
            [reacted],
            conversationId: conversationID,
            accountId: "account-a"
        )

        XCTAssertEqual(
            store.loadMessages(accountId: "account-a", conversationId: conversationID),
            [reacted]
        )
    }

    func testCacheLoadsBoundedPagesWithoutDeletingOlderRows() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:paged-contact"
        let messages = (0..<100).map { index in
            ChatMessage(
                id: "paged-\(index)",
                conversationId: conversationID,
                author: .person,
                authorName: "Paged contact",
                text: "Message \(index)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(index)),
                deliveryState: .delivered,
                errorMessage: nil,
                requestMessageId: nil
            )
        }
        store.saveMessages(messages, conversationId: conversationID, accountId: "account-a")

        let latest = store.loadMessagePage(
            accountId: "account-a",
            conversationId: conversationID,
            limit: 64
        )
        XCTAssertEqual(latest.messages.count, 64)
        XCTAssertTrue(latest.hasMore)
        XCTAssertEqual(latest.messages.first?.id, "paged-36")
        XCTAssertEqual(latest.messages.last?.id, "paged-99")

        store.saveMessages(
            latest.messages,
            conversationId: conversationID,
            accountId: "account-a"
        )
        let earlier = store.loadMessagePage(
            accountId: "account-a",
            conversationId: conversationID,
            before: latest.messages.first,
            limit: 64
        )
        XCTAssertEqual(earlier.messages.count, 36)
        XCTAssertFalse(earlier.hasMore)
        XCTAssertEqual(earlier.messages.first?.id, "paged-0")
        XCTAssertEqual(earlier.messages.last?.id, "paged-35")
        XCTAssertEqual(
            store.loadMessages(accountId: "account-a", conversationId: conversationID).count,
            100
        )
    }

    func testCachedPagesUseCanonicalSequenceInsteadOfTimestampOrID() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:sequenced-contact"
        let messages = (1...100).reversed().map { sequence in
            ChatMessage(
                id: String(format: "reverse-id-%03d", 101 - sequence),
                conversationId: conversationID,
                conversationSequence: Int64(sequence),
                author: .person,
                authorName: "Sequenced contact",
                text: "Message \(sequence)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(101 - sequence)),
                deliveryState: .delivered,
                errorMessage: nil,
                requestMessageId: nil
            )
        }
        store.saveMessages(messages, conversationId: conversationID, accountId: "account-a")

        let latest = store.loadMessagePage(
            accountId: "account-a",
            conversationId: conversationID,
            limit: 10
        )
        let earlier = store.loadMessagePage(
            accountId: "account-a",
            conversationId: conversationID,
            before: latest.messages.first,
            limit: 10
        )

        XCTAssertEqual(latest.messages.compactMap(\.conversationSequence), Array(91...100).map(Int64.init))
        XCTAssertEqual(earlier.messages.compactMap(\.conversationSequence), Array(81...90).map(Int64.init))
    }

    func testLatestPageRecordPreservesEarlierHistoryAtTheExactPageBoundary() throws {
        let store = try LocalMessageStore(inMemory: true)
        let conversationID = "person:exact-page"
        let messages = (1...64).map { sequence in
            message(
                id: "exact-\(sequence)",
                conversationID: conversationID,
                text: "Message \(sequence)"
            )
        }

        store.saveMessages(
            messages,
            conversationId: conversationID,
            accountId: "account-a",
            hasEarlier: true
        )
        let page = store.loadMessagePage(
            accountId: "account-a",
            conversationId: conversationID,
            limit: 64
        )

        XCTAssertEqual(page.messages.count, 64)
        XCTAssertTrue(page.hasMore)
    }

    func testRecentConversationPagesStayBoundedAndPromoteReopenedChats() {
        var recent: [String] = []
        for index in 0..<12 {
            recent = AppModel.recentCachedConversationIDs(recent, adding: "conversation-\(index)")
        }
        XCTAssertEqual(recent, (4..<12).map { "conversation-\($0)" })

        recent = AppModel.recentCachedConversationIDs(recent, adding: "conversation-4")

        XCTAssertEqual(recent, (5..<12).map { "conversation-\($0)" } + ["conversation-4"])
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
            senderOwnerName: "Shu Yang",
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

        let restored = store.loadMessages(
            accountId: "account-a",
            conversationId: message.conversationId
        ).first
        XCTAssertEqual(restored?.senderOwnerName, "Shu Yang")
        XCTAssertEqual(restored?.backgroundAgentSessions, [session])
    }

    func testCacheRoundTripsMentionAttentionStateAndEntities() throws {
        let store = try LocalMessageStore(inMemory: true)
        var conversation = conversation(id: "person:mentions", displayName: "Mentions")
        conversation.unreadCount = 4
        conversation.unreadMentionCount = 2
        conversation.lastReadSequence = 7
        let mention = MessageMention(
            label: "Alex",
            targetKind: "person",
            targetIdentityId: "human:acct_me"
        )
        let message = ChatMessage(
            id: "mentioned-message",
            conversationId: conversation.id,
            conversationSequence: 8,
            author: .person,
            authorName: "Shared contact",
            text: "@Alex please review",
            createdAt: Date(timeIntervalSince1970: 8),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            mentions: [mention]
        )

        store.saveConversations([conversation], accountId: "account-a")
        store.saveMessages(
            [message],
            conversationId: conversation.id,
            accountId: "account-a"
        )

        let restoredConversation = try XCTUnwrap(
            store.loadConversations(accountId: "account-a").first
        )
        XCTAssertEqual(restoredConversation.unreadMentionCount, 2)
        XCTAssertEqual(restoredConversation.lastReadSequence, 7)
        XCTAssertEqual(
            store.loadMessages(
                accountId: "account-a",
                conversationId: conversation.id
            ).first?.mentions,
            [mention]
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

    func testCachedMessagesFollowStableSessionWhenConversationIDChanges() throws {
        let store = try LocalMessageStore(inMemory: true)
        let cachedConversation = conversation(id: "cached-id", displayName: "Cached")
        let canonicalConversation = conversation(id: "canonical-id", displayName: "Canonical")
        var cachedMessage = message(
            id: "history",
            conversationID: cachedConversation.id,
            text: "Persisted history",
            author: .agent,
            senderOwnerName: "Shu Yang"
        )
        cachedMessage.reactionTargetMessageId = "018f47c2-9f4c-7a5e-b001-000000000001"
        cachedMessage.reactions = [MessageReaction(value: "blob:blobwave", accountIds: ["account-a"])]
        var messagesByConversation = [cachedConversation.id: [cachedMessage]]

        let changed = AppModel.rekeyMessages(
            &messagesByConversation,
            from: [cachedConversation],
            to: [canonicalConversation]
        )
        let rebased = try XCTUnwrap(messagesByConversation[canonicalConversation.id])
        store.saveMessages(
            rebased,
            conversationId: canonicalConversation.id,
            accountId: "account-a"
        )

        XCTAssertEqual(changed, [canonicalConversation.id])
        XCTAssertNil(messagesByConversation[cachedConversation.id])
        XCTAssertEqual(rebased.map(\.conversationId), [canonicalConversation.id])
        XCTAssertEqual(rebased.first?.reactionTargetMessageId, cachedMessage.reactionTargetMessageId)
        XCTAssertEqual(rebased.first?.reactions, cachedMessage.reactions)
        XCTAssertEqual(rebased.first?.senderOwnerName, cachedMessage.senderOwnerName)
        XCTAssertEqual(
            store.loadMessages(accountId: "account-a", conversationId: canonicalConversation.id),
            rebased
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
        requestMessageID: String? = nil,
        senderOwnerName: String? = nil
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: conversationID,
            author: author,
            authorName: author == .agent ? "My Kordi" : "Shared contact",
            senderOwnerName: senderOwnerName,
            text: text,
            createdAt: Date(timeIntervalSince1970: id == "earlier" ? 1 : 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: requestMessageID
        )
    }
}
