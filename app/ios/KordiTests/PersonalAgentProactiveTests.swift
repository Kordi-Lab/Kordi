import Foundation
import Testing
@testable import Kordi

/// Only agents with Proactive on have a personal session (#2091). Turning it
/// off returns the session to Recents as an ordinary agent chat.
struct PersonalAgentProactiveTests {
    private typealias Fixture = PersonalAgentTests
    private static let researchSession = Fixture.sessionId(Fixture.researchAgentId)
    private static let research = Fixture.agent(Fixture.researchAgentId, name: "Research agent", description: "Finds papers")
    private static let listed = [
        CloudPersonalAgent(agentId: Fixture.researchAgentId, conversationId: "c2", sessionId: researchSession, proactive: true),
    ]

    private static func catalog(marked: Bool, personalAgents: [CloudPersonalAgent]?) throws -> [ConversationSummary] {
        let body = try Fixture.agentResponseBody(text: "Two new papers cite your draft.", sources: [])
        return CloudConversationCatalog.build(
            account: Fixture.account, contacts: [], ownedAgents: [research], sharedAgents: [],
            messagesByPeer: [Fixture.owner: [Fixture.outreach(body: body, sessionId: researchSession)]],
            canonicalConversations: [
                Fixture.canonical(agentId: marked ? Fixture.researchAgentId : nil, sessionId: researchSession, sequence: 1),
            ],
            personalAgents: personalAgents
        )
    }

    private static func inRecents(_ conversations: [ConversationSummary]) -> Bool {
        ChatProjectSections.build(conversations: conversations, devices: [], search: "", collapsedForks: [], pinned: [])
            .first { $0.id == "recents" }?.sessions.contains { $0.conversation.sessionId == researchSession } == true
    }

    private static func row(_ conversations: [ConversationSummary], list: [CloudPersonalAgent]?) -> Bool {
        PersonalAgentSessionCatalog.rows(conversations: conversations, personalAgents: list, ownAccountId: Fixture.owner)
            .contains { $0.sessionId == researchSession }
    }

    // MARK: Item 1: dropping out of the list

    @Test func proactiveOnShowsThePersonalRow() throws {
        let conversations = try Self.catalog(marked: true, personalAgents: Self.listed)
        let session = try #require(conversations.first { $0.sessionId == Self.researchSession })
        #expect(session.personalAgentId == Fixture.researchAgentId)
        #expect(Self.row(conversations, list: Self.listed))
        #expect(!Self.inRecents(conversations))
    }

    @Test func aSnapshotWithoutTheMarkerReturnsTheSessionToRecents() throws {
        // The Mac turned Proactive off; this device still holds the old list.
        let conversations = try Self.catalog(marked: false, personalAgents: Self.listed)
        let session = try #require(conversations.first { $0.sessionId == Self.researchSession })
        #expect(session.personalAgentId == nil)
        #expect(Self.inRecents(conversations))
        // No placeholder duplicates the ordinary chat under Personal agent.
        #expect(!Self.row(conversations, list: Self.listed))
        // It sends and can be archived like any existing agent chat.
        #expect(!PersonalAgentSessionCatalog.isNewAgentSession(session, existingSessionIds: [session.sessionId]))
        #expect(PersonalAgentPresentation.headerStatus(for: session, activity: .ready, fallback: "Ready") == "Ready")
        #expect(!ConversationHeaderTrailingLabel.hidesSharedBackground(for: session))
    }

    @Test func aLoadedListWithoutTheAgentReturnsTheSessionToRecents() throws {
        let conversations = try Self.catalog(marked: true, personalAgents: [])
        #expect(try #require(conversations.first { $0.sessionId == Self.researchSession }).personalAgentId == nil)
        #expect(Self.inRecents(conversations))
        #expect(!Self.row(conversations, list: []))
    }

    @Test @MainActor func archivingAFormerPersonalSessionIsAllowed() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try #require(model.conversations.first { $0.kind == .agent && !$0.isAgentLaunchTemplate })
        #expect(conversation.personalAgentId == nil)
        #expect(await model.archiveConversation(conversation))
    }

    @Test @MainActor func relaunchDoesNotRestoreAStalePersonalRow() async throws {
        let tagged = try #require(try Self.catalog(marked: true, personalAgents: Self.listed)
            .first { $0.sessionId == Self.researchSession })
        let untagged = try #require(try Self.catalog(marked: false, personalAgents: [])
            .first { $0.sessionId == Self.researchSession })

        let store = try LocalMessageStore(inMemory: true)
        store.saveConversations([tagged], accountId: Fixture.owner)
        store.saveConversations([untagged], accountId: Fixture.owner)
        let restored = store.loadConversations(accountId: Fixture.owner)
        #expect(restored.first { $0.sessionId == Self.researchSession }?.personalAgentId == nil)

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("personal-agent-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let snapshots = CloudWireCache(directory: directory)
        await snapshots.save(accountId: Fixture.owner, cursor: "1", messagesByPeer: [:], personalAgents: Self.listed)
        await snapshots.save(accountId: Fixture.owner, cursor: "2", messagesByPeer: [:], personalAgents: [])
        let restoredList = await snapshots.load(accountId: Fixture.owner)?.personalAgents
        #expect(restoredList == [])

        #expect(!Self.row(restored, list: restoredList))
        #expect(Self.inRecents(restored))
        // A list saved before the change still finds the session ordinary.
        #expect(!Self.row(restored, list: Self.listed))
    }

    // MARK: Item 2: following changes made on the Mac

    private static func event(_ type: String, sessionId: String) -> CloudSyncEvent {
        CloudSyncEvent(
            eventId: "event-\(type)-\(sessionId)", eventType: type, peerAccountId: nil, messageId: nil,
            payload: CloudSyncEventPayload(
                message: nil, messageIds: nil, messageId: nil, readAt: nil, sessionId: sessionId,
                scope: nil, updatedAt: nil, forkSessionId: nil, parentSessionId: nil, parentMessageId: nil,
                createdByAccountId: nil, createdAt: nil,
                sessionTitle: type == "session.title.updated" ? CloudSyncedSessionTitle(sessionId: sessionId, title: "") : nil,
                deviceId: nil, call: nil
            ),
            occurredAt: "2026-10-25T10:00:00Z"
        )
    }

    @Test func personalSessionIdsCoverTheListTheTagsAndNewMarkers() {
        let defaultSession = Fixture.sessionId(Fixture.defaultAgentId)
        let inboxSession = Fixture.sessionId(Fixture.inboxAgentId)
        let tagged = Fixture.summary(id: "agent-session:\(defaultSession)", agentId: Fixture.defaultAgentId,
            name: "Alex's Kordi", sessionId: defaultSession, personal: true)
        let regular = Fixture.summary(id: "agent-session:regular", agentId: Fixture.defaultAgentId,
            name: "Trip", sessionId: "session:self-agent:regular", personal: false)
        let ids = PersonalAgentSessionCatalog.personalSessionIds(
            personalAgents: Self.listed,
            conversations: [tagged, regular],
            canonical: [
                Fixture.canonical(agentId: Fixture.inboxAgentId, sessionId: inboxSession),
                Fixture.canonical(agentId: nil, sessionId: "session:self-agent:regular"),
            ]
        )
        #expect(ids == [Self.researchSession, defaultSession, inboxSession])
        #expect(PersonalAgentSessionCatalog.personalSessionIds(personalAgents: nil, conversations: [], canonical: []).isEmpty)
    }

    @Test func onlyConversationChangesToPersonalSessionsReloadTheList() {
        let ids: Set<String> = [Self.researchSession]
        #expect(PersonalAgentSessionCatalog.eventsTouchPersonalSession(
            [Self.event("session.title.updated", sessionId: Self.researchSession)], personalSessionIds: ids))
        #expect(!PersonalAgentSessionCatalog.eventsTouchPersonalSession(
            [Self.event("session.title.updated", sessionId: "session:self-agent:regular")], personalSessionIds: ids))
        #expect(!PersonalAgentSessionCatalog.eventsTouchPersonalSession(
            [Self.event("message.upsert", sessionId: Self.researchSession)], personalSessionIds: ids))
        #expect(!PersonalAgentSessionCatalog.eventsTouchPersonalSession([], personalSessionIds: ids))
    }
}
