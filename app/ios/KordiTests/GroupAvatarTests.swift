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

    private func conversation(_ id: String, space: String) -> CloudChatConversation {
        CloudChatConversation(id: id, kind: "group", sharedTitle: "Channel", version: 1,
            createdByAccountId: "acct_owner", legacySessionId: id, groupSpaceId: space,
            forkedFromSessionId: nil, forkedFromMessageId: nil, latestMessageSequence: 0,
            createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", members: [],
            preferences: CloudChatPreferences(conversationId: id, accountId: "acct_owner", personalTitle: nil, version: 1))
    }
}
