import XCTest
@testable import Kordi

final class MessageAuthorIdentityTests: XCTestCase {
    private let ownerAvatar = "https://example.test/shu-yang.png"
    private let agentAvatar = "https://example.test/babyshu.png"

    func testOwnedAgentReplyInGroupUsesTheAgentNotTheConversationTitle() {
        let account = makeAccount(defaultAgentName: "babyshu", defaultAgentAvatar: agentAvatar)
        let conversation = makeGroup()
        let targets = ComposerMentionTargetCatalog.targets(
            account: account, conversation: conversation, ownedAgents: [], sharedAgents: []
        )
        let reply = makeMessage(author: .agent, authorName: "babyshu", ownerName: "You")

        let identity = MessageAuthorIdentity.resolve(reply, in: conversation, account: account, mentionTargets: targets)

        XCTAssertEqual(identity.name, "babyshu")
        XCTAssertNotEqual(identity.name, conversation.displayName)
        XCTAssertEqual(identity.source, agentAvatar)
        XCTAssertNotEqual(identity.source, conversation.avatarSource)
        XCTAssertEqual(identity.seed, "cloud-agent:acct_me")
    }

    func testOwnedAgentWithoutConfiguredAvatarUsesTheAgentSeed() {
        let account = makeAccount(defaultAgentName: "babyshu", defaultAgentAvatar: nil)
        let conversation = makeGroup()
        let reply = makeMessage(author: .agent, authorName: "babyshu", ownerName: "You")

        let identity = MessageAuthorIdentity.resolve(reply, in: conversation, account: account, mentionTargets: [
            agentTarget(name: "babyshu", ownerAccountId: "acct_me", ownerName: "Shu Yang", avatar: nil)
        ])

        XCTAssertEqual(identity.name, "babyshu")
        XCTAssertNil(identity.source)
        XCTAssertEqual(identity.seed, "cloud-agent:acct_me")
    }

    func testUnknownAgentKeepsItsOwnNameAndNeverTheGroupPicture() {
        let conversation = makeGroup()
        let reply = makeMessage(author: .agent, authorName: "helper", ownerName: "Maya")

        let identity = MessageAuthorIdentity.resolve(
            reply, in: conversation, account: makeAccount(), mentionTargets: []
        )

        XCTAssertEqual(identity.name, "helper")
        XCTAssertNil(identity.source)
        XCTAssertEqual(identity.seed, "helper")
    }

    func testSameNamedAgentsResolveByOwner() {
        let conversation = makeGroup()
        let targets = [
            agentTarget(name: "Kordi", ownerAccountId: "acct_me", ownerName: "Shu Yang", avatar: "mine"),
            agentTarget(name: "Kordi", ownerAccountId: "acct_maya", ownerName: "Maya", avatar: "maya")
        ]

        let mayas = MessageAuthorIdentity.resolve(
            makeMessage(author: .agent, authorName: "Kordi", ownerName: "Maya"),
            in: conversation, account: makeAccount(), mentionTargets: targets
        )
        let mine = MessageAuthorIdentity.resolve(
            makeMessage(author: .agent, authorName: "Kordi", ownerName: "You"),
            in: conversation, account: makeAccount(), mentionTargets: targets
        )

        XCTAssertEqual(mayas.source, "maya")
        XCTAssertEqual(mayas.seed, "agent_acct_maya")
        XCTAssertEqual(mine.source, "mine")
        XCTAssertEqual(mine.seed, "agent_acct_me")
    }

    func testParticipantAgentProfileIsUsedWhenTheDirectoryHasNoMatch() {
        let conversation = makeGroup(extra: CloudGroupParticipant(
            accountId: "acct_maya", displayName: "Maya", avatarUrl: nil,
            agentId: "cloud_agent_maya", agentDisplayName: "Maya's helper",
            agentAvatarUrl: "maya-agent", role: "member"
        ))

        let identity = MessageAuthorIdentity.resolve(
            makeMessage(author: .agent, authorName: "Maya's helper", ownerName: "Maya"),
            in: conversation, account: makeAccount(), mentionTargets: []
        )

        XCTAssertEqual(identity.name, "Maya's helper")
        XCTAssertEqual(identity.source, "maya-agent")
        XCTAssertEqual(identity.seed, "cloud_agent_maya")
    }

    func testAgentSessionStillUsesTheSessionIdentity() {
        let conversation = ConversationSummary(
            id: "agent:babyshu", kind: .agent, peerAccountId: "acct_me", agentId: "cloud-agent:acct_me",
            ownerDisplayName: "Shu Yang", displayName: "babyshu", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: agentAvatar, agentActivity: nil, sessionId: "session:agent"
        )

        let identity = MessageAuthorIdentity.resolve(
            makeMessage(author: .agent, authorName: "babyshu", ownerName: "You"),
            in: conversation, account: makeAccount(), mentionTargets: []
        )

        XCTAssertEqual(identity.name, "babyshu")
        XCTAssertEqual(identity.source, agentAvatar)
    }

    func testQuotedOwnMessageResolvesToTheOwnersRealAvatar() {
        let account = makeAccount(avatarUpload: ownerAvatar)
        let quoted = makeMessage(author: .me, authorName: "You", ownerName: nil)

        let identity = MessageAuthorIdentity.resolve(quoted, in: makeGroup(), account: account, mentionTargets: [])

        XCTAssertEqual(identity.name, "Shu Yang")
        XCTAssertEqual(identity.source, ownerAvatar)
    }

    func testQuotedParticipantMessageResolvesToTheParticipantAvatar() {
        let quoted = makeMessage(author: .person, authorName: "Maya", ownerName: nil)

        let identity = MessageAuthorIdentity.resolve(quoted, in: makeGroup(), account: makeAccount(), mentionTargets: [])

        XCTAssertEqual(identity.name, "Maya")
        XCTAssertEqual(identity.source, "maya-photo")
        XCTAssertEqual(identity.seed, "acct_maya")
    }

    private func makeAccount(
        defaultAgentName: String? = nil,
        defaultAgentAvatar: String? = nil,
        avatarUpload: String? = nil
    ) -> CloudAccount {
        CloudAccount(
            accountId: "acct_me", kordiId: nil, displayName: "Shu Yang", primaryEmail: nil, avatarUrl: nil,
            avatar: descriptor(type: "human", id: "acct_me", upload: avatarUpload),
            defaultAgent: defaultAgentName.map {
                CloudDefaultAgentProfile(
                    agentId: "cloud-agent:acct_me", displayName: $0, avatarUrl: nil,
                    avatar: descriptor(type: "agent", id: "cloud-agent:acct_me", upload: defaultAgentAvatar)
                )
            },
            nodeId: nil, passwordSet: true
        )
    }

    private func makeGroup(extra: CloudGroupParticipant? = nil) -> ConversationSummary {
        var participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shu Yang", avatarUrl: ownerAvatar, role: "owner"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: "maya-photo", role: "member"),
            CloudGroupParticipant(accountId: "acct_li", displayName: "Li", avatarUrl: nil, role: "member")
        ]
        if let extra { participants[1] = extra }
        return ConversationSummary(
            id: "group:random", kind: .group, peerAccountId: "acct_maya", agentId: nil, ownerDisplayName: nil,
            displayName: "Just for random test", lastMessage: "", lastActivityAt: .distantPast, unreadCount: 0,
            avatarSource: "group-picture", agentActivity: nil, sessionId: "session:group:random",
            groupParticipants: participants
        )
    }

    private func makeMessage(author: MessageAuthor, authorName: String, ownerName: String?) -> ChatMessage {
        ChatMessage(
            id: UUID().uuidString, conversationId: "group:random", author: author, authorName: authorName,
            senderOwnerName: ownerName, text: "Test received", createdAt: .distantPast,
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil
        )
    }

    private func agentTarget(name: String, ownerAccountId: String, ownerName: String, avatar: String?) -> ComposerMentionTarget {
        ComposerMentionTarget(
            id: "agent:\(ownerAccountId)", displayName: name, kind: .agent, accountId: ownerAccountId,
            agentId: avatar == nil ? nil : "agent_\(ownerAccountId)", ownerName: ownerName, avatarSource: avatar
        )
    }

    private func descriptor(type: String, id: String, upload: String?) -> CanonicalAvatarDescriptor {
        CanonicalAvatarDescriptor(
            entityType: type, entityId: id, source: upload == nil ? "generated" : "uploaded",
            style: type == "agent" ? CanonicalAvatarSystem.agentStyle : CanonicalAvatarSystem.humanStyle,
            seed: id, rendererVersion: CanonicalAvatarSystem.rendererVersion, uploadedAsset: upload,
            version: 1, updatedAt: "2026-10-14T00:00:00Z"
        )
    }
}
