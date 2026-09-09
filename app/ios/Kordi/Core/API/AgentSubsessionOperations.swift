import Foundation

@MainActor
enum AgentSubsessionOperations {
    static func tasks(api: CloudAPIClient, token: String, parentSessionId: String,
                      isCurrent: () -> Bool) async throws -> [CloudAgentSubsessionTask] {
        var tasks: [CloudAgentSubsessionTask] = []
        var after: String?
        var seen = Set<String>()
        repeat {
            let page = try await api.agentSubsessionTasks(token: token, parentSessionId: parentSessionId, after: after)
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            tasks.append(contentsOf: page.sessions)
            after = page.nextCursor
            if let after, !seen.insert(after).inserted { throw URLError(.cannotParseResponse) }
        } while after != nil
        return tasks
    }

    static func stop(_ snapshot: CloudAgentSubsession, api: CloudAPIClient, token: String?,
                     previewMode: Bool) async throws -> CloudAgentSubsession {
        if previewMode {
            try await Task.sleep(for: .milliseconds(700))
            var preview = snapshot
            preview.status = "stopped"
            preview.version += 1
            preview.live = false
            return preview
        }
        guard let token else { throw URLError(.userAuthenticationRequired) }
        return try await api.stopAgentSubsession(token: token, id: snapshot.sessionId, expectedStartedAtMs: snapshot.startedAtMs)
    }
}
