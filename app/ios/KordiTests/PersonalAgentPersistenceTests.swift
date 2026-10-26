import Foundation
import Testing
@testable import Kordi

/// Personal sessions after an archive, a relaunch, a first send, and Ask
/// Agent (#2091).
struct PersonalAgentPersistenceTests {
    private typealias Fixture = PersonalAgentTests
    private static let archivedAgentId = "agent_archived"

    private static func catalog(
        ownedAgents: [CloudAgent],
        bindings: [(agentId: String?, sessionId: String)],
        personalAgents: [CloudPersonalAgent]? = nil,
        ownedAgentsLoaded: Bool = true
    ) -> [ConversationSummary] {
        CloudConversationCatalog.build(
            account: Fixture.account, contacts: [], ownedAgents: ownedAgents, sharedAgents: [], messagesByPeer: [:],
            canonicalConversations: bindings.map { Fixture.canonical(agentId: $0.agentId, sessionId: $0.sessionId) },
            personalAgents: personalAgents, ownedAgentsLoaded: ownedAgentsLoaded
        )
    }

    // MARK: Finding 1: archived agents and the authoritative list

    @Test func aBindingToAnArchivedAgentIsAnOrdinaryChat() throws {
        let sessionId = Fixture.sessionId(Self.archivedAgentId)
        let archived = Self.catalog(ownedAgents: [], bindings: [(Self.archivedAgentId, sessionId)])
        #expect(try #require(archived.first { $0.sessionId == sessionId }).personalAgentId == nil)

        // Until the owned agents load, the binding is trusted.
        let unknown = Self.catalog(ownedAgents: [], bindings: [(Self.archivedAgentId, sessionId)], ownedAgentsLoaded: false)
        #expect(try #require(unknown.first { $0.sessionId == sessionId }).personalAgentId == Self.archivedAgentId)

        let research = Fixture.agent(Fixture.researchAgentId, name: "Research agent", description: "Finds papers")
        let researchSession = Fixture.sessionId(Fixture.researchAgentId)
        let active = Self.catalog(ownedAgents: [research], bindings: [(Fixture.researchAgentId, researchSession)])
        #expect(try #require(active.first { $0.sessionId == researchSession }).personalAgentId == Fixture.researchAgentId)
    }

    @Test func aLoadedListOverridesSnapshotBindings() throws {
        let research = Fixture.agent(Fixture.researchAgentId, name: "Research agent", description: "Finds papers")
        let researchSession = Fixture.sessionId(Fixture.researchAgentId)
        let defaultSession = Fixture.sessionId(Fixture.defaultAgentId)
        let list = [CloudPersonalAgent(agentId: Fixture.defaultAgentId, conversationId: "c1", sessionId: defaultSession)]
        let conversations = Self.catalog(
            ownedAgents: [research],
            bindings: [(Fixture.researchAgentId, researchSession), (nil, defaultSession)],
            personalAgents: list
        )
        // Listed without a snapshot binding: personal.
        #expect(try #require(conversations.first { $0.sessionId == defaultSession }).personalAgentId == Fixture.defaultAgentId)
        // Bound in a stale snapshot but missing from the list: ordinary.
        #expect(try #require(conversations.first { $0.sessionId == researchSession }).personalAgentId == nil)

        let rows = PersonalAgentSessionCatalog.rows(conversations: conversations, personalAgents: list, ownAccountId: Fixture.owner)
        #expect(rows.map(\.sessionId) == [defaultSession])
    }

    @Test func aStaleListEntryForAnInactiveAgentShowsNoRow() {
        let archivedSession = Fixture.sessionId(Self.archivedAgentId)
        let regular = Fixture.summary(id: "agent-session:regular", agentId: Self.archivedAgentId,
            name: "Old helper", sessionId: "session:self-agent:regular", personal: false)
        let list = [CloudPersonalAgent(agentId: Self.archivedAgentId, conversationId: "c", sessionId: archivedSession)]
        #expect(PersonalAgentSessionCatalog.rows(
            conversations: [regular], personalAgents: list, ownAccountId: Fixture.owner, activeOwnedAgentIds: []
        ).isEmpty)
        #expect(PersonalAgentSessionCatalog.rows(
            conversations: [regular], personalAgents: list, ownAccountId: Fixture.owner, activeOwnedAgentIds: nil
        ).map(\.sessionId) == [archivedSession])
    }

    // MARK: Finding 2: relaunch

    @Test @MainActor func theConversationCacheKeepsThePersonalTag() throws {
        let sessionId = Fixture.sessionId(Fixture.researchAgentId)
        let personal = Fixture.summary(id: "agent-session:\(sessionId)", agentId: Fixture.researchAgentId,
            name: "Research agent", sessionId: sessionId, personal: true)
        let regular = Fixture.summary(id: "agent-session:regular", agentId: Fixture.researchAgentId,
            name: "Trip", sessionId: "session:self-agent:regular", personal: false)
        let cache = try LocalMessageStore(inMemory: true)
        cache.saveConversations([personal, regular], accountId: Fixture.owner)
        let restored = cache.loadConversations(accountId: Fixture.owner)
        #expect(restored.first { $0.sessionId == sessionId }?.personalAgentId == Fixture.researchAgentId)
        #expect(restored.first { $0.sessionId == regular.sessionId }?.personalAgentId == nil)
        let sections = ChatProjectSections.build(conversations: restored, devices: [], search: "", collapsedForks: [], pinned: [sessionId])
        #expect(!sections.flatMap(\.sessions).contains { $0.conversation.sessionId == sessionId })
    }

    @Test func theAccountSnapshotKeepsThePersonalAgentList() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("personal-agent-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = CloudWireCache(directory: directory)
        let list = [
            CloudPersonalAgent(agentId: Fixture.defaultAgentId, conversationId: "c1",
                sessionId: Fixture.sessionId(Fixture.defaultAgentId), proactive: true),
            CloudPersonalAgent(agentId: Fixture.researchAgentId, conversationId: "c2",
                sessionId: Fixture.sessionId(Fixture.researchAgentId)),
        ]
        await cache.save(accountId: Fixture.owner, cursor: "7", messagesByPeer: [:], personalAgents: list)
        #expect(await cache.load(accountId: Fixture.owner)?.personalAgents == list)
        await cache.save(accountId: Fixture.owner, cursor: "8", messagesByPeer: [:])
        #expect(await cache.load(accountId: Fixture.owner)?.personalAgents == nil)
    }

    // MARK: Finding 4: first send

    @Test func aPersonalSessionIsNeverANewSessionToName() {
        let sessionId = Fixture.sessionId(Fixture.inboxAgentId)
        let placeholder = Fixture.summary(id: "agent-session:\(sessionId)", agentId: Fixture.inboxAgentId,
            name: "Inbox helper", sessionId: sessionId, personal: true)
        let draft = AgentSessionFactory.makeDefault(ownAccountId: Fixture.owner, randomId: "draft")
        #expect(!PersonalAgentSessionCatalog.isNewAgentSession(placeholder, existingSessionIds: []))
        #expect(PersonalAgentSessionCatalog.isNewAgentSession(draft, existingSessionIds: []))
        #expect(!PersonalAgentSessionCatalog.isNewAgentSession(draft, existingSessionIds: [draft.sessionId]))
    }

    // MARK: Finding 5: cached source chips

    @Test @MainActor func cachedMessagesKeepTheirSources() throws {
        let sources = [
            MessageSource(eventId: "cnevt_1", provider: "gmail", title: "Airbnb · Sam"),
            MessageSource(eventId: "cnevt_2", provider: "github", title: "#412 review requested"),
        ]
        let message = ChatMessage(
            id: "outreach-1", conversationId: "agent-session:personal", conversationSequence: 4,
            author: .agent, authorName: "Alex's Kordi", text: "Lab sync moved to 10 am Thursday.",
            createdAt: Date(timeIntervalSince1970: 1_800_000_000), deliveryState: .delivered,
            errorMessage: nil, requestMessageId: "personal_agent_eval_1", sources: sources
        )
        let cache = try LocalMessageStore(inMemory: true)
        cache.saveMessages([message], conversationId: message.conversationId, accountId: Fixture.owner)
        let restored = cache.loadMessages(accountId: Fixture.owner, conversationId: message.conversationId).first
        #expect(restored?.sources == sources)
        // Equal after the round trip, so the next save does not rewrite the row.
        #expect(restored == message)

        var withoutSources = message
        withoutSources.sources = []
        #expect(ConversationTimelineScrollBehavior.hasContentChange(withoutSources, message))
        #expect(!ConversationTimelineScrollBehavior.hasContentChange(message, message))
    }

    // MARK: Finding 6: Ask Agent

    @Test func askAgentNeverDefaultsToAPersonalSession() throws {
        let personalSession = Fixture.sessionId(Fixture.defaultAgentId)
        let personal = Fixture.summary(id: "agent-session:\(personalSession)", agentId: Fixture.defaultAgentId,
            name: "Alex's Kordi", sessionId: personalSession, personal: true)
        let regular = Fixture.summary(id: "agent-session:regular", agentId: Fixture.defaultAgentId,
            name: "Trip to Lisbon", sessionId: "session:self-agent:regular", personal: false, minutesAgo: 90)
        let source = ConversationSummary(
            id: "person:acct_maya", kind: .person, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Maya", displayName: "Maya", lastMessage: "Hi", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:direct-person:acct_maya:acct_owner"
        )
        let suggested = try #require(CompanionPanelCatalog.suggestedConversation(
            for: source, conversations: [personal, regular], ownAccountID: Fixture.owner
        ))
        #expect(suggested.id == regular.id)

        let fresh = try #require(CompanionPanelCatalog.suggestedConversation(
            for: source, conversations: [personal], ownAccountID: Fixture.owner, randomID: "fresh"
        ))
        #expect(fresh.id != personal.id)
        #expect(fresh.personalAgentId == nil)
        #expect(fresh.isLocalDraft)
        // Still selectable from the full list.
        #expect(CompanionPanelCatalog.existingSessions(
            excluding: source, conversations: [personal, regular], ownAccountID: Fixture.owner
        ).contains { $0.id == personal.id })
    }
}
