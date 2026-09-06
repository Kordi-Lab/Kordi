import Foundation
import Testing
@testable import Kordi

@Test(arguments: [false, true])
@MainActor
func canonicalAgentTitleWinsWithExistingMessages(personal: Bool) throws {
    let avatar = CanonicalAvatarDescriptor(entityType: "human", entityId: "acct_owner", source: "generated", style: "lorelei", seed: "title-fixture", rendererVersion: CanonicalAvatarSystem.rendererVersion, uploadedAsset: nil, version: 1, updatedAt: "2026-09-01T00:00:00Z")
    let account = CloudAccount(accountId: "acct_owner", kordiId: nil, displayName: "Owner", primaryEmail: nil, avatarUrl: nil, avatar: avatar, nodeId: nil, passwordSet: true)
    let session = "session:self-agent:title-fixture"
    var value: [String: Any] = [
        "id": "conversation", "kind": "ai", "shared_title": "Saved research title", "version": 3,
        "created_by_account_id": "acct_owner", "legacy_session_id": session, "latest_message_sequence": 1,
        "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z", "members": [],
        "preferences": ["conversation_id":"conversation", "account_id":"acct_owner", "personal_title":NSNull(), "version":1],
    ]
    if personal { value["preferences"] = ["conversation_id":"conversation", "account_id":"acct_owner", "personal_title":"My renamed research", "version":2] }
    let canonical = try JSONDecoder().decode(CloudChatConversation.self, from: JSONSerialization.data(withJSONObject: value))
    let message = CloudMessageDTO(messageId: "message", fromAccountId: "acct_owner", toAccountId: "acct_owner", body: "Original request", createdAt: "2026-09-01T00:00:00Z", deliveredAt: nil, readAt: nil, direction: "outgoing", sessionId: session, attachments: [])
    let responseBody = CloudMessageCodec.agentResponsePrefix + Data(#"{"requestId":"request","text":"Saved answer","deliveryState":"complete"}"#.utf8).base64EncodedString()
    let response = CloudMessageDTO(messageId: "response", fromAccountId: "acct_owner", toAccountId: "acct_owner", body: responseBody, createdAt: "2026-09-01T00:00:01Z", deliveredAt: nil, readAt: nil, direction: "incoming", sessionId: session, attachments: [])
    for messages in [[], [message], [response]] {
        let rows = CloudConversationCatalog.build(account: account, contacts: [], ownedAgents: [], sharedAgents: [], messagesByPeer: ["acct_owner":messages], canonicalConversations: [canonical])
        let row = try #require(rows.first { $0.sessionId == session })
        #expect(row.displayName == (personal ? "My renamed research" : "Saved research title"))
    }
}

@Test
func visibilityPersistsWithTheSameWireCursor() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = CloudWireCache(directory: directory)
    let visibility = CloudSessionVisibility(hiddenSessionIds: ["archived"], deletedSessionIds: ["deleted"], pinnedSessionIds: [], mutedSessionIds: ["muted"], unreadSessionIds: [], pinnedGroupSpaceIds: [])
    await cache.save(accountId: "acct_owner", cursor: "cursor-17", messagesByPeer: [:], visibility: visibility)
    let snapshot = try #require(await cache.load(accountId: "acct_owner"))
    #expect(snapshot.cursor == "cursor-17")
    #expect(snapshot.visibility == visibility)
    #expect(await cache.load(accountId: "acct_other") == nil)
}
