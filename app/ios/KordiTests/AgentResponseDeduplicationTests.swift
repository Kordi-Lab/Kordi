import Foundation
import Testing
@testable import Kordi

@MainActor
struct AgentResponseDeduplicationTests {
    private var conversation: ConversationSummary {
        ConversationSummary(id: "agent-session:test", kind: .agent, peerAccountId: "acct_test", agentId: nil,
            ownerDisplayName: "Test owner", displayName: "Test chat", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "session:test")
    }

    private func wire(_ id: String, body: String, sender: String = "acct_test", second: Int = 1) -> CloudMessageDTO {
        CloudMessageDTO(messageId: id, fromAccountId: sender, toAccountId: "acct_test", body: body,
            createdAt: String(format: "2026-09-13T10:00:%02dZ", second), deliveredAt: nil, readAt: nil,
            direction: "outgoing", sessionId: conversation.sessionId)
    }

    private func response(_ id: String, request: String = "request", text: String = "Completed answer",
                          state: String = "complete", sender: String = "acct_test", second: Int = 1,
                          execution: [String: Any]? = nil) throws -> CloudMessageDTO {
        var payload: [String: Any] = ["kind": "agent-response", "requestId": request, "text": text, "deliveryState": state]
        if let execution { payload["execution"] = execution }
        let body = CloudMessageCodec.agentResponsePrefix + (try JSONSerialization.data(withJSONObject: payload)).base64EncodedString()
        return wire(id, body: body, sender: sender, second: second)
    }

    private func project(_ rows: [CloudMessageDTO]) -> [ChatMessage] {
        CloudDirectMessageProjector.project(rows, conversation: conversation, ownAccountId: "acct_test")
    }

    @Test func completedCloudCopiesProduceOneCardAndRetainExecutionDetails() throws {
        let start = parseCloudDate("2026-09-13T10:00:00Z").timeIntervalSince1970 * 1_000
        let execution: [String: Any] = ["phase": "writing", "summary": "Preparing answer", "steps": [],
            "thinkingText": "Check the evidence", "startedAtMs": start, "updatedAtMs": start + 5_000, "completed": false,
            "tools": [["id": "tool:read", "name": "read_session", "status": "complete", "arguments": "{}", "liveOutput": "", "isError": false]]]
        let earlier = try response("desktop-enriched", execution: execution)
        let terminal = try response("terminal", second: 5)
        let projected = project([earlier, terminal, terminal])
        #expect(projected.count == 1)
        let answer = try #require(projected.first)
        #expect(answer.text == "Completed answer")
        #expect(answer.agentExecution?.thinkingText == "Check the evidence")
        #expect(answer.agentExecution?.tools?.count == 1)
        #expect(answer.agentExecution?.completed == true)
        #expect(AgentExecutionTimelinePresentation(execution: try #require(answer.agentExecution)).completionLabel == "Worked for 5s")
        let merged = AppModel.mergePartialProjection(project([terminal]), preserving: project([earlier]))
        #expect(merged.count == 1)
        #expect(AppModel.timelineIdentity(for: answer, requestPresentationIds: [:])
            == AppModel.timelineIdentity(for: try #require(project([earlier]).first), requestPresentationIds: [:]))
    }

    @Test(arguments: ["Request canceled.", "Response stopped.", "Partial answer before cancellation"])
    func cancellationControlAndTerminalCopiesProduceOneNotice(text: String) throws {
        let request = wire("request", body: "Summarize work", second: 0)
        let cancelBody = CloudMessageCodec.agentCancelPrefix
            + (try JSONSerialization.data(withJSONObject: ["kind": "agent-cancel", "requestId": "request"])).base64EncodedString()
        let cancel = wire("cancel", body: cancelBody)
        let first = try response("cancelled-one", text: text, state: "cancelled", second: 2)
        let second = try response("cancelled-two", text: text, state: "cancelled", second: 3)
        let rows = project([request, cancel, first, second])
        #expect(rows.count == 2)
        #expect(rows.filter { $0.author == .agent }.map(\.text) == [text])
        #expect(rows.last?.deliveryState == .cancelled)
        #expect(rows.last?.errorMessage == nil)
        let cached = project([request, cancel])
        #expect(AppModel.mergePartialProjection(rows, preserving: cached).count == 2)
    }

    @Test func equalAnswersToDifferentRequestsOrFromDifferentOwnersStaySeparate() throws {
        let first = try response("first")
        #expect(project([first, try response("second", request: "another-request")]).count == 2)
        #expect(project([first, try response("peer", sender: "acct_peer")]).count == 2)
    }

    @Test(arguments: ["complete", "cancelled"])
    func groupLifecycleCopiesCollapseWithoutHidingAnotherOwnersReply(state: String) {
        func payload(_ id: String, owner: String = "acct_test", request: String = "request", at: Double) -> CloudGroupMessagePayload {
            CloudGroupMessagePayload(id: id, senderAccountId: owner, text: "Same response", createdAtMs: at,
                senderKind: "agent", senderDisplayName: "Agent", deliveryState: state,
                replyToMessageId: request, requestId: request)
        }
        let visible = CloudGroupAgentLifecycleProjector.visibleMessageIds(in: [
            payload("first", at: 1), payload("duplicate", at: 2),
            payload("peer", owner: "acct_peer", at: 3), payload("another-request", request: "another", at: 4)
        ])
        #expect(visible == ["duplicate", "peer", "another-request"])
    }
    @Test func sentRequestNeedsARealProcessingEventBeforeShowingProcessing() throws {
        let request = wire("request", body: "Hello", second: 0)
        let sent = project([request])
        #expect(sent.count == 1)
        #expect([MessageDeliveryState.sent, .delivered, .read].contains(try #require(sent.first).deliveryState))
        #expect(sent.allSatisfy { $0.agentExecution == nil })
        let progress = try response("progress", text: "", state: "processing")
        let processing = AppModel.mergePartialProjection(project([request, progress]), preserving: sent)
        let active = try #require(processing.first { $0.author == .agent })
        #expect(processing.count == 2)
        #expect(MessageBubble.showsAgentWaitingIndicator(execution: try #require(active.agentExecution), responseText: active.text))
        let complete = AppModel.mergePartialProjection(project([request, try response("complete", second: 2)]), preserving: processing)
        #expect(complete.count == 2)
        #expect(complete.allSatisfy { $0.agentExecution?.completed != false })
    }

    @Test(arguments: [MessageDeliveryState.sending, .sent, .delivered, .read, .failed, .cancelled])
    func processingCannotOvertakeItsRequestsSendState(state: MessageDeliveryState) throws {
        let request = wire("request", body: "Hello", second: 0)
        let progress = try response("progress", text: "", state: "processing")
        var rows = project([request, progress])
        let index = try #require(rows.firstIndex { $0.author == .me })
        rows[index].deliveryState = state
        for kind: ConversationKind in [.agent, .group, .person] {
            let visible = AgentSessionQueuePresentation.apply(to: rows, kind: kind)
            #expect(visible.count == ([.sent, .delivered, .read].contains(state) ? 2 : 1))
        }
    }

}
