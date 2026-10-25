import Foundation
import Testing
@testable import Kordi

struct PersonalAgentTests {
    private static let owner = "acct_owner"
    private static let defaultAgentId = "cloud-agent:acct_owner"
    private static let researchAgentId = "agent_research"
    private static let inboxAgentId = "agent_inbox"

    private static let avatar = CanonicalAvatarDescriptor(
        entityType: "agent", entityId: defaultAgentId, source: "generated",
        style: CanonicalAvatarSystem.agentStyle, seed: "personal-agent",
        rendererVersion: CanonicalAvatarSystem.rendererVersion, uploadedAsset: nil,
        version: 1, updatedAt: "2026-10-25T00:00:00Z"
    )

    private static var account: CloudAccount {
        var account = CloudAccount(accountId: owner, kordiId: nil, displayName: "Alex", primaryEmail: nil,
            avatarUrl: nil, avatar: avatar, nodeId: nil, passwordSet: true)
        account.defaultAgent = CloudDefaultAgentProfile(
            agentId: defaultAgentId, displayName: "Kordi", avatarUrl: nil, avatar: avatar
        )
        return account
    }

    private static func agent(_ id: String, name: String, description: String) -> CloudAgent {
        CloudAgent(agentId: id, ownerAccountId: owner, accessScope: "private", status: "active",
            name: name, role: "Assistant", description: description,
            updatedAt: "2026-10-20T00:00:00Z", ownerDisplayName: "Alex", avatar: avatar)
    }

    private static func sessionId(_ agentId: String) -> String {
        "session:self-agent:\(owner):personal:\(agentId)"
    }

    private static func canonical(agentId: String?, sessionId: String, sequence: Int64 = 0) -> CloudChatConversation {
        var conversation = CloudChatConversation(
            id: "conv-\(sessionId)", kind: "ai", sharedTitle: nil, version: 1,
            createdByAccountId: owner, legacySessionId: sessionId,
            forkedFromSessionId: nil, forkedFromMessageId: nil, latestMessageSequence: sequence,
            createdAt: "2026-10-25T08:00:00Z", updatedAt: "2026-10-25T08:00:00Z",
            members: [CloudChatMember(accountId: owner, displayName: "Alex", avatarUrl: nil,
                defaultAgentId: nil, defaultAgentDisplayName: nil, defaultAgentAvatarUrl: nil,
                role: "owner", membershipState: "active", version: 1, lastDeliveredSequence: sequence,
                lastReadSequence: 0, joinedAt: "2026-10-25T08:00:00Z", leftAt: nil)],
            preferences: CloudChatPreferences(conversationId: "conv-\(sessionId)", accountId: owner,
                personalTitle: nil, version: 1)
        )
        conversation.personalAgent = agentId.map(CloudPersonalAgentBinding.init(agentId:))
        return conversation
    }

    private static func agentResponseBody(text: String, sources: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "agent-response",
            "requestId": "personal_agent_eval_1",
            "text": text,
            "deliveryState": "complete",
            "sources": sources,
        ])
        return CloudMessageCodec.agentResponsePrefix + data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func outreach(body: String, sessionId: String) -> CloudMessageDTO {
        CloudMessageDTO(messageId: "outreach-1", fromAccountId: owner, toAccountId: owner,
            body: body, createdAt: "2026-10-25T09:00:00Z", deliveredAt: nil, readAt: nil,
            direction: "incoming", sessionId: sessionId, attachments: [], conversationSequence: 1)
    }

    private static func summary(
        id: String, agentId: String, name: String, sessionId: String,
        personal: Bool, minutesAgo: Double = 0
    ) -> ConversationSummary {
        var conversation = ConversationSummary(
            id: id, kind: .agent, peerAccountId: owner, agentId: agentId, ownerDisplayName: "Alex",
            displayName: name, lastMessage: "Latest", lastActivityAt: Date(timeIntervalSince1970: 1_800_000_000 - minutesAgo * 60),
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: sessionId,
            agentDisplayName: name, messageCount: 1
        )
        if personal { conversation.personalAgentId = agentId }
        return conversation
    }

    // MARK: Decoding

    @Test func decodesPersonalAgentList() throws {
        let json = Data("""
        {"agents":[
          {"agentId":"cloud-agent:acct_owner","conversationId":"c1","sessionId":"s1","proactive":true},
          {"agentId":"agent_research","conversationId":"c2","sessionId":"s2"}
        ]}
        """.utf8)
        let agents = try JSONDecoder().decode(CloudPersonalAgentsResponse.self, from: json).agents
        #expect(agents.map(\.agentId) == [Self.defaultAgentId, Self.researchAgentId])
        #expect(agents.map(\.proactive) == [true, false])
        #expect(agents[1].sessionId == "s2")
        #expect(agents[1].conversationId == "c2")
    }

    @Test func decodesThePersonalAgentBindingOfAConversationSnapshot() throws {
        let unbound = Self.canonical(agentId: nil, sessionId: "session:self-agent:plain")
        var object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(unbound)) as? [String: Any]
        )
        #expect(!object.keys.contains("personal_agent"))
        #expect(try JSONDecoder().decode(CloudChatConversation.self, from: JSONEncoder().encode(unbound)).personalAgentId == nil)

        object["personal_agent"] = ["agent_id": Self.researchAgentId]
        let bound = try JSONDecoder().decode(
            CloudChatConversation.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        #expect(bound.personalAgentId == Self.researchAgentId)
        let roundTrip = try JSONDecoder().decode(CloudChatConversation.self, from: JSONEncoder().encode(bound))
        #expect(roundTrip.personalAgentId == Self.researchAgentId)
    }

    @Test func decodesSourcesAndDropsUnreadableEntries() throws {
        let body = try Self.agentResponseBody(text: "Sam asked about a 1 pm check-in.", sources: [
            ["eventId": "cnevt_1", "provider": "gmail", "title": "Airbnb · Sam"],
            ["provider": "slack", "title": "No event"],
            "not a source",
            ["eventId": "cnevt_2", "provider": "github", "title": "#412 review requested"],
            ["eventId": "cnevt_1", "provider": "gmail", "title": "Duplicate"],
            ["eventId": "cnevt_3", "provider": "google_calendar"],
        ])
        #expect(CloudMessageCodec.displayText(body) == "Sam asked about a 1 pm check-in.")
        let sources = CloudMessageCodec.agentResponseSources(body)
        #expect(sources.map(\.eventId) == ["cnevt_1", "cnevt_2", "cnevt_3"])
        #expect(sources.map(\.title) == ["Airbnb · Sam", "#412 review requested", ""])

        let malformed = try Self.agentResponseBody(text: "Still readable", sources: "nope")
        #expect(CloudMessageCodec.displayText(malformed) == "Still readable")
        #expect(CloudMessageCodec.agentResponseSources(malformed).isEmpty)
    }

    @Test func projectedAgentMessagesCarrySourcesThroughTheCache() throws {
        let sessionId = Self.sessionId(Self.researchAgentId)
        let body = try Self.agentResponseBody(text: "Two new papers cite your draft.", sources: [
            ["eventId": "cnevt_9", "provider": "gmail", "title": "Scholar alert"],
        ])
        let conversation = Self.summary(id: "agent-session:\(sessionId)", agentId: Self.researchAgentId,
            name: "Research agent", sessionId: sessionId, personal: true)
        let messages = CloudDirectMessageProjector.project(
            [Self.outreach(body: body, sessionId: sessionId)],
            conversation: conversation,
            ownAccountId: Self.owner
        )
        let message = try #require(messages.first)
        #expect(message.author == .agent)
        #expect(message.sources == [MessageSource(eventId: "cnevt_9", provider: "gmail", title: "Scholar alert")])

        let cached = try JSONDecoder().decode([ChatMessage].self, from: JSONEncoder().encode(messages))
        #expect(cached.first?.sources == message.sources)
    }

    // MARK: Catalog and sections

    @Test func catalogTagsPersonalSessionsAndKeepsLaunchTemplates() throws {
        let defaultSession = Self.sessionId(Self.defaultAgentId)
        let researchSession = Self.sessionId(Self.researchAgentId)
        let body = try Self.agentResponseBody(text: "Two new papers cite your draft.", sources: [
            ["eventId": "cnevt_9", "provider": "gmail", "title": "Scholar alert"],
        ])
        let catalog = CloudConversationCatalog.build(
            account: Self.account,
            contacts: [],
            ownedAgents: [Self.agent(Self.researchAgentId, name: "Research agent", description: "Finds papers")],
            sharedAgents: [],
            messagesByPeer: [Self.owner: [Self.outreach(body: body, sessionId: researchSession)]],
            canonicalConversations: [
                Self.canonical(agentId: Self.defaultAgentId, sessionId: defaultSession),
                Self.canonical(agentId: Self.researchAgentId, sessionId: researchSession, sequence: 1),
            ]
        )

        let kordi = try #require(catalog.first { $0.sessionId == defaultSession })
        #expect(kordi.personalAgentId == Self.defaultAgentId)
        #expect(kordi.agentId == Self.defaultAgentId)
        #expect(kordi.displayName == "Alex's Kordi")
        #expect(PersonalAgentSessionCatalog.preview(of: kordi) == "No messages yet")

        let research = try #require(catalog.first { $0.sessionId == researchSession })
        #expect(research.personalAgentId == Self.researchAgentId)
        #expect(research.agentId == Self.researchAgentId)
        #expect(research.displayName == "Research agent")
        #expect(research.lastMessage == "Two new papers cite your draft.")

        // Launch templates stay, so New session still lists both agents.
        #expect(catalog.contains { $0.id == "agent-template:\(defaultSelfAgentSessionId(Self.owner))" })
        #expect(catalog.contains { $0.isAgentLaunchTemplate && $0.agentId == Self.researchAgentId })

        let sections = ChatProjectSections.build(
            conversations: catalog, devices: [], search: "", collapsedForks: [],
            pinned: [defaultSession, researchSession]
        )
        #expect(!sections.flatMap(\.sessions).contains { $0.conversation.personalAgentId != nil })

        let rows = PersonalAgentSessionCatalog.rows(conversations: catalog, personalAgents: [], ownAccountId: Self.owner)
        #expect(rows.map(\.sessionId) == [defaultSession, researchSession])
    }

    @Test func rowsFollowServerOrderAndFillSessionsThatHaveNotSynced() {
        let defaultSession = Self.sessionId(Self.defaultAgentId)
        let researchSession = Self.sessionId(Self.researchAgentId)
        let inboxSession = Self.sessionId(Self.inboxAgentId)
        let conversations = [
            Self.summary(id: "agent-session:\(researchSession)", agentId: Self.researchAgentId,
                name: "Research agent", sessionId: researchSession, personal: true),
            Self.summary(id: "agent-session:\(defaultSession)", agentId: Self.defaultAgentId,
                name: "Alex's Kordi", sessionId: defaultSession, personal: true, minutesAgo: 30),
            Self.summary(id: "agent-template:session:self-agent:\(Self.inboxAgentId)", agentId: Self.inboxAgentId,
                name: "Inbox helper", sessionId: "session:self-agent:\(Self.inboxAgentId)", personal: false),
            Self.summary(id: "agent-session:regular", agentId: Self.researchAgentId,
                name: "Trip to Lisbon", sessionId: "session:self-agent:regular", personal: false),
        ]
        let personalAgents = [
            CloudPersonalAgent(agentId: Self.defaultAgentId, conversationId: "c1", sessionId: defaultSession),
            CloudPersonalAgent(agentId: Self.researchAgentId, conversationId: "c2", sessionId: researchSession),
            CloudPersonalAgent(agentId: Self.inboxAgentId, conversationId: "c3", sessionId: inboxSession),
            CloudPersonalAgent(agentId: "agent_unknown", conversationId: "c4", sessionId: Self.sessionId("agent_unknown")),
        ]

        let rows = PersonalAgentSessionCatalog.rows(
            conversations: conversations, personalAgents: personalAgents, ownAccountId: Self.owner
        )
        #expect(rows.map(\.sessionId) == [defaultSession, researchSession, inboxSession])
        let inbox = rows[2]
        #expect(inbox.id == "agent-session:\(inboxSession)")
        #expect(inbox.personalAgentId == Self.inboxAgentId)
        #expect(PersonalAgentSessionCatalog.name(of: inbox) == "Inbox helper")
        #expect(PersonalAgentSessionCatalog.preview(of: inbox) == "No messages yet")

        let searched = PersonalAgentSessionCatalog.rows(
            conversations: conversations, personalAgents: personalAgents,
            ownAccountId: Self.owner, searchText: "research"
        )
        #expect(searched.map(\.sessionId) == [researchSession])

        // Without the list, the default agent still comes first.
        let unlisted = PersonalAgentSessionCatalog.rows(
            conversations: conversations, personalAgents: [], ownAccountId: Self.owner
        )
        #expect(unlisted.map(\.sessionId) == [defaultSession, researchSession])
        #expect(PersonalAgentSessionCatalog.rows(conversations: conversations, personalAgents: personalAgents, ownAccountId: "").isEmpty)
    }

    // MARK: Menu, header, and chips

    @Test func rowMenuOffersReadStateAndMuteOnly() {
        #expect(PersonalAgentRowAction.available(isUnread: true, isMuted: false) == [.markRead, .mute])
        #expect(PersonalAgentRowAction.available(isUnread: false, isMuted: true) == [.markUnread, .unmute])
        let titles = PersonalAgentRowAction.allCases.map(\.title)
        #expect(titles == ["Mark as read", "Mark as unread", "Mute", "Unmute"])
        for forbidden in ["Rename", "Pin", "Move to project", "Archive", "Delete"] {
            #expect(!titles.contains { $0.localizedCaseInsensitiveContains(forbidden) })
        }
    }

    @Test @MainActor func personalSessionsAreNeverArchivedOrDeleted() async throws {
        let model = AppModel(previewMode: true)
        var conversation = try #require(model.conversations.first { $0.kind == .agent && !$0.isAgentLaunchTemplate })
        conversation.personalAgentId = conversation.agentId
        #expect(await model.archiveConversation(conversation) == false)
        #expect(await model.deleteConversation(conversation) == false)
        #expect(model.conversations.contains { $0.sessionId == conversation.sessionId })
    }

    @Test func headerShowsOnlineUnlessTheAgentIsWorking() {
        let personal = Self.summary(id: "p", agentId: Self.defaultAgentId, name: "Alex's Kordi",
            sessionId: Self.sessionId(Self.defaultAgentId), personal: true)
        let regular = Self.summary(id: "r", agentId: Self.defaultAgentId, name: "Task",
            sessionId: "session:self-agent:task", personal: false)
        #expect(PersonalAgentPresentation.headerStatus(for: personal, activity: .ready, fallback: "Ready") == "Online")
        #expect(PersonalAgentPresentation.headerStatus(for: personal, activity: .replying, fallback: "Replying") == "Replying")
        #expect(PersonalAgentPresentation.headerStatus(for: regular, activity: .ready, fallback: "Ready") == "Ready")
    }

    @Test func chipLabelsNameKnownProvidersAndCapitalizeOthers() {
        #expect(MessageSourcePresentation.providerName("gmail") == "Gmail")
        #expect(MessageSourcePresentation.providerName("google_calendar") == "Calendar")
        #expect(MessageSourcePresentation.providerName("GitHub") == "GitHub")
        #expect(MessageSourcePresentation.providerName("slack") == "Slack")
        #expect(MessageSourcePresentation.providerName("outlook") == "Outlook")
        #expect(MessageSourcePresentation.providerName("mac_contacts") == "Mac contacts")
        #expect(MessageSourcePresentation.providerName("  ") == "Source")
        #expect(MessageSourcePresentation.systemImage("gmail") == "envelope")
        #expect(MessageSourcePresentation.systemImage("mac_calendar") == "calendar")
        #expect(MessageSourcePresentation.systemImage("github") == "arrow.triangle.pull")
        #expect(MessageSourcePresentation.systemImage("slack") == "number")
        #expect(MessageSourcePresentation.systemImage("linear") == "link")
        #expect(MessageSourcePresentation.accessibilityLabel(
            MessageSource(eventId: "e", provider: "gmail", title: "Airbnb · Sam")
        ) == "Gmail, Airbnb · Sam")
        #expect(MessageSourcePresentation.accessibilityLabel(
            MessageSource(eventId: "e", provider: "slack", title: "")
        ) == "Slack")
    }
}
