import Foundation

/// User-facing assistant prose and tool references in their original turn order.
struct AgentTurnSegment: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    var text: String? = nil
    var toolId: String? = nil
    var revision: Int? = nil
}

struct AgentTurnContentGroup: Identifiable, Equatable {
    let id: String
    var text: String? = nil
    var tools: [AgentExecutionTool] = []
    var unavailable = 0

    static func groups(segments: [AgentTurnSegment], tools: [AgentExecutionTool]) -> [Self] {
        var result: [Self] = []
        var seen = Set<String>()
        for segment in segments where !segment.id.isEmpty && seen.insert(segment.id).inserted {
            if segment.kind == "text", let text = segment.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(Self(id: segment.id, text: text))
            } else if segment.kind == "tool", let toolID = segment.toolId {
                if result.last?.text != nil || result.isEmpty { result.append(Self(id: segment.id)) }
                if let tool = tools.first(where: { $0.id == toolID }) {
                    result[result.count - 1].tools.append(tool)
                } else {
                    result[result.count - 1].unavailable += 1
                }
            }
        }
        return result
    }
}

extension AgentExecutionSnapshot {
    var orderedGroups: [AgentTurnContentGroup] {
        AgentTurnContentGroup.groups(segments: segments ?? [], tools: tools ?? [])
    }

    var progressLabel: String {
        if phase == .cancelled { return "Stopped" }
        if phase == .failed { return "Needs attention" }
        if completed { return "Worked for" }
        if phase == .queued { return "Queued" }
        let active = (tools ?? []).filter { $0.state == .running }
        guard let tool = active.first else { return phase == .writing ? "Writing the response" : "Working" }
        let name = tool.name.lowercased()
        let action: String
        if name.contains("read") || name.contains("view") { action = "Reading files" }
        else if name.contains("search") || name.contains("grep") { action = "Searching" }
        else if name.contains("edit") || name.contains("write") { action = "Editing files" }
        else if name.contains("bash") || name.contains("shell") { action = "Running a command" }
        else { action = "Using tools" }
        return active.count > 1 ? "\(action) · \(active.count) active" : action
    }

    func elapsedLabel(at date: Date) -> String? {
        guard let start = startedAtMs, start.isFinite else { return nil }
        let end = completed ? updatedAtMs : date.timeIntervalSince1970 * 1_000
        guard end.isFinite else { return nil }
        let seconds = Int(max(0, end - start) / 1_000)
        return seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
    }
}
