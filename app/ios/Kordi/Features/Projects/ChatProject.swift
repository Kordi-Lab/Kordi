import Foundation

struct ChatProject: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    var sessions: [String]
}

struct ChatProjectDevice: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let online: Bool
    var projects: [ChatProject]
}

struct ChatProjectCatalog: Codable { let devices: [ChatProjectDevice] }
struct ChatProjectRepository: Codable, Identifiable {
    let fullName: String
    let description: String?
    var id: String { fullName }
}
struct ChatProjectResult: Codable {
    var projectId: String?
    var sessionId: String?
    var cancelled: Bool?
    var message: String?
    var repositories: [ChatProjectRepository]?
    var hasMore: Bool?
}
struct ChatProjectCommand: Codable {
    let id: String
    let status: String
    let result: ChatProjectResult?
}
struct ChatProjectRequest: Encodable {
    let commandId: String
    let deviceId: String
    let action: String
    var projectId: String?
    var sessionId: String?
    var repository: String?
    var page: Int?
}
struct ChatProjectFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

extension CloudAPIClient {
    func projectCatalog(token: String) async throws -> ChatProjectCatalog {
        try await send(path: "/v1/cloud/projects", method: "GET", token: token, fallback: "Could not load projects. Refresh to try again.")
    }

    func performProjectAction(token: String, input: ChatProjectRequest) async throws -> ChatProjectResult {
        let _: ChatProjectCommand = try await send(path: "/v1/cloud/projects/commands", method: "POST", token: token, body: input, fallback: "Open Kordi on your Mac and try again.")
        // The command ID is retained through polling; an interrupted clone is never silently replayed.
        for _ in 0..<720 {
            try Task.checkCancellation()
            let command: ChatProjectCommand = try await send(path: "/v1/cloud/projects/commands/\(input.commandId)", method: "GET", token: token, fallback: "Could not check the project action. Check Kordi on your Mac before retrying.")
            if command.status == "completed" { return command.result ?? ChatProjectResult() }
            if command.status == "failed" { throw ChatProjectFailure(message: command.result?.message ?? "The project action could not finish. Check Kordi on your Mac.") }
            try await Task.sleep(for: .seconds(1))
        }
        throw ChatProjectFailure(message: "The project action timed out. Check Kordi on your Mac before retrying.")
    }
}

struct ChatProjectSessionSection: Identifiable {
    let id: String
    let project: ChatProject?
    let device: ChatProjectDevice?
    let sessions: [AgentSessionListItem]
}

enum ChatProjectSections {
    static func build(conversations: [ConversationSummary], devices: [ChatProjectDevice], search: String, collapsedForks: Set<String>, pinned: Set<String>) -> [ChatProjectSessionSection] {
        let assigned = Set(devices.flatMap { $0.projects.flatMap(\.sessions) })
        var sections: [ChatProjectSessionSection] = []
        for device in devices {
            for project in device.projects {
                let ids = Set(project.sessions)
                let matchesProject = project.name.localizedCaseInsensitiveContains(search)
                let sessions = AgentSessionTimelineCatalog.build(conversations: conversations.filter { ids.contains($0.sessionId) }, searchText: matchesProject ? "" : search, collapsedForkParentIds: collapsedForks, pinnedSessionIds: pinned, retainedSessionIds: ids)
                if search.isEmpty || matchesProject || !sessions.isEmpty {
                    sections.append(.init(id: "\(device.id):\(project.id)", project: project, device: device, sessions: sessions))
                }
            }
        }
        let recents = AgentSessionTimelineCatalog.build(conversations: conversations.filter { !assigned.contains($0.sessionId) }, searchText: search, collapsedForkParentIds: collapsedForks, pinnedSessionIds: pinned)
        if !recents.isEmpty { sections.append(.init(id: "recents", project: nil, device: nil, sessions: recents)) }
        return sections
    }
}
