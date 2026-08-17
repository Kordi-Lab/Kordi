import XCTest
@testable import Kordi

final class ComposerMentionTargetCatalogTests: XCTestCase {
    private let account = CloudAccount(
        accountId: "acct_me",
        kordiId: nil,
        displayName: "Me",
        primaryEmail: nil,
        avatarUrl: nil,
        nodeId: nil,
        passwordSet: true
    )

    func testDirectConversationIncludesOnlyParticipantScopedActiveAgents() {
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
            ["agent:cloud-local-agent", "agent:agent_owned", "agent:agent_peer"]
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
            ["agent:cloud-local-agent", "agent:cloud-agent:acct_contact"]
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

    private func conversation(
        kind: ConversationKind,
        peerAccountID: String,
        participants: [CloudGroupParticipant] = []
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
            sessionId: "session",
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
            ownerDisplayName: ownerName
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
                "updatedAt": "2026-08-17T00:00:00Z"
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
