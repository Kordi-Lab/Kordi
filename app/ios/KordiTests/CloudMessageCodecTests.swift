import XCTest
@testable import Kordi

final class CloudMessageCodecTests: XCTestCase {
    func testDirectEnvelopeDecodesMacRuntimeRouteFieldNames() throws {
        let json = #"{"schemaVersion":1,"kind":"message","text":"Switched model to openai/gpt-5.6-luna","agentRuntimeRoute":{"model":"openai/gpt-5.6-luna","authProvider":"openai-codex","authChoice":"local-active-oauth","thinking":"max"}}"#
        let encoded = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let body = CloudMessageCodec.directPrefix + encoded

        let routing = try XCTUnwrap(
            CloudMessageCodec.directEnvelope(body)?.agentRuntimeRoute
        )
        XCTAssertEqual(routing.defaultModel, "openai/gpt-5.6-luna")
        XCTAssertEqual(routing.defaultAuthProvider, "openai-codex")
        XCTAssertEqual(routing.defaultAuthChoice, "local-active-oauth")
        XCTAssertEqual(routing.thinking, "max")
    }

    func testDirectAgentEnvelopeRoundTripsDisplayTextAndTarget() throws {
        var runtimeRoute = CloudModelRouting.empty
        runtimeRoute.defaultModel = "openai-codex/gpt-5.6-sol"
        runtimeRoute.defaultAuthProvider = "openai-codex"
        runtimeRoute.defaultAuthChoice = "local-active-oauth"
        runtimeRoute.thinking = "high"
        let displayText = "@Research Agent"
        let mentions = [MessageMention(
            label: "Research Agent",
            targetKind: "agent",
            targetIdentityId: "agent:cloud_agent_research",
            startUtf16: 0,
            lengthUtf16: (displayText as NSString).length,
            displayText: displayText
        )]
        let encoded = try CloudMessageCodec.encodeDirect(
            text: "\(displayText) summarize the launch notes",
            agentId: "cloud_agent_research",
            agentName: "Research Agent",
            ownerAccountId: "acct_owner",
            ownerName: "Maya",
            mentions: mentions,
            agentRuntimeRoute: runtimeRoute
        )

        XCTAssertTrue(encoded.hasPrefix(CloudMessageCodec.directPrefix))
        XCTAssertEqual(CloudMessageCodec.displayText(encoded), "\(displayText) summarize the launch notes")
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.targetCloudAgentId, "cloud_agent_research")
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.targetCloudAgentOwnerAccountId, "acct_owner")
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.mentions, mentions)
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.agentRuntimeRoute, runtimeRoute)
    }

    func testDirectEnvelopeRoundTripsMacCompatibleQuoteMetadata() throws {
        let source = MessageActionSource(
            sourceSessionId: "session:source",
            sourceMessageId: "msg_source",
            senderLabel: "Maya",
            textPreview: "The original message",
            attachmentCount: 1,
            createdAtMs: 1_786_000_000_000,
            timeLabel: "10:30"
        )
        let encoded = try CloudMessageCodec.encodeDirect(
            text: "My reply",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil,
            messageAction: .quote(source)
        )

        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.messageAction?.kind, "quote")
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.messageAction?.source, source)
    }

    func testForwardMetadataRoundTripsWithoutBecomingAReply() throws {
        let source = MessageActionSource(
            sourceSessionId: "session:source",
            sourceMessageId: "msg_source",
            senderLabel: "Maya",
            textPreview: "Forward this update",
            attachmentCount: 2,
            createdAtMs: 1_786_000_000_000,
            timeLabel: "10:30"
        )
        let action = MessageActionMetadata.forward(source)
        let encoded = try CloudMessageCodec.encodeDirect(
            text: "Forward this update",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil,
            messageAction: action
        )
        let decoded = try XCTUnwrap(CloudMessageCodec.directEnvelope(encoded)?.messageAction)

        XCTAssertEqual(decoded.kind, "forward")
        XCTAssertEqual(decoded.source, source)
        XCTAssertNil(decoded.replyToMessageId)
        XCTAssertEqual(MessageActionMetadata.quote(source).replyToMessageId, "msg_source")
    }

    func testReForwardKeepsTheOriginalSourceAttribution() {
        let source = MessageActionSource(
            sourceSessionId: "session:source",
            sourceMessageId: "msg_source",
            senderLabel: "Maya",
            textPreview: "Original update",
            attachmentCount: 0
        )
        let forwarded = ChatMessage(
            id: "msg_forwarded",
            conversationId: "conversation:destination",
            author: .me,
            authorName: "You",
            text: "Original update",
            createdAt: Date(timeIntervalSince1970: 1_786_000_000),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageAction: .forward(source)
        )

        XCTAssertEqual(forwarded.forwardSource(sessionId: "session:destination"), source)
    }

    func testPlainMessageRemainsUnchanged() {
        XCTAssertEqual(CloudMessageCodec.displayText("Hello Maya"), "Hello Maya")
        XCTAssertFalse(CloudMessageCodec.isAgentResponse("Hello Maya"))
    }

    func testAgentResponseExposesLinkedRequestId() throws {
        let payload = try XCTUnwrap(#"{"text":"Done","requestId":"msg_request","deliveryState":"complete"}"#.data(using: .utf8))
        let encoded = payload.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let body = CloudMessageCodec.agentResponsePrefix + encoded

        XCTAssertEqual(CloudMessageCodec.agentResponseRequestId(body), "msg_request")
        XCTAssertEqual(CloudMessageCodec.displayText(body), "Done")
    }

    func testAgentResponseDecodesValidatedBackgroundSessions() throws {
        let payload = try XCTUnwrap(
            #"{"text":"Background session started","requestId":"msg_request","deliveryState":"complete","backgroundSessions":[{"sessionId":"session-child","turnId":"turn-child","title":"Review runtime","status":"running"},{"sessionId":"session-child","title":"Duplicate","status":"done"},{"sessionId":"invalid","title":"Invalid state","status":"unknown"}]}"#
                .data(using: .utf8)
        )
        let body = CloudMessageCodec.agentResponsePrefix + payload.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        let sessions = CloudMessageCodec.backgroundAgentSessions(body)

        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions.first?.sessionId, "session-child")
        XCTAssertEqual(sessions.first?.turnId, "turn-child")
        XCTAssertEqual(sessions.first?.title, "Review runtime")
        XCTAssertEqual(sessions.first?.state, .running)
    }

    func testBackgroundSessionUsesSyncedConversationStateAndExactDestination() throws {
        let session = try XCTUnwrap(BackgroundAgentSession(wire: .init(
            sessionId: "session-child",
            turnId: nil,
            title: "Review runtime",
            status: "running"
        )))
        let source = ConversationSummary(
            id: "group:source",
            kind: .group,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: "Review group",
            displayName: "Review group",
            lastMessage: "Request",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:source"
        )
        let child = ConversationSummary(
            id: "agent-session:session-child",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "Review runtime",
            lastMessage: "Done",
            lastActivityAt: Date(timeIntervalSince1970: 2),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session-child"
        )

        XCTAssertEqual(session.resolvedState(in: [child]), .done)
        XCTAssertEqual(
            session.destination(
                from: source,
                conversations: [child],
                ownAccountId: "acct_me",
                ownDisplayName: "Alex",
                createdAt: Date(timeIntervalSince1970: 1)
            ),
            child
        )
        let provisional = session.destination(
            from: source,
            conversations: [],
            ownAccountId: "acct_me",
            ownDisplayName: "Alex",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        XCTAssertEqual(provisional.sessionId, "session-child")
        XCTAssertEqual(provisional.forkedFromSessionId, source.sessionId)
        XCTAssertEqual(provisional.agentActivity, .replying)
    }

    func testAgentResponseDecodesOwnerExecutionSnapshot() throws {
        let payload = try XCTUnwrap(
            #"{"text":"processing...","requestId":"msg_request","deliveryState":"processing","execution":{"phase":"using-tool","summary":"Using Search","steps":[{"id":"tool:search","label":"Using Search","state":"running"}],"thinkingText":"I need to search the index.","tools":[{"id":"search","name":"Search","status":"running","arguments":"{\"query\":\"status\"}","liveOutput":"Searching","isError":false}],"startedAtMs":1000,"updatedAtMs":2000,"completed":false}}"#
                .data(using: .utf8)
        )
        let encoded = payload.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let execution = try XCTUnwrap(
            CloudMessageCodec.agentExecution(
                CloudMessageCodec.agentResponsePrefix + encoded
            )
        )

        XCTAssertEqual(execution.phase, .usingTool)
        XCTAssertEqual(execution.summary, "Using Search")
        XCTAssertEqual(execution.steps.first?.state, .running)
        XCTAssertEqual(execution.thinkingText, "I need to search the index.")
        XCTAssertEqual(execution.tools?.first?.arguments, #"{"query":"status"}"#)
        XCTAssertEqual(execution.tools?.first?.liveOutput, "Searching")
        XCTAssertFalse(execution.completed)
    }

    func testExecutionTimelinePresentationMatchesDesktopHierarchy() {
        let execution = AgentExecutionSnapshot(
            phase: .failed,
            summary: "Execution needs attention",
            steps: [
                AgentExecutionStep(
                    id: "analysis",
                    label: "Analyzing the request",
                    state: .complete
                ),
                AgentExecutionStep(
                    id: "tool:shell-1",
                    label: "Using Bash",
                    state: .complete
                ),
                AgentExecutionStep(
                    id: "tool:shell-2",
                    label: "Using Bash",
                    state: .failed
                ),
                AgentExecutionStep(
                    id: "response",
                    label: "Writing the response",
                    state: .failed
                )
            ],
            startedAtMs: 1_000,
            updatedAtMs: 6_000,
            completed: true
        )

        let presentation = AgentExecutionTimelinePresentation(
            execution: execution
        )

        XCTAssertEqual(presentation.planningStep?.label, "Analyzing the request")
        XCTAssertEqual(presentation.toolSteps.count, 2)
        XCTAssertEqual(presentation.toolSteps.filter { $0.state == .failed }.count, 1)
        XCTAssertEqual(presentation.responseStep?.label, "Writing the response")
        XCTAssertEqual(presentation.completionLabel, "Worked for 5s")
    }

    func testWaitingExecutionTimelineHasNoRedundantExpandablePlanningContent() {
        let execution = AgentExecutionSnapshot(
            phase: .preparing,
            summary: "Preparing the response",
            steps: [],
            startedAtMs: 1_000,
            updatedAtMs: 1_000,
            completed: false
        )

        let presentation = AgentExecutionTimelinePresentation(execution: execution)

        XCTAssertFalse(presentation.hasExpandableContent)
        XCTAssertNil(presentation.planningStep)
        XCTAssertTrue(presentation.toolSteps.isEmpty)
        XCTAssertNil(presentation.responseStep)
    }

    func testExecutionTimelineExpansionStartsCollapsedAndOnlyCompletionClosesIt() {
        var expansion = AgentExecutionTimelineExpansion()

        XCTAssertFalse(expansion.isExpanded)

        expansion.isExpanded.toggle()
        expansion.updateCompletion(from: false, to: false)
        XCTAssertTrue(expansion.isExpanded)

        expansion.updateCompletion(from: false, to: true)
        XCTAssertFalse(expansion.isExpanded)

        expansion.isExpanded.toggle()
        expansion.updateCompletion(from: true, to: true)
        XCTAssertTrue(expansion.isExpanded)
    }

    func testPartialResponseReplacesWaitingIndicatorBeforeExecutionCompletes() {
        let execution = AgentExecutionSnapshot(
            phase: .writing,
            summary: "Writing the response",
            steps: [],
            startedAtMs: 1_000,
            updatedAtMs: 2_000,
            completed: false
        )
        XCTAssertTrue(MessageBubble.showsAgentWaitingIndicator(
            execution: execution,
            responseText: "processing..."
        ))
        XCTAssertTrue(MessageBubble.showsAgentWaitingIndicator(
            execution: execution,
            responseText: "Processing.."
        ))
        XCTAssertTrue(MessageBubble.showsAgentWaitingIndicator(
            execution: execution,
            responseText: "requesting…"
        ))
        XCTAssertTrue(MessageBubble.showsAgentWaitingIndicator(
            execution: execution,
            responseText: "  "
        ))
        XCTAssertFalse(
            MessageBubble.showsAgentWaitingIndicator(
                execution: execution,
                responseText: "The rollout is nearly ready."
            )
        )

        let thinkingExecution = AgentExecutionSnapshot(
            phase: .analyzing,
            summary: "Analyzing the request",
            steps: [],
            thinkingText: "Inspect the conversation state.",
            startedAtMs: 1_000,
            updatedAtMs: 2_000,
            completed: false
        )
        XCTAssertFalse(MessageBubble.showsAgentWaitingIndicator(
            execution: thinkingExecution,
            responseText: "processing..."
        ))
        XCTAssertEqual(
            AgentExecutionTimelinePresentation(execution: thinkingExecution).activeOutputStatus,
            "Inspect the conversation state."
        )

        let toolExecution = AgentExecutionSnapshot(
            phase: .usingTool,
            summary: "Using Search",
            steps: [
                AgentExecutionStep(
                    id: "tool:search",
                    label: "Using Search",
                    state: .running
                )
            ],
            tools: [
                AgentExecutionTool(
                    id: "search",
                    name: "Search",
                    status: "running",
                    arguments: #"{"query":"conversation state"}"#,
                    liveOutput: "",
                    resultText: nil,
                    detail: "Searching the conversation state",
                    toolLayer: "observation",
                    isError: false
                )
            ],
            startedAtMs: 1_000,
            updatedAtMs: 2_000,
            completed: false
        )
        XCTAssertFalse(MessageBubble.showsAgentWaitingIndicator(
            execution: toolExecution,
            responseText: "processing..."
        ))
        XCTAssertEqual(
            AgentExecutionTimelinePresentation(execution: toolExecution).activeOutputStatus,
            "Searching the conversation state"
        )
    }

    @MainActor
    func testAgentExecutionSnapshotsForOneRequestKeepOneTimelineIdentity() {
        let model = AppModel(previewMode: true)
        let first = ChatMessage(
            id: "wire-snapshot-1",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "processing...",
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: "request-1"
        )
        let second = ChatMessage(
            id: "wire-snapshot-2",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "Done",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: "request-1"
        )

        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(model.timelineIdentity(for: first), model.timelineIdentity(for: second))
    }

    @MainActor
    func testOptimisticAgentRequestKeepsItsTimelineIdentityAfterServerPromotion() {
        let local = ChatMessage(
            id: "ios-local-request",
            conversationId: "agent-session",
            author: .me,
            authorName: "You",
            text: "Hello",
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .sending,
            errorMessage: nil,
            requestMessageId: nil
        )
        let server = ChatMessage(
            id: "server-request",
            conversationId: "agent-session",
            author: .me,
            authorName: "You",
            text: "Hello",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )
        let presentationIds = [
            local.id: local.id,
            server.id: local.id,
        ]

        XCTAssertEqual(
            AppModel.timelineIdentity(for: local, requestPresentationIds: presentationIds),
            AppModel.timelineIdentity(for: server, requestPresentationIds: presentationIds)
        )
    }

    @MainActor
    func testProjectedMessagesPreserveLocalModelChangeNoticesWithoutCloudMatch() {
        let modelChange = ChatMessage(
            id: "model-change",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "Switched model to openai/gpt-5.6-sol",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatMessage.agentModelChangeMessageKind
        )
        let staleLocalReply = ChatMessage(
            id: "stale-local-reply",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "Stale",
            createdAt: Date(timeIntervalSince1970: 3),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )
        let projectedReply = ChatMessage(
            id: "projected-reply",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "Current",
            createdAt: Date(timeIntervalSince1970: 4),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )

        let merged = AppModel.mergeProjectedMessages(
            [projectedReply],
            preservingLocalMessagesFrom: [modelChange, staleLocalReply]
        )

        XCTAssertEqual(merged.map(\.id), [modelChange.id, projectedReply.id])
        XCTAssertTrue(merged[0].isAgentModelChangeNotice)
    }

    @MainActor
    func testProjectedCloudModelChangeReplacesMatchingLocalNotice() {
        let local = ChatMessage(
            id: "local-model-change",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "Switched model to openai/gpt-5.6-sol",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatMessage.agentModelChangeMessageKind
        )
        let cloud = ChatMessage(
            id: "cloud-model-change",
            conversationId: "agent-session",
            author: .me,
            authorName: "You",
            text: local.text,
            createdAt: local.createdAt.addingTimeInterval(1),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatMessage.agentModelChangeMessageKind
        )

        let merged = AppModel.mergeProjectedMessages(
            [cloud],
            preservingLocalMessagesFrom: [local]
        )

        XCTAssertEqual(merged.map(\.id), [cloud.id])
    }

    @MainActor
    func testProjectedMessagesKeepOnlyUnresolvedFailedOptimisticRowsInChronologicalOrder() {
        let unresolved = ChatMessage(
            id: "ios_unresolved",
            clientMessageId: CloudAPIClient.stableOperationUUID("ios_unresolved"),
            conversationId: "person-session",
            author: .me,
            authorName: "You",
            text: "Try again",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .failed,
            errorMessage: "Message not sent.",
            requestMessageId: nil
        )
        let projected = ChatMessage(
            id: "server-later",
            clientMessageId: "server-later-client",
            conversationId: "person-session",
            author: .person,
            authorName: "Maya",
            text: "Later",
            createdAt: Date(timeIntervalSince1970: 3),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )

        let merged = AppModel.mergeProjectedMessages(
            [projected],
            preservingLocalMessagesFrom: [unresolved]
        )

        XCTAssertEqual(merged.map(\.id), [unresolved.id, projected.id])
    }

    @MainActor
    func testProjectedCanonicalMessageRemovesMatchingFailedOptimisticRow() {
        let clientMessageId = CloudAPIClient.stableOperationUUID("ios_accepted")
        let failed = ChatMessage(
            id: "ios_accepted",
            clientMessageId: clientMessageId,
            conversationId: "person-session",
            author: .me,
            authorName: "You",
            text: "Accepted before the response was lost",
            createdAt: Date(timeIntervalSince1970: 2),
            deliveryState: .failed,
            errorMessage: "Message not sent.",
            requestMessageId: nil
        )
        let canonical = ChatMessage(
            id: "server-message",
            clientMessageId: clientMessageId,
            conversationId: "person-session",
            author: .me,
            authorName: "You",
            text: failed.text,
            createdAt: failed.createdAt,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )

        let merged = AppModel.mergeProjectedMessages(
            [canonical],
            preservingLocalMessagesFrom: [failed]
        )

        XCTAssertEqual(merged.map(\.id), [canonical.id])
        XCTAssertEqual(
            AppModel.mergePartialProjection([canonical], preserving: [failed]).map(\.id),
            [canonical.id]
        )
    }

    func testStableOperationUUIDMakesRetriesIdempotent() {
        let first = CloudAPIClient.stableOperationUUID("ios_retry_message")
        XCTAssertEqual(first, CloudAPIClient.stableOperationUUID("ios_retry_message"))
        XCTAssertNotEqual(first, CloudAPIClient.stableOperationUUID("ios_other_message"))
    }

    @MainActor
    func testEmptyProjectionPreservesLoadedConversationHistory() {
        let cached = ChatMessage(
            id: "cached-message",
            conversationId: "agent-session",
            author: .agent,
            authorName: "My Kordi",
            text: "Cached response",
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )

        XCTAssertEqual(
            AppModel.mergeProjectedMessages([], preservingLocalMessagesFrom: [cached]),
            [cached]
        )
    }

    func testAgentModelChangeNoticeParsesQualifiedModel() {
        XCTAssertEqual(
            ChatMessage.modelFromAgentModelChangeNotice(
                "  Switched model to anthropic/claude-opus-4-1  "
            ),
            "anthropic/claude-opus-4-1"
        )
        XCTAssertNil(ChatMessage.modelFromAgentModelChangeNotice("Model updated"))
        XCTAssertNil(ChatMessage.modelFromAgentModelChangeNotice("Switched model to   "))
    }

    func testRuntimeRouteNoticeUsesTheSharedThinkingDisplayLabel() {
        XCTAssertEqual(
            ChatMessage.runtimeRouteChangeNotice(
                model: "openai/gpt-5.6-sol",
                thinking: "xhigh"
            ),
            "Model: openai/gpt-5.6-sol · Thinking effort: Extra High"
        )
        XCTAssertEqual(
            ChatMessage.modelFromAgentModelChangeNotice(
                "Model: openai/gpt-5.6-sol · Thinking effort: Extra High"
            ),
            "openai/gpt-5.6-sol"
        )
    }

    func testAgentCancelControlDecodesAndIsNeverClassifiedAsContent() {
        let body = "kordi-cloud-agent-cancel:eyJraW5kIjoiYWdlbnQtY2FuY2VsIiwicmVxdWVzdElkIjoibXNnOnVpOjA1ZjY4ZGMxLThkM2YtNDk1NS05MTMxLWI2NDI5MzY5YmNjZSJ9"

        XCTAssertEqual(
            CloudMessageCodec.agentCancelEnvelope(body)?.requestId,
            "msg:ui:05f68dc1-8d3f-4955-9131-b6429369bcce"
        )
        XCTAssertTrue(CloudMessageCodec.isAgentControl(body))
        XCTAssertFalse(CloudMessageCodec.isAgentControl("A visible session message"))
    }
}
