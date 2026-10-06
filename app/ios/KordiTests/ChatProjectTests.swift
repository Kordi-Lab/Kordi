import Testing
@testable import Kordi

struct ChatProjectTests {
    @Test @MainActor func staleProjectCatalogDoesNotRestoreDeletedOrArchivedChats() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try #require(model.conversations.first { $0.kind == .agent && !$0.isAgentLaunchTemplate })
        let emptySessionID = "empty-project-session"
        model.projectDevices = [.init(id: "mac", name: "My Mac", online: true, projects: [
            .init(id: "project", name: "App", sessions: [conversation.sessionId, emptySessionID]),
        ])]
        #expect(model.projectConversations.contains { $0.sessionId == emptySessionID })
        #expect(await model.archiveConversation(conversation))
        #expect(!model.projectConversations.contains { $0.sessionId == conversation.sessionId })
        #expect(await model.restoreConversation(conversation))
        #expect(model.projectConversations.contains { $0.sessionId == conversation.sessionId })
        #expect(await model.deleteConversation(conversation))
        #expect(!model.projectConversations.contains { $0.sessionId == conversation.sessionId })
        #expect(model.projectConversations.contains { $0.sessionId == emptySessionID })
    }

    @Test func pinnedSessionsStayVisibleOutsideCollapsedProjectsAndRecents() {
        let pinned = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "pinned")
        let recent = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "recent")
        let device = ChatProjectDevice(id: "mac", name: "My Mac", online: true, projects: [
            .init(id: "project", name: "App", sessions: [pinned.sessionId]),
        ])
        let sections = ChatProjectSections.build(conversations: [pinned, recent], devices: [device], search: "", collapsedForks: [], pinned: [pinned.sessionId])
        #expect(sections.map(\.id) == ["pinned", "mac:project", "recents"])
        #expect(sections[0].sessions.map(\.id) == [pinned.id])
        #expect(sections[1].sessions.map(\.id) == [pinned.id])
        #expect(sections[2].sessions.map(\.id) == [recent.id])
        let unassigned = ChatProjectSections.build(conversations: [pinned, recent], devices: [], search: "", collapsedForks: [], pinned: [pinned.sessionId])
        #expect(unassigned.last?.sessions.map(\.id) == [recent.id])
    }

    @Test func pinnedForkRemainsReachableAndSearchFiltersPinnedRows() {
        let parent = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "parent")
        let fork = ConversationSummary(
            id: "fork", kind: .agent, peerAccountId: "owner", agentId: parent.agentId,
            ownerDisplayName: nil, displayName: "Investigate sidebar", lastMessage: "Review navigation",
            lastActivityAt: parent.lastActivityAt, unreadCount: 0, avatarSource: nil,
            agentActivity: .ready, sessionId: "fork-session", forkedFromSessionId: parent.sessionId
        )
        let sections = ChatProjectSections.build(conversations: [parent, fork], devices: [], search: "sidebar", collapsedForks: [parent.sessionId], pinned: [fork.sessionId])
        #expect(sections.first?.id == "pinned")
        #expect(sections.first?.sessions.first?.id == fork.id)
        #expect(sections.first?.sessions.first?.depth == 0)
        #expect(sections.first?.sessions.first?.childCount == 0)
        let unmatched = ChatProjectSections.build(conversations: [parent, fork], devices: [], search: "unmatched", collapsedForks: [], pinned: [fork.sessionId])
        #expect(unmatched.isEmpty)
        let pinnedParent = ChatProjectSections.build(conversations: [parent, fork], devices: [], search: "", collapsedForks: [parent.sessionId], pinned: [parent.sessionId])
        #expect(pinnedParent.last?.id == "recents")
        #expect(pinnedParent.last?.sessions.first?.id == fork.id)
        #expect(pinnedParent.last?.sessions.first?.depth == 0)
    }

    @Test func validatesRepositoryInput() {
        #expect(ChatProjectRepositoryInput.normalize("https://github.com/example/app.git") == "example/app")
        #expect(ChatProjectRepositoryInput.normalize("git@github.com:example/app.git") == "example/app")
        for value in ["https://other.example/app/repo", "../repo", "owner/--help", "https://token@github.com/owner/repo", "owner/repo/extra"] {
            #expect(ChatProjectRepositoryInput.normalize(value) == nil)
        }
    }

    @Test func unassignedSessionsStayInRecentsAndMovedForksStayVisible() {
        let first = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "one")
        let second = AgentSessionFactory.makeDefault(ownAccountId: "owner", randomId: "two")
        let device = ChatProjectDevice(id: "mac", name: "My Mac", online: false, projects: [.init(id: "project", name: "App", sessions: [first.sessionId])])
        let sections = ChatProjectSections.build(conversations: [first, second], devices: [device], search: "", collapsedForks: [], pinned: [])
        #expect(sections.count == 2)
        #expect(sections[0].project?.name == "App")
        #expect(sections[0].sessions.map(\.id) == [first.id])
        #expect(sections[1].id == "recents")
        #expect(sections[1].project == nil)
        #expect(sections[1].sessions.map(\.id) == [second.id])
        let moved = ChatProjectDevice(id: "mac", name: "My Mac", online: true, projects: [.init(id: "project", name: "App", sessions: [])])
        let detached = ChatProjectSections.build(conversations: [first, second], devices: [moved], search: "", collapsedForks: [], pinned: [])
        #expect(detached[0].sessions.isEmpty)
        #expect(detached[1].sessions.count == 2)
    }
}
