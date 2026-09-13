import Foundation

extension PreviewData {
    static func shortTrajectoryConversation(now: Date) -> [ChatMessage] {
        let conversationID = "agent:my-kordi"
        return [
            ChatMessage(id: "trajectory-model", conversationId: conversationID, author: .agent,
                authorName: "Fixture Agent", text: ChatMessage.runtimeRouteChangeNotice(model: "sample/model", thinking: "medium"),
                createdAt: now.addingTimeInterval(-5), deliveryState: .delivered, errorMessage: nil,
                requestMessageId: nil, messageKind: ChatMessage.agentModelChangeMessageKind),
            ChatMessage(id: "trajectory-request", conversationId: conversationID, author: .me,
                authorName: "You", text: "Check the next sample when ready.",
                createdAt: now.addingTimeInterval(-4), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
            ChatMessage(id: "trajectory-response", conversationId: conversationID, author: .agent,
                authorName: "Fixture Agent", text: "The sample is ready to review. Each item has been checked and the next example is available below.",
                createdAt: now, deliveryState: .delivered, errorMessage: nil, requestMessageId: "trajectory-request",
                agentExecution: AgentExecutionSnapshot(phase: .complete, summary: "Finished",
                    steps: [AgentExecutionStep(id: "response", label: "Preparing the sample response", state: .complete)],
                    startedAtMs: 1_000, updatedAtMs: 4_000, completed: true))
        ]
    }
}
