import XCTest
@testable import Kordi

final class GroupAvatarTests: XCTestCase {
    private let image = "kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef"

    func testAvatarRemovalSurvivesCodecRoundTrip() throws {
        let actor = CloudGroupParticipant(accountId: "acct_owner", displayName: "Owner", avatarUrl: nil, role: "admin")
        let envelope = CloudGroupControlEnvelope(kind: "group-avatar-update", groupId: "session:group:main",
            groupSpaceId: "shared", groupTitle: "Team", groupAvatar: CloudGroupAvatar(imageUrl: nil, updatedAtMs: 1000.5),
            createdByAccountId: actor.accountId, actor: actor, participants: [actor], message: nil)
        let encoded = try CloudGroupMessageCodec.encode(envelope)
        let decoded = try XCTUnwrap(CloudGroupMessageCodec.parse(encoded))
        XCTAssertEqual(decoded.groupAvatar?.updatedAtMs, 1000)
        XCTAssertNil(decoded.groupAvatar?.imageUrl)
        XCTAssertNotNil(decoded.groupAvatar)
    }

    func testInvalidReferencesAndRevisionsAreRejected() {
        for raw in [
            "{\"imageUrl\":\"data:image/png;base64,AA==\",\"updatedAtMs\":1000}",
            "{\"imageUrl\":\"https://example.test/avatar.png\",\"updatedAtMs\":1000}",
            "{\"imageUrl\":null,\"updatedAtMs\":-1}"
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(CloudGroupAvatar.self, from: Data(raw.utf8)))
        }
    }

    func testAnEnvelopeWithAnInvalidImageKeepsEverythingElse() throws {
        let raw = """
        {"kind":"group-message","groupId":"session:group:main","groupSpaceId":"shared",\
        "groupTitle":"Team","groupAvatar":{"imageUrl":"https://example.test/avatar.png","updatedAtMs":1000},\
        "createdByAccountId":"acct_owner","actor":{"accountId":"acct_owner","displayName":"Owner"},\
        "participants":[]}
        """
        let envelope = try JSONDecoder().decode(CloudGroupControlEnvelope.self, from: Data(raw.utf8))
        XCTAssertNil(envelope.groupAvatar)
        XCTAssertEqual(envelope.groupTitle, "Team")
        XCTAssertEqual(envelope.groupSpaceId, "shared")
    }

    func testAConversationWithAnUnusableImageStillLoads() throws {
        let root = conversation("root", space: "shared")
        let valid = try bootstrap(root, image: image)
        XCTAssertEqual(valid.conversations.first?.groupAvatar?.imageUrl, image)
        for unusable in [
            " \(image)", "\(image)\n", "\(image)?x", "\(image)#x",
            "kordi-avatar://uploaded:80/ava_0123456789abcdef0123456789abcdef",
            "kordi-avatar://user@uploaded/ava_0123456789abcdef0123456789abcdef",
            "kordi-avatar://uploaded/ava_0123456789ABCDEF0123456789ABCDEF",
            "https://example.test/avatar.png"
        ] {
            let decoded = try bootstrap(root, image: unusable)
            XCTAssertEqual(decoded.conversations.map(\.id), ["root"], unusable)
            XCTAssertNil(decoded.conversations.first?.groupAvatar, unusable)
            XCTAssertEqual(decoded.conversations.first?.groupSpaceId, "shared", unusable)
            XCTAssertEqual(decoded.conversations.first?.groupTitle, "Team", unusable)
        }
    }

    func testAllChannelsUseTheLatestImageAndRespectRemoval() {
        var root = conversation("root", space: "shared")
        var child = conversation("child", space: "group:shared")
        root.groupAvatar = CloudGroupAvatar(imageUrl: image, updatedAtMs: 10)
        XCTAssertEqual(GroupAvatarCatalog.imageSource(groupSpaceId: "shared", canonical: [root, child], controls: []), image)
        child.groupAvatar = CloudGroupAvatar(imageUrl: nil, updatedAtMs: 20)
        XCTAssertNil(GroupAvatarCatalog.imageSource(groupSpaceId: "shared", canonical: [root, child], controls: []))
        XCTAssertNil(GroupAvatarCatalog.imageSource(groupSpaceId: "shared", canonical: [child, root], controls: []))
        XCTAssertNil(GroupAvatarCatalog.imageSource(groupSpaceId: "another", canonical: [root], controls: []))
    }

    /// A bootstrap whose only conversation carries `image` as its group image.
    private func bootstrap(_ conversation: CloudChatConversation, image: String) throws -> CloudChatBootstrapResponse {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(conversation)) as? [String: Any]
        )
        object["group_avatar"] = ["imageUrl": image, "updatedAtMs": 10]
        let response: [String: Any] = [
            "protocol_version": 1, "conversations": [object], "latest_messages": [],
            "next_cursor": "cursor", "last_stream_seq": 0, "server_time": "2026-09-01T00:00:00Z"
        ]
        return try JSONDecoder().decode(
            CloudChatBootstrapResponse.self,
            from: JSONSerialization.data(withJSONObject: response)
        )
    }

    private func conversation(_ id: String, space: String) -> CloudChatConversation {
        CloudChatConversation(id: id, kind: "group", sharedTitle: "Channel", version: 1,
            createdByAccountId: "acct_owner", legacySessionId: id, groupSpaceId: space, groupTitle: "Team",
            forkedFromSessionId: nil, forkedFromMessageId: nil, latestMessageSequence: 0,
            createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", members: [],
            preferences: CloudChatPreferences(conversationId: id, accountId: "acct_owner", personalTitle: nil, version: 1))
    }
}
