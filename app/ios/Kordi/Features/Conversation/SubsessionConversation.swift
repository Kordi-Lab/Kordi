import Foundation

extension CloudAgentSubsession {
    var conversation: ConversationSummary {
        ConversationSummary(id: "subsession:\(sessionId)", kind: .agent,
            peerAccountId: ownerAccountId, agentId: agentId, ownerDisplayName: ownerDisplayName,
            displayName: title, lastMessage: messages.last?.text ?? "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: agentAvatarUrl, agentActivity: state == .running ? .replying : .ready,
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
        for message in messages {
            let agent = message.role == "assistant"
            if agent && ["queued", "pending", "leased"].contains(message.requestState ?? "") { continue }
            let author: MessageAuthor = agent ? .agent : message.senderAccountId == accountId ? .me : .person
            let phase: AgentExecutionSnapshot.Phase? = switch message.requestState {
                case "running" where agent: .usingTool
                case "completed" where agent: .complete
                case "failed" where agent: .failed
                case "cancelled" where agent: .cancelled
                default: nil
            }
            let execution = phase.map { phase in
                AgentExecutionSnapshot(phase: phase, summary: "", steps: [], tools: message.activity?.tools,
                    startedAtMs: nil, updatedAtMs: Double(message.timestampMs), completed: phase != .usingTool)
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
        if state == .running && hasFollowupExecution != true {
            let progress = AgentExecutionSnapshot(phase: .usingTool, summary: "", steps: [], tools: activity?.tools,
                startedAtMs: nil, updatedAtMs: 0, completed: false)
            if let index = result.lastIndex(where: { $0.author == .agent && $0.requestMessageId == nil }) {
                result[index].agentExecution = progress
            } else {
                result.insert(ChatMessage(id: "runtime:\(sessionId)", conversationId: conversation.id,
                    author: .agent, authorName: agentDisplayName,
                    senderOwnerName: ownerAccountId == accountId ? "You" : ownerDisplayName,
                    text: "", createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil,
                    requestMessageId: nil, agentExecution: progress), at: 0)
            }
        }
        return result
    }
}
