import Foundation

enum AgentSessionQueuePresentation {
    private static func executionSnapshots(in messages: [ChatMessage]) -> [String: AgentExecutionSnapshot] {
        var snapshots: [String: AgentExecutionSnapshot] = [:]
        for message in messages where message.author == .agent {
            guard let requestID = message.requestMessageId,
                  let execution = message.agentExecution else { continue }
            if let existing = snapshots[requestID] {
                if existing.completed && !execution.completed { continue }
                if !execution.completed && execution.updatedAtMs < existing.updatedAtMs { continue }
            }
            snapshots[requestID] = execution
        }
        return snapshots
    }

    static func pendingPhase(
        requestID: String,
        createdAt: Date,
        messages: [ChatMessage],
        kind: ConversationKind,
        locallyQueued: Bool,
        confirmedRunStatus: String? = nil
    ) -> AgentExecutionSnapshot.Phase? {
        guard kind == .agent,
              let request = messages.first(where: { $0.id == requestID }),
              [.sent, .delivered, .read].contains(request.deliveryState) else { return nil }
        if let confirmedRunStatus {
            if confirmedRunStatus == "running" { return .preparing }
            if ["failed", "cancelled"].contains(confirmedRunStatus) { return nil }
        }
        if locallyQueued { return .queued }
        let snapshots = executionSnapshots(in: messages)
        let hasActivePredecessor = messages.contains { message in
            message.author == .agent
                && message.requestMessageId != requestID
                && message.createdAt < createdAt
                && message.requestMessageId.flatMap { snapshots[$0] }?.completed == false
        }
        // An accepted request stays visibly pending until its reply arrives.
        // Admission and progress events can refine this state, but are not
        // prerequisites for acknowledging that the user is waiting.
        return hasActivePredecessor ? .queued : .preparing
    }

    static func apply(to messages: [ChatMessage], kind: ConversationKind) -> [ChatMessage] {
        let unacceptedRequestIDs = Set(messages.filter {
            $0.author == .me && [.sending, .failed, .cancelled].contains($0.deliveryState)
        }.map(\.id))
        let messages = messages.filter { message in
            guard message.agentExecution?.completed == false,
                  let requestID = message.requestMessageId else { return true }
            return !unacceptedRequestIDs.contains(requestID)
        }
        guard kind == .agent else { return messages }
        let snapshots = executionSnapshots(in: messages)
        let requests = messages.filter {
            $0.author == .me && !$0.isSystemNotice
                && $0.deliveryState != .failed && $0.deliveryState != .cancelled
        }.sorted(by: ChatMessage.timelinePrecedes)
        let queuedIDs = requests.filter {
            snapshots[$0.id]?.phase == .queued && snapshots[$0.id]?.completed == false
        }.map(\.id)
        let positions = Dictionary(uniqueKeysWithValues: queuedIDs.enumerated().map { ($0.element, $0.offset + 1) })
        return messages.compactMap { message in
            if message.author == .agent, let requestID = message.requestMessageId,
               positions[requestID] != nil { return nil }
            var copy = message
            copy.agentQueuePosition = positions[message.id]
            return copy
        }
    }
}
