import UIKit
import XCTest
@testable import Kordi

final class AvatarIdentityTests: XCTestCase {
    func testKordiSupportUsesTheOfficialSupportIdentityFallback() {
        XCTAssertTrue(KordiSupportIdentity.matches(name: "Kordi Support", seed: nil))
        XCTAssertTrue(KordiSupportIdentity.matches(name: nil, seed: "acct_kordi_support"))
        XCTAssertTrue(KordiSupportIdentity.matches(name: nil, seed: "cloud_agent_kordi_support"))
        XCTAssertFalse(KordiSupportIdentity.matches(name: "Zimu", seed: "acct_zimu"))
        XCTAssertTrue(KordiSupportIdentity.isSystemAgentSession(
            "session:direct-system-agent:acct_me:cloud_agent_kordi_support"
        ))
        XCTAssertFalse(KordiSupportIdentity.isSystemAgentSession(
            "session:direct-agent:acct_me:cloud_agent_kordi_support"
        ))
    }

    func testAcceptsRealCloudImageSourcesWithoutConvertingThemToInitials() async throws {
        let remote = "https://lh3.googleusercontent.com/a/example=s96-c"
        XCTAssertEqual(AvatarImageLoader.normalizedSource(remote), remote)

        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        XCTAssertEqual(AvatarImageLoader.normalizedSource(png), png)
        XCTAssertNotNil(try XCTUnwrap(AvatarImageLoader.dataFromImageURL(png)))
        let loadedImage = await AvatarImageLoader.image(from: png)
        XCTAssertNotNil(loadedImage)

        XCTAssertNil(AvatarImageLoader.normalizedSource("kordi-pixel-avatar://legacy-seed"))
        XCTAssertNil(AvatarImageLoader.normalizedSource("file:///private/avatar.png"))
    }

    func testCanonicalAvatarMarkerResolvesToThePinnedKordiRenderer() throws {
        let marker = try XCTUnwrap(CanonicalAvatarSystem.marker(
            style: CanonicalAvatarSystem.humanStyle,
            seed: "acct_123",
            version: 4
        ))
        let parsed = try XCTUnwrap(CanonicalAvatarSystem.marker(from: marker))
        XCTAssertEqual(parsed.style, "lorelei")
        XCTAssertEqual(parsed.seed, "acct_123")
        XCTAssertEqual(parsed.version, 4)

        let renderURL = try XCTUnwrap(CanonicalAvatarSystem.renderURL(
            from: marker,
            baseURL: URL(string: "https://avatars.example")!
        ))
        XCTAssertEqual(
            renderURL.absoluteString,
            "https://avatars.example/v1/avatars/dicebear-rust-10.6.0-styles-10.5.0/lorelei/acct_123.png?v=4"
        )
        XCTAssertNotNil(AvatarImageLoader.normalizedSource(marker))
    }

    func testUploadedAvatarMarkerResolvesToTheCanonicalAssetRoute() throws {
        let marker = "kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef"

        XCTAssertEqual(
            CanonicalAvatarSystem.uploadedMarker(from: marker),
            CanonicalAvatarSystem.UploadedMarker(
                assetId: "ava_0123456789abcdef0123456789abcdef"
            )
        )
        XCTAssertEqual(
            CanonicalAvatarSystem.renderURL(
                from: marker,
                baseURL: URL(string: "https://avatars.example")!
            )?.absoluteString,
            "https://avatars.example/v1/avatars/assets/ava_0123456789abcdef0123456789abcdef/256.jpg"
        )
    }

    func testGeneratedAgentUsesThePinnedThumbsRenderer() throws {
        let seed = CanonicalAvatarSystem.defaultAgentId
        let preview = try XCTUnwrap(CanonicalAvatarSystem.previewURL(
            style: CanonicalAvatarSystem.agentStyle,
            seed: seed,
            baseURL: URL(string: "https://avatars.example")!
        ))
        XCTAssertTrue(preview.absoluteString.contains("/preview/thumbs/"))
    }

    func testDirectConversationKeepsTheExactProfileImageSource() {
        let avatar = "https://lh3.googleusercontent.com/a/example=s96-c"
        let account = CloudAccount(
            accountId: "acct_me",
            kordiId: "123456789",
            displayName: "Me",
            primaryEmail: "me@example.com",
            avatarUrl: nil,
            avatar: testHumanAvatar(entityId: "acct_me"),
            nodeId: nil,
            passwordSet: true
        )
        let contact = CloudContact(
            accountId: "acct_peer",
            kordiId: "987654321",
            displayName: "Peer",
            avatarUrl: avatar,
            nodeId: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [:]
        )

        XCTAssertEqual(catalog.first { $0.kind == .person }?.avatarSource, avatar)
    }

    func testDirectContactMessageAvatarOpensTheCurrentContactProfile() throws {
        let conversation = makePersonConversation(accountId: "acct_maya", displayName: "Maya")
        let message = makePersonMessage(authorName: "Maya", conversationId: conversation.sessionId)

        let destination = try XCTUnwrap(ConversationAuthorProfileResolver.destination(
            currentConversation: conversation,
            message: message,
            selfAccountID: "acct_me",
            contacts: [],
            conversations: [conversation]
        ))

        XCTAssertEqual(destination, conversation)
    }

    func testGroupMemberMessageAvatarOpensTheMemberProfileInsteadOfGroupDetails() throws {
        let conversation = makeGroupConversation(participants: [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(
                accountId: "acct_maya",
                displayName: "Maya",
                avatarUrl: "https://example.com/maya.png",
                role: "member"
            )
        ])
        let message = makePersonMessage(authorName: "Maya", conversationId: conversation.sessionId)

        let destination = try XCTUnwrap(ConversationAuthorProfileResolver.destination(
            currentConversation: conversation,
            message: message,
            selfAccountID: "acct_me",
            contacts: [],
            conversations: [conversation]
        ))

        XCTAssertEqual(destination.kind, .person)
        XCTAssertEqual(destination.peerAccountId, "acct_maya")
        XCTAssertEqual(destination.displayName, "Maya")
        XCTAssertEqual(destination.avatarSource, "https://example.com/maya.png")
        XCTAssertEqual(destination.sessionId, directPersonSessionId("acct_me", "acct_maya"))
        XCTAssertNotEqual(destination.id, conversation.id)
    }

    func testGroupMemberMessageAvatarReusesAnExistingDirectConversation() throws {
        let group = makeGroupConversation(participants: [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "member")
        ])
        let direct = makePersonConversation(accountId: "acct_maya", displayName: "Maya Chen")
        let message = makePersonMessage(authorName: "Maya", conversationId: group.sessionId)

        let destination = try XCTUnwrap(ConversationAuthorProfileResolver.destination(
            currentConversation: group,
            message: message,
            selfAccountID: "acct_me",
            contacts: [],
            conversations: [group, direct]
        ))

        XCTAssertEqual(destination, direct)
    }

    func testGroupMemberMessageAvatarDoesNotGuessBetweenDuplicateNames() {
        let conversation = makeGroupConversation(participants: [
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: "acct_maya_2", displayName: "Maya", avatarUrl: nil, role: "member")
        ])
        let message = makePersonMessage(authorName: "Maya", conversationId: conversation.sessionId)

        XCTAssertNil(ConversationAuthorProfileResolver.destination(
            currentConversation: conversation,
            message: message,
            selfAccountID: "acct_me",
            contacts: [],
            conversations: [conversation]
        ))
    }

    private func makePersonConversation(accountId: String, displayName: String) -> ConversationSummary {
        ConversationSummary(
            id: "person:\(accountId)",
            kind: .person,
            peerAccountId: accountId,
            agentId: nil,
            ownerDisplayName: displayName,
            displayName: displayName,
            lastMessage: "Hello",
            lastActivityAt: Date(timeIntervalSince1970: 1_700_000_000),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: directPersonSessionId("acct_me", accountId)
        )
    }

    private func makeGroupConversation(participants: [CloudGroupParticipant]) -> ConversationSummary {
        ConversationSummary(
            id: "group:design",
            kind: .group,
            peerAccountId: "",
            agentId: nil,
            ownerDisplayName: "Me",
            displayName: "Design group",
            lastMessage: "Hello",
            lastActivityAt: Date(timeIntervalSince1970: 1_700_000_000),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:design",
            groupParticipants: participants
        )
    }

    private func makePersonMessage(authorName: String, conversationId: String) -> ChatMessage {
        ChatMessage(
            id: "message-1",
            conversationId: conversationId,
            author: .person,
            authorName: authorName,
            text: "Hello",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )
    }
}

private func testHumanAvatar(entityId: String) -> CanonicalAvatarDescriptor {
    CanonicalAvatarDescriptor(
        entityType: "human",
        entityId: entityId,
        source: "generated",
        style: CanonicalAvatarSystem.humanStyle,
        seed: entityId,
        rendererVersion: CanonicalAvatarSystem.rendererVersion,
        uploadedAsset: nil,
        version: 1,
        updatedAt: "2026-08-19T00:00:00Z"
    )
}
