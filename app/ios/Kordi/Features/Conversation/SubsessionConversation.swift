import Foundation

extension CloudAgentSubsession {
    /// The owner's message in their own agent's background session asks that
    /// agent to continue, as in any agent session, so it gets an agent mention
    /// up front. A message that mentions someone keeps the shared rule: only
    /// an explicit agent mention runs the agent. Mirrors the Mac's
    /// `ownerMessageToAgent`.
    func ownerMessageToAgent(
        text: String,
        mentions: [MessageMention],
        accountId: String
    ) -> (text: String, mentions: [MessageMention]) {
        guard ownerAccountId == accountId, mentions.isEmpty,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let agent = mentionTargets(accountId: accountId).first(where: { $0.kind == .agent })
        else { return (text, mentions) }
        let addressed = "\(agent.mentionText) \(text)"
        let agentMentions = ComposerMentionTargetCatalog.mentions(in: addressed, selectedTarget: agent, targets: [agent])
        guard agentMentions.first?.startUtf16 == 0 else { return (text, mentions) }
        return (addressed, agentMentions)
    }

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
        for message in messages {
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
        if state == .running && live != false && hasFollowupExecution != true {
            let progress = AgentExecutionSnapshot(phase: .usingTool, summary: "", steps: [], tools: activity?.tools,
                startedAtMs: nil, updatedAtMs: 0, completed: false)
            let lastAnswer = messages.last { $0.role == "assistant" && $0.requestId == nil }
            if let index = result.lastIndex(where: { $0.id == lastAnswer?.id }) {
                result[index].agentExecution = progress
            } else {
                let taskBrief = messages.last { $0.senderAgentId == agentId }
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
}
