import XCTest
@testable import Kordi

final class ComposerMentionTargetCatalogTests: XCTestCase {
    private let account = CloudAccount(
        accountId: "acct_me",
        kordiId: nil,
        displayName: "Me",
        primaryEmail: nil,
        avatarUrl: nil,
        avatar: mentionTestAvatar(entityId: "acct_me"),
        nodeId: nil,
        passwordSet: true
    )

    func testDefaultAgentsNeverReuseTheHumanOwnerAvatar() throws {
        let account = CloudAccount(
            accountId: "acct_me",
            kordiId: nil,
            displayName: "Me",
            primaryEmail: nil,
            avatarUrl: "https://example.com/human.png",
            avatar: mentionTestAvatar(
                entityId: "acct_me",
                source: "uploaded",
                uploadedAsset: "https://example.com/human.png"
            ),
            nodeId: nil,
            passwordSet: true
        )
        let target = try XCTUnwrap(ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation(kind: .person, peerAccountID: "acct_peer"),
            ownedAgents: [],
            sharedAgents: []
        ).first { $0.id == "agent:cloud-agent:acct_me" })

        XCTAssertEqual(target.agentId, "cloud-agent:acct_me")
        XCTAssertNil(target.avatarSource)
    }

    func testDirectConversationIncludesPeerAndOnlyParticipantScopedActiveAgents() {
        let conversation = conversation(
            kind: .person,
            peerAccountID: "acct_peer"
        )
        let ownedAgents = [
            agent(id: "agent_owned", owner: "acct_me", name: "My Helper", ownerName: "Me"),
            agent(
                id: "agent_private",
                owner: "acct_me",
                name: "Private Notes",
                ownerName: "Me",
                accessScope: "private"
            )
        ]
        let sharedAgents = [
            agent(id: "agent_peer", owner: "acct_peer", name: "Peer Helper", ownerName: "Peer"),
            agent(id: "agent_outside", owner: "acct_outside", name: "Outside Helper", ownerName: "Outside"),
            agent(
                id: "agent_archived",
                owner: "acct_peer",
                name: "Archived Helper",
                ownerName: "Peer",
                archivedAt: "2026-08-01T00:00:00Z"
            ),
            agent(
                id: "agent_inactive",
                owner: "acct_peer",
                name: "Inactive Helper",
                ownerName: "Peer",
                status: "archived"
            )
        ]

        let targets = ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation,
            ownedAgents: ownedAgents,
            sharedAgents: sharedAgents
        )

        XCTAssertEqual(
            Set(targets.map(\.id)),
            ["person:acct_peer", "agent:cloud-agent:acct_me", "agent:agent_owned", "agent:agent_peer"]
        )
    }

    func testGroupIncludesEveryMembersAgentsWithoutFiveResultCap() {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_group_only", displayName: "Group Only", avatarUrl: nil, role: "member")
        ]
        let conversation = conversation(
            kind: .group,
            peerAccountID: "acct_group_only",
            participants: participants
        )
        let sharedAgents = (0..<7).map {
            agent(
                id: "agent_group_\($0)",
                owner: "acct_group_only",
                name: "Group Helper \($0)",
                ownerName: "Group Only"
            )
        } + [
            agent(id: "agent_outside", owner: "acct_outside", name: "Outside Helper", ownerName: "Outside")
        ]

        let targets = ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation,
            ownedAgents: [],
            sharedAgents: sharedAgents
        )

        XCTAssertEqual(targets.filter { $0.kind == .agent }.count, 8)
        XCTAssertEqual(targets.filter { $0.kind == .person }.map(\.accountId), ["acct_group_only"])
        XCTAssertFalse(targets.contains { $0.accountId == "acct_outside" })
    }

    func testGroupMemberDefaultAgentUsesSyncedNameAndAvatar() throws {
        let participants = [
            CloudGroupParticipant(
                accountId: "acct_peer",
                displayName: "Peer",
                avatarUrl: nil,
                agentId: "cloud-agent:acct_peer",
                agentDisplayName: "BabyTREE",
                agentAvatarUrl: "https://example.com/babytree.jpg",
                role: "member"
            )
        ]
        let targets = ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation(kind: .group, peerAccountID: "acct_peer", participants: participants),
            ownedAgents: [],
            sharedAgents: [],
            contacts: [contact(accountID: "acct_peer", name: "Peer")]
        )
        let target = try XCTUnwrap(targets.first { $0.agentId == "cloud-agent:acct_peer" })

        XCTAssertEqual(target.displayName, "BabyTREE")
        XCTAssertEqual(target.mentionText, "@BabyTREE")
        XCTAssertEqual(target.avatarSource, "https://example.com/babytree.jpg")
    }

    func testGroupAllTargetCreatesOneHumanBroadcastMention() throws {
        let group = conversation(
            kind: .group,
            peerAccountID: "acct_peer",
            participants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "self"),
                CloudGroupParticipant(accountId: "acct_peer", displayName: "Peer", avatarUrl: nil, role: "member")
            ],
            sessionID: "session:group:triad"
        )
        let targets = ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: group,
            ownedAgents: [],
            sharedAgents: []
        )
        let all = try XCTUnwrap(targets.first)

        XCTAssertEqual(all.kind, .all)
        XCTAssertEqual(all.mentionText, "@all")
        XCTAssertEqual(all.id, "group:session:group:triad")
        XCTAssertFalse(ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation(kind: .person, peerAccountID: "acct_peer"),
            ownedAgents: [],
            sharedAgents: []
        ).contains { $0.kind == .all })

        let mentions = ComposerMentionTargetCatalog.mentions(
            in: "@all please review",
            selectedTarget: all,
            targets: targets
        )
        XCTAssertEqual(mentions.count, 1)
        XCTAssertEqual(mentions.first?.targetIdentityId, "group:session:group:triad")
        XCTAssertEqual(
            ComposerMentionTargetCatalog.accessibilityText(
                in: "@all please review",
                mentions: mentions,
                targets: []
            ),
            "all people in this group mention @all please review"
        )
    }

    func testSameNameAgentsKeepDistinctIdentityAndRequirePickerSelection() throws {
        let conversation = conversation(
            kind: .group,
            peerAccountID: "acct_one",
            participants: [
                CloudGroupParticipant(accountId: "acct_one", displayName: "One", avatarUrl: nil, role: "member"),
                CloudGroupParticipant(accountId: "acct_two", displayName: "Two", avatarUrl: nil, role: "member")
            ]
        )
        let targets = ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation,
            ownedAgents: [],
            sharedAgents: [
                agent(id: "agent_one", owner: "acct_one", name: "Research", ownerName: "One"),
                agent(id: "agent_two", owner: "acct_two", name: "Research", ownerName: "Two")
            ]
        )
        let agents = targets.filter { $0.kind == .agent }

        XCTAssertEqual(
            Set(agents.filter { $0.displayName == "Research" }.map(\.id)),
            ["agent:agent_one", "agent:agent_two"]
        )
        XCTAssertNil(ComposerMentionTargetCatalog.resolvedTarget(
            in: "@Research check this",
            selectedTarget: nil,
            targets: targets
        ))
        let selected = try XCTUnwrap(agents.first { $0.agentId == "agent_two" })
        XCTAssertEqual(
            ComposerMentionTargetCatalog.resolvedTarget(
                in: "@Research check this",
                selectedTarget: selected,
                targets: targets
            )?.agentId,
            "agent_two"
        )
        XCTAssertNil(ComposerMentionTargetCatalog.resolvedTarget(
            in: "@Research check this",
            selectedTarget: selected,
            targets: targets.filter { $0.id != selected.id }
        ))
    }

    func testHighlightSegmentsStyleMentionsWithoutStylingEmailAddresses() {
        let agentTarget = ComposerMentionTarget(
            id: "agent:project_driver",
            displayName: "Project Driver",
            kind: .agent,
            accountId: "acct_peer",
            agentId: "project_driver",
            ownerName: "Peer",
            avatarSource: nil
        )

        let segments = ComposerMentionTargetCatalog.highlightedSegments(
            in: "Email test@example.com. @Shutestbeta1 ask @Project Driver.",
            targets: [agentTarget]
        )

        XCTAssertEqual(
            segments.filter { $0.kind != nil },
            [
                ComposerMentionTextSegment(text: "@Shutestbeta1", kind: .person),
                ComposerMentionTextSegment(text: "@Project Driver", kind: .agent),
            ]
        )
        XCTAssertFalse(segments.contains { $0.text == "@example.com" && $0.kind != nil })
    }

    func testLegacyMyKordiMentionHighlightsCompletelyWithoutMetadataOrCurrentTargets() {
        let segments = ComposerMentionTargetCatalog.highlightedSegments(
            in: "@My Kordi check all my Kordi project worktrees.",
            targets: []
        )

        XCTAssertEqual(segments, [
            ComposerMentionTextSegment(text: "@My Kordi", kind: .agent),
            ComposerMentionTextSegment(text: " check all my Kordi project worktrees.", kind: nil),
        ])
        XCTAssertEqual(
            ComposerMentionTargetCatalog.accessibilityText(
                in: "@My Kordi check all my Kordi project worktrees.",
                targets: []
            ),
            "agent mention @My Kordi check all my Kordi project worktrees."
        )
    }

    func testLegacyStructuredMentionAliasesMatchCaseInsensitively() {
        let mention = MessageMention(
            label: "ProjectDriver",
            targetKind: "agent",
            displayLabel: "Project Driver"
        )

        XCTAssertEqual(
            ComposerMentionTargetCatalog.highlightedSegments(
                in: "@project driver check this.",
                mentions: [mention],
                targets: []
            ).filter { $0.kind != nil }.map(\.text),
            ["@project driver"]
        )
    }

    func testStructuredMentionEntitiesPreserveUnicodeRangesAndIdentityWithoutCurrentTargets() throws {
        let person = ComposerMentionTarget(
            id: "person:acct_alex",
            displayName: "Alex Smith",
            kind: .person,
            accountId: "acct_alex",
            agentId: nil,
            ownerName: "Alex Smith",
            avatarSource: nil
        )
        let agent = ComposerMentionTarget(
            id: "agent:cloud_agent_project",
            displayName: "مشروع 🧭 Kordi",
            kind: .agent,
            accountId: "acct_alex",
            agentId: "cloud_agent_project",
            ownerName: "Alex Smith",
            avatarSource: nil
        )
        let text = "🧭 Ask @Alex Smith and @مشروع 🧭 Kordi, then @Alex Smith."
        let mentions = ComposerMentionTargetCatalog.mentions(
            in: text,
            selectedTarget: agent,
            targets: [person, agent]
        )
        let nsText = text as NSString
        let firstPersonRange = nsText.range(of: person.mentionText)
        let afterFirstPerson = NSMaxRange(firstPersonRange)
        let secondPersonRange = nsText.range(
            of: person.mentionText,
            range: NSRange(
                location: afterFirstPerson,
                length: nsText.length - afterFirstPerson
            )
        )

        XCTAssertEqual(mentions.map(\.targetIdentityId), ["human:acct_alex", agent.id, "human:acct_alex"])
        XCTAssertEqual(
            mentions.map(\.startUtf16),
            [
                firstPersonRange.location,
                nsText.range(of: agent.mentionText).location,
                secondPersonRange.location,
            ]
        )
        let mentionSegments = ComposerMentionTargetCatalog.highlightedSegments(
            in: text,
            mentions: mentions,
            targets: []
        ).filter { $0.kind != nil }
        XCTAssertEqual(
            mentionSegments.map(\.text),
            [person.mentionText, agent.mentionText, person.mentionText]
        )
        XCTAssertEqual(
            mentionSegments.map(\.profileAccountId),
            ["acct_alex", nil, "acct_alex"]
        )

        let source = ChatMessage(
            id: "msg_source",
            conversationId: "session:group",
            author: .person,
            authorName: "Peer",
            text: text,
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            mentions: mentions
        ).actionSource
        XCTAssertEqual(source.mentions?.map(\.targetIdentityId), ["human:acct_alex", agent.id, "human:acct_alex"])
    }

    func testPersonMentionProfileLinksRoundTripCanonicalAccountIdentity() throws {
        let link = try XCTUnwrap(MentionProfileLink.url(for: "acct_alex"))

        XCTAssertEqual(MentionProfileLink.accountID(from: link), "acct_alex")
        XCTAssertNil(MentionProfileLink.url(for: "human:acct_alex"))
        XCTAssertNil(MentionProfileLink.accountID(from: URL(string: "https://example.com/acct_alex")!))
    }

    func testPendingMentionAttentionUsesStablePersonIdentityAndReadCursor() {
        let personMention = MessageMention(
            label: "Alex",
            targetKind: "person",
            targetIdentityId: "human:acct_me"
        )
        let agentMention = MessageMention(
            label: "Research",
            targetKind: "agent",
            targetIdentityId: "agent:research"
        )
        let forwarded = MessageActionMetadata.forward(MessageActionSource(
            sourceSessionId: "source-session",
            sourceMessageId: "source-message",
            senderLabel: "Maya",
            textPreview: "@Alex quoted text",
            attachmentCount: 0
        ))
        let messages = [
            message(id: "read", sequence: 1, author: .person, mentions: [personMention]),
            message(id: "pending", sequence: 2, author: .person, mentions: [personMention, personMention]),
            message(id: "agent", sequence: 3, author: .person, mentions: [agentMention]),
            message(id: "self", sequence: 4, author: .me, mentions: [personMention]),
            message(id: "forwarded", sequence: 5, author: .person, mentions: [personMention], action: forwarded),
        ]

        XCTAssertTrue(personMention.targetsPerson(accountId: "acct_me"))
        XCTAssertFalse(agentMention.targetsPerson(accountId: "acct_me"))
        XCTAssertEqual(
            MentionAttention.pendingMessages(
                in: messages,
                accountId: "acct_me",
                lastReadSequence: 1
            ).map(\.id),
            ["pending"]
        )
    }

    func testPendingAllAttentionRequiresMatchingGroupAndHumanAuthor() {
        let all = MessageMention(
            label: "all",
            targetKind: "all",
            targetIdentityId: "group:session:group:triad",
            startUtf16: 0,
            lengthUtf16: 4,
            displayText: "@all"
        )
        let messages = [
            message(id: "human", sequence: 2, author: .person, mentions: [all, all]),
            message(id: "agent", sequence: 3, author: .agent, mentions: [all]),
            message(
                id: "wrong-group",
                sequence: 4,
                author: .person,
                mentions: [MessageMention(
                    label: "all",
                    targetKind: "all",
                    targetIdentityId: "group:session:group:other",
                    startUtf16: 0,
                    lengthUtf16: 4,
                    displayText: "@all"
                )]
            ),
        ]

        XCTAssertTrue(all.targetsPerson(
            accountId: "acct_me",
            groupSessionId: "session:group:triad"
        ))
        XCTAssertFalse(all.targetsPerson(
            accountId: "acct_me",
            groupSessionId: "session:group:other"
        ))
        XCTAssertFalse(MessageMention(
            label: "all",
            targetKind: "all",
            targetIdentityId: "group:session:group:triad"
        ).targetsPerson(
            accountId: "acct_me",
            groupSessionId: "session:group:triad"
        ))
        XCTAssertEqual(
            MentionAttention.pendingMessages(
                in: messages,
                accountId: "acct_me",
                lastReadSequence: 1,
                groupSessionId: "session:group:triad"
            ).map(\.id),
            ["human"]
        )
    }

    func testDuplicateDisplayNameUsesSelectedStableIdentity() throws {
        let first = ComposerMentionTarget(
            id: "agent:first",
            displayName: "Research",
            kind: .agent,
            accountId: "acct_one",
            agentId: "first",
            ownerName: "One",
            avatarSource: nil
        )
        let second = ComposerMentionTarget(
            id: "agent:second",
            displayName: "Research",
            kind: .agent,
            accountId: "acct_two",
            agentId: "second",
            ownerName: "Two",
            avatarSource: nil
        )

        XCTAssertEqual(
            ComposerMentionTargetCatalog.mentions(
                in: "@Research check this",
                selectedTarget: second,
                targets: [first, second]
            ).map(\.targetIdentityId),
            [second.id]
        )
        XCTAssertTrue(ComposerMentionTargetCatalog.mentions(
            in: "@Research check this",
            selectedTarget: nil,
            targets: [first, second]
        ).isEmpty)
    }

    func testDefaultKordiTargetsMatchMacContactReachability() {
        let conversation = conversation(
            kind: .group,
            peerAccountID: "acct_contact",
            participants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "self"),
                CloudGroupParticipant(accountId: "acct_contact", displayName: "Contact", avatarUrl: nil, role: "member"),
                CloudGroupParticipant(accountId: "acct_group_only", displayName: "Group Only", avatarUrl: nil, role: "member"),
            ]
        )
        let targets = ComposerMentionTargetCatalog.targets(
            account: account,
            conversation: conversation,
            ownedAgents: [],
            sharedAgents: [],
            contacts: [contact(accountID: "acct_contact", name: "Contact")]
        )

        XCTAssertEqual(
            Set(targets.filter { $0.kind == .agent }.map(\.id)),
            ["agent:cloud-agent:acct_me", "agent:cloud-agent:acct_contact"]
        )
        XCTAssertFalse(targets.contains { $0.agentId == "cloud-agent:acct_group_only" })
    }

    func testOwnerIDsIncludeGroupOnlyParticipantsAndRemoveDuplicates() {
        let conversation = conversation(
            kind: .group,
            peerAccountID: "acct_one",
            participants: [
                CloudGroupParticipant(accountId: "acct_one", displayName: "One", avatarUrl: nil, role: "member"),
                CloudGroupParticipant(accountId: "acct_one", displayName: "One", avatarUrl: nil, role: "member"),
                CloudGroupParticipant(accountId: "acct_group_only", displayName: "Group Only", avatarUrl: nil, role: "member")
            ]
        )

        XCTAssertEqual(
            ComposerMentionTargetCatalog.ownerAccountIDs(
                for: conversation,
                currentAccountID: account.accountId
            ),
            ["acct_group_only", "acct_me", "acct_one"]
        )
    }

    func testRefreshReplacesOnlyRequestedOwnersAndRemovesStaleAgents() {
        let outside = agent(
            id: "agent_outside",
            owner: "acct_outside",
            name: "Outside Helper",
            ownerName: "Outside"
        )
        let refreshed = ComposerMentionTargetCatalog.replacingSharedAgents(
            [
                agent(id: "agent_stale", owner: "acct_peer", name: "Stale Helper", ownerName: "Peer"),
                outside,
            ],
            with: [
                agent(id: "agent_current", owner: "acct_peer", name: "Current Helper", ownerName: "Peer")
            ],
            forOwnerAccountIDs: ["acct_peer"]
        )

        XCTAssertEqual(Set(refreshed.map(\.agentId)), ["agent_current", "agent_outside"])
        XCTAssertEqual(
            ComposerMentionTargetCatalog.replacingSharedAgents(
                refreshed,
                with: [],
                forOwnerAccountIDs: ["acct_peer"]
            ).map(\.agentId),
            ["agent_outside"]
        )
    }

    private func message(
        id: String,
        sequence: Int64,
        author: MessageAuthor,
        mentions: [MessageMention],
        action: MessageActionMetadata? = nil
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: "conversation",
            conversationSequence: sequence,
            author: author,
            authorName: author == .me ? "You" : "Maya",
            text: "@Alex please review",
            createdAt: Date(timeIntervalSince1970: TimeInterval(sequence)),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageAction: action,
            mentions: mentions
        )
    }

    private func conversation(
        kind: ConversationKind,
        peerAccountID: String,
        participants: [CloudGroupParticipant] = [],
        sessionID: String = "session"
    ) -> ConversationSummary {
        ConversationSummary(
            id: "conversation",
            kind: kind,
            peerAccountId: peerAccountID,
            agentId: nil,
            ownerDisplayName: nil,
            displayName: "Conversation",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 0),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: sessionID,
            groupParticipants: participants
        )
    }

    private func agent(
        id: String,
        owner: String,
        name: String,
        ownerName: String,
        accessScope: String = "participant_conversations",
        status: String? = nil,
        archivedAt: String? = nil
    ) -> CloudAgent {
        CloudAgent(
            agentId: id,
            ownerAccountId: owner,
            accessScope: accessScope,
            status: status,
            name: name,
            role: "assistant",
            description: nil,
            updatedAt: "2026-08-17T00:00:00Z",
            archivedAt: archivedAt,
            ownerDisplayName: ownerName,
            avatar: mentionTestAgentAvatar(entityId: id)
        )
    }

    private func contact(accountID: String, name: String) -> CloudContact {
        CloudContact(
            accountId: accountID,
            kordiId: nil,
            displayName: name,
            avatarUrl: nil,
            nodeId: nil,
            createdAt: "2026-08-17T00:00:00Z"
        )
    }
}

final class CloudSharedAgentLookupTests: XCTestCase {
    override func setUp() {
        super.setUp()
        SharedAgentsURLProtocol.reset()
    }

    func testSharedAgentLookupBatchesEveryOwnerWithoutDroppingResults() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SharedAgentsURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
        let owners = (0..<101).map { String(format: "acct_%03d", $0) }

        let agents = try await client.listSharedAgents(
            token: "test-session",
            ownerAccountIds: owners
        )
        let batches = SharedAgentsURLProtocol.recordedOwnerBatches()

        XCTAssertEqual(agents.count, owners.count)
        XCTAssertEqual(batches.map(\.count), [50, 50, 1])
        XCTAssertEqual(Set(batches.flatMap { $0 }), Set(owners))
    }
}

private final class SharedAgentsURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var ownerBatches: [[String]] = []

    static func reset() {
        lock.lock()
        ownerBatches = []
        lock.unlock()
    }

    static func recordedOwnerBatches() -> [[String]] {
        lock.lock()
        defer { lock.unlock() }
        return ownerBatches
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let owners = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "ownerAccountIds" })?
            .value?
            .split(separator: ",")
            .map(String.init) ?? []
        Self.lock.lock()
        Self.ownerBatches.append(owners)
        Self.lock.unlock()

        let agents = owners.map { owner in
            [
                "agentId": "agent_\(owner)",
                "ownerAccountId": owner,
                "ownerDisplayName": owner,
                "accessScope": "participant_conversations",
                "name": "Helper \(owner)",
                "role": "assistant",
                "updatedAt": "2026-08-17T00:00:00Z",
                "avatar": [
                    "entityType": "agent",
                    "entityId": "agent_\(owner)",
                    "source": "generated",
                    "style": "thumbs",
                    "seed": "agent_\(owner)",
                    "rendererVersion": CanonicalAvatarSystem.rendererVersion,
                    "uploadedAsset": NSNull(),
                    "version": 1,
                    "updatedAt": "2026-08-17T00:00:00Z"
                ]
            ]
        }
        let payload = try! JSONSerialization.data(withJSONObject: ["agents": agents])
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func mentionTestAvatar(
    entityId: String,
    source: String = "generated",
    uploadedAsset: String? = nil
) -> CanonicalAvatarDescriptor {
    CanonicalAvatarDescriptor(
        entityType: "human",
        entityId: entityId,
        source: source,
        style: CanonicalAvatarSystem.humanStyle,
        seed: entityId,
        rendererVersion: CanonicalAvatarSystem.rendererVersion,
        uploadedAsset: uploadedAsset,
        version: 1,
        updatedAt: "2026-08-19T00:00:00Z"
    )
}

private func mentionTestAgentAvatar(entityId: String) -> CanonicalAvatarDescriptor {
    CanonicalAvatarDescriptor(
        entityType: "agent",
        entityId: entityId,
        source: "generated",
        style: CanonicalAvatarSystem.agentStyle,
        seed: entityId,
        rendererVersion: CanonicalAvatarSystem.rendererVersion,
        uploadedAsset: nil,
        version: 1,
        updatedAt: "2026-08-19T00:00:00Z"
    )
}
