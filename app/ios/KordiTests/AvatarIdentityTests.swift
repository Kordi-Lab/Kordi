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

    func testAgentIdenticonMatchesTheMacDesktopGenerator() {
        let parts = AgentIdenticonGenerator.parts(seed: "cloud_agent_research")

        XCTAssertEqual(parts.paletteIndex, 0)
        XCTAssertEqual(parts.cells.count, 15)
        XCTAssertEqual(parts.cells[0].x, 0)
        XCTAssertEqual(parts.cells[0].y, 0)
        XCTAssertFalse(parts.cells[0].accent)
        XCTAssertEqual(parts.cells[0].opacity, 0.88462171, accuracy: 0.00000001)
        XCTAssertEqual(parts.cells[1].x, 4)
        XCTAssertEqual(parts.cells.last?.x, 2)
        XCTAssertEqual(parts.cells.last?.y, 4)
        XCTAssertEqual(parts.cells.last?.opacity ?? 0, 0.93623877, accuracy: 0.00000001)
    }

    func testDirectConversationKeepsTheExactProfileImageSource() {
        let avatar = "https://lh3.googleusercontent.com/a/example=s96-c"
        let account = CloudAccount(
            accountId: "acct_me",
            kordiId: "123456789",
            displayName: "Me",
            primaryEmail: "me@example.com",
            avatarUrl: nil,
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
