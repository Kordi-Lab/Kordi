import Foundation

extension CloudAgentSubsession {
    var conversation: ConversationSummary {
        ConversationSummary(id: "subsession:\(sessionId)", kind: .agent,
            peerAccountId: ownerAccountId, agentId: agentId, ownerDisplayName: ownerDisplayName,
            displayName: title, lastMessage: messages.last?.text ?? "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: agentAvatarUrl,
            agentActivity: state == .failed ? .failed : state == .running && live != false ? .replying : .ready,
            sessionId: sessionId, agentDisplayName: agentDisplayName,
            groupParticipants: (participants ?? []).map {
                CloudGroupParticipant(accountId: $0.accountId, displayName: $0.displayName,
                    avatarUrl: $0.avatarUrl, role: nil)
            }, subsessionId: sessionId)
    }

    func mentionTargets(accountId: String) -> [ComposerMentionTarget] {
        [ComposerMentionTarget(id: agentId, displayName: agentDisplayName, kind: .agent,
            accountId: ownerAccountId, agentId: agentId, ownerName: ownerDisplayName, avatarSource: agentAvatarUrl)]
        + (participants ?? []).filter { $0.accountId != accountId }.map {
            ComposerMentionTarget(id: $0.accountId, displayName: $0.displayName, kind: .person,
                accountId: $0.accountId, agentId: nil, ownerName: nil, avatarSource: $0.avatarUrl)
        }
    }

    func chatMessages(accountId: String) -> [ChatMessage] {
        var result: [ChatMessage] = []
        var queuePosition = 0
        let isLive = state == .running && live != false
        let (rows, legacyTools) = Self.collapsingLegacyToolMessages(messages,
            live: isLive && hasFollowupExecution != true)
        for message in rows {
            let assistant = message.role == "assistant"
            let agent = assistant || message.senderAgentId == agentId
            if assistant && ["queued", "pending", "leased"].contains(message.requestState ?? "") { continue }
            if assistant && live == false && message.requestState == "running" && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            let author: MessageAuthor = agent ? .agent : message.senderAccountId == accountId ? .me : .person
            let phase: AgentExecutionSnapshot.Phase? = switch message.requestState {
                case "running" where assistant && live != false: .usingTool
                case "completed" where assistant: .complete
                case "failed" where assistant: .failed
                case "cancelled" where assistant: .cancelled
                default: nil
            }
            let execution = phase.map { phase in
                AgentExecutionSnapshot(phase: phase, summary: "", steps: [], tools: message.activity?.tools,
                    startedAtMs: nil, updatedAtMs: Double(message.timestampMs), completed: phase != .usingTool)
            } ?? legacyTools[message.id].map { tools in
                AgentExecutionSnapshot(phase: .complete, summary: "", steps: [], tools: tools,
                    startedAtMs: nil, updatedAtMs: Double(message.timestampMs), completed: true)
            }
            var row = ChatMessage(id: message.id, conversationId: conversation.id, author: author,
                authorName: agent ? agentDisplayName : author == .me ? "You" : message.senderDisplayName ?? "Task",
                senderOwnerName: agent ? ownerAccountId == accountId ? "You" : ownerDisplayName : nil,
                text: message.text, createdAt: Date(timeIntervalSince1970: Double(message.timestampMs) / 1000),
                deliveryState: .delivered, errorMessage: nil, requestMessageId: message.requestId,
                mentions: message.mentions ?? [], agentExecution: execution)
            if !agent && message.requestState == "queued" {
                queuePosition += 1
                row.agentQueuePosition = queuePosition
            }
            result.append(row)
        }
        let runTools = activity?.tools ?? []
        if isLive && hasFollowupExecution != true || !isLive && !runTools.isEmpty {
            let lastAnswer = rows.last { $0.role == "assistant" && $0.requestId == nil }
            let answerIndex = result.lastIndex(where: { $0.id == lastAnswer?.id })
            let earlier = answerIndex.flatMap { result[$0].agentExecution?.tools } ?? []
            let settled = isLive ? runTools : runTools.map(Self.settled)
            let progress = AgentExecutionSnapshot(phase: isLive ? .usingTool : .complete, summary: "", steps: [],
                tools: earlier + settled, startedAtMs: nil, updatedAtMs: 0, completed: !isLive)
            if let index = answerIndex {
                result[index].agentExecution = progress
            } else {
                let taskBrief = rows.last { $0.senderAgentId == agentId }
                let insertionIndex = result.lastIndex { $0.id == taskBrief?.id }.map { $0 + 1 } ?? 0
                result.insert(ChatMessage(id: "runtime:\(sessionId)", conversationId: conversation.id,
                    author: .agent, authorName: agentDisplayName,
                    senderOwnerName: ownerAccountId == accountId ? "You" : ownerDisplayName,
                    text: "", createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil,
                    requestMessageId: nil, agentExecution: progress), at: insertionIndex)
            }
        }
        return result
    }

    private static func settled(_ tool: AgentExecutionTool) -> AgentExecutionTool {
        guard tool.state == .running else { return tool }
        return AgentExecutionTool(id: tool.id, name: tool.name, status: "completed", arguments: tool.arguments,
            liveOutput: tool.liveOutput, resultText: tool.resultText, detail: tool.detail,
            toolLayer: tool.toolLayer, isError: tool.isError)
    }

    /// Older Cloud runs stored one "Using <tool>…" message per tool call. Each
    /// consecutive run folds into the following answer, or into one summary row.
    static func collapsingLegacyToolMessages(_ messages: [Message], live: Bool)
        -> (messages: [Message], tools: [String: [AgentExecutionTool]]) {
        let prefix = "tool:"
        var rows: [Message] = []
        var tools: [String: [AgentExecutionTool]] = [:]
        var pending: [Message] = []
        func flush(into target: Message?) {
            guard let first = pending.first else { return }
            let entries = pending.map { message in
                let label = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let name = label.hasPrefix("Using ") && label.hasSuffix("…")
                    ? String(label.dropFirst("Using ".count).dropLast()) : "tool"
                return AgentExecutionTool(id: String(message.id.dropFirst(prefix.count)), name: name,
                    status: "completed", arguments: "", liveOutput: "", resultText: nil, detail: nil,
                    toolLayer: nil, isError: false)
            }
            let row = target ?? Message(id: "tools:\(first.id.dropFirst(prefix.count))", role: "assistant",
                text: "", timestampMs: first.timestampMs)
            if target == nil { rows.append(row) }
            tools[row.id] = entries
            pending = []
        }
        for message in messages {
            if message.role == "assistant" && message.id.hasPrefix(prefix) {
                pending.append(message)
            } else if message.role == "assistant" && message.requestId == nil {
                flush(into: message)
                rows.append(message)
            } else {
                flush(into: nil)
                rows.append(message)
            }
        }
        let trailing = !pending.isEmpty
        flush(into: nil)
        if trailing, live, let id = rows.last?.id, var entries = tools[id], let last = entries.last {
            entries[entries.count - 1] = AgentExecutionTool(id: last.id, name: last.name, status: "running",
                arguments: "", liveOutput: "", resultText: nil, detail: nil, toolLayer: nil, isError: false)
            tools[id] = entries
        }
        return (rows, tools)
    }
}
