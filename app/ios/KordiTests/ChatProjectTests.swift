import Testing
@testable import Kordi

struct ChatProjectTests {
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
