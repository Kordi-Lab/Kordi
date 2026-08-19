import XCTest
@testable import Kordi

final class CloudDirectMessageProjectorTests: XCTestCase {
    func testCancelEnvelopeBecomesReadableTerminalMessageWithoutLeakingWireText() {
        let requestId = "msg:ui:05f68dc1-8d3f-4955-9131-b6429369bcce"
        let cancel = "kordi-cloud-agent-cancel:eyJraW5kIjoiYWdlbnQtY2FuY2VsIiwicmVxdWVzdElkIjoibXNnOnVpOjA1ZjY4ZGMxLThkM2YtNDk1NS05MTMxLWI2NDI5MzY5YmNjZSJ9"
        let messages = [
            wire(id: requestId, body: "check all my chat", createdAt: "2026-08-08T10:00:00Z"),
            wire(id: "cancel", body: cancel, createdAt: "2026-08-08T10:00:01Z")
        ]

        let projected = CloudDirectMessageProjector.project(
            messages,
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.map(\.text), ["check all my chat", "Request canceled by sender."])
        XCTAssertFalse(projected.contains { $0.text.hasPrefix(CloudMessageCodec.agentCancelPrefix) })
        XCTAssertEqual(projected.last?.deliveryState, .cancelled)
        XCTAssertEqual(projected.last?.requestMessageId, requestId)
    }

    func testProjectorPreservesAttachmentAndReplyMetadata() throws {
        let source = MessageActionSource(
            sourceSessionId: conversation.sessionId,
            sourceMessageId: "msg_source",
            senderLabel: "Maya",
            textPreview: "Please review this",
            attachmentCount: 0
        )
        let body = try CloudMessageCodec.encodeDirect(
            text: "Looks good",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil,
            messageAction: .quote(source)
        )
        let message = CloudMessageDTO(
            messageId: "msg_reply",
            clientMessageId: "client_reply",
            fromAccountId: "acct_me",
            toAccountId: "acct_me",
            body: body,
            createdAt: "2026-08-08T10:00:00Z",
            deliveredAt: "2026-08-08T10:00:01Z",
            readAt: nil,
            direction: "outgoing",
            sessionId: conversation.sessionId,
            attachments: [CloudMessageAttachment(
                attachmentId: "att_1",
                name: "review.png",
                kind: "image",
                subtype: .meme,
                altText: "A reviewer approves the final change.",
                mimeType: "image/png",
                sizeBytes: 2_048,
                downloadUrl: nil,
                previewUrl: nil
            )]
        )

        let projected = CloudDirectMessageProjector.project(
            [message],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.first?.attachments.first?.name, "review.png")
        XCTAssertEqual(projected.first?.attachments.first?.subtype, .meme)
        XCTAssertEqual(projected.first?.attachments.first?.altText, "A reviewer approves the final change.")
        XCTAssertEqual(projected.first?.replyToMessageId, "msg_source")
        XCTAssertEqual(projected.first?.messageAction?.source.senderLabel, "Maya")
        XCTAssertEqual(projected.first?.clientMessageId, "client_reply")
    }

    func testProjectorPreservesCallActivityKind() {
        let message = CloudMessageDTO(
            messageId: "msg_call",
            fromAccountId: "acct_me",
            toAccountId: "acct_peer",
            body: "Maya started a video chat.",
            createdAt: "2026-08-14T10:00:00Z",
            deliveredAt: "2026-08-14T10:00:01Z",
            readAt: nil,
            direction: "incoming",
            sessionId: conversation.sessionId,
            messageKind: "call"
        )

        let projected = CloudDirectMessageProjector.project(
            [message],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.first?.messageKind, "call")
    }

    func testRuntimeRouteChangeWithLegacyTextKindProjectsAsSessionNotice() throws {
        var route = CloudModelRouting.empty
        route.defaultModel = "anthropic/claude-fable-5"
        route.defaultAuthProvider = "anthropic"
        route.defaultAuthChoice = "local-active-oauth"
        let body = try CloudMessageCodec.encodeDirect(
            text: "Switched model to anthropic/claude-fable-5",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil,
            agentRuntimeRoute: route
        )
        let message = CloudMessageDTO(
            messageId: "legacy-route-change",
            fromAccountId: "acct_me",
            toAccountId: "acct_me",
            body: body,
            createdAt: "2026-08-17T06:24:00Z",
            deliveredAt: "2026-08-17T06:24:00Z",
            readAt: nil,
            direction: "outgoing",
            sessionId: conversation.sessionId,
            messageKind: "text"
        )

        let projected = CloudDirectMessageProjector.project(
            [message],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.first?.messageKind, ChatMessage.agentModelChangeMessageKind)
        XCTAssertTrue(projected.first?.isAgentModelChangeNotice == true)
    }

    func testOrdinaryTextThatLooksLikeAModelChangeRemainsAChatMessage() throws {
        let body = try CloudMessageCodec.encodeDirect(
            text: "Switched model to anthropic/claude-fable-5",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil
        )
        let message = CloudMessageDTO(
            messageId: "ordinary-text",
            fromAccountId: "acct_me",
            toAccountId: "acct_me",
            body: body,
            createdAt: "2026-08-17T06:24:00Z",
            deliveredAt: "2026-08-17T06:24:00Z",
            readAt: nil,
            direction: "outgoing",
            sessionId: conversation.sessionId,
            messageKind: "text"
        )

        let projected = CloudDirectMessageProjector.project(
            [message],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.first?.messageKind, "text")
        XCTAssertFalse(projected.first?.isAgentModelChangeNotice == true)
    }

    func testLegacyMacImageMetadataStillProjectsAsAnInlineImage() {
        let mimeTypedImage = CloudMessageAttachment(
            attachmentId: "att_screenshot_mime",
            name: "Screenshot 2026-08-10 at 12.26.00",
            kind: "file",
            mimeType: "image/png",
            sizeBytes: 20_480,
            downloadUrl: nil,
            previewUrl: nil
        )
        let extensionTypedImage = CloudMessageAttachment(
            attachmentId: "att_screenshot_extension",
            name: "Screenshot 2026-08-10 at 12.26.00.PNG",
            kind: "attachment",
            mimeType: nil,
            sizeBytes: 20_480,
            downloadUrl: nil,
            previewUrl: nil
        )
        let document = CloudMessageAttachment(
            attachmentId: "att_document",
            name: "release-notes.pdf",
            kind: "file",
            mimeType: "application/pdf",
            sizeBytes: 20_480,
            downloadUrl: nil,
            previewUrl: nil
        )

        XCTAssertEqual(mimeTypedImage.chatAttachment.kind, .image)
        XCTAssertEqual(extensionTypedImage.chatAttachment.kind, .image)
        XCTAssertEqual(document.chatAttachment.kind, .file)
    }

    func testForwardMetadataDoesNotCreateAReplyLink() throws {
        let source = MessageActionSource(
            sourceSessionId: "session:source",
            sourceMessageId: "msg_source",
            senderLabel: "Maya",
            textPreview: "Original update",
            attachmentCount: 0
        )
        let body = try CloudMessageCodec.encodeDirect(
            text: "Original update",
            agentId: nil,
            agentName: nil,
            ownerAccountId: nil,
            ownerName: nil,
            messageAction: .forward(source)
        )
        let projected = CloudDirectMessageProjector.project(
            [wire(id: "msg_forward", body: body, createdAt: "2026-08-08T10:00:00Z")],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.first?.messageAction?.kind, "forward")
        XCTAssertEqual(projected.first?.messageAction?.source, source)
        XCTAssertNil(projected.first?.replyToMessageId)
    }

    func testAgentResponseLinksBackToItsRequestLikeMacOS() throws {
        let encoded = try XCTUnwrap(#"{"text":"Done","requestId":"msg_request","deliveryState":"complete"}"#.data(using: .utf8))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let responseBody = CloudMessageCodec.agentResponsePrefix + encoded
        let messages = [
            wire(id: "msg_request", body: "Do the work", createdAt: "2026-08-08T10:00:00Z"),
            wire(id: "msg_response", body: responseBody, createdAt: "2026-08-08T10:00:01Z")
        ]

        let projected = CloudDirectMessageProjector.project(
            messages,
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.last?.requestMessageId, "msg_request")
        XCTAssertEqual(projected.last?.replyToMessageId, "msg_request")
    }

    func testTerminalResponseReplacesEarlierProcessingRow() throws {
        let processing = try agentResponse(
            requestId: "msg_request",
            text: "processing...",
            deliveryState: "processing"
        )
        let complete = try agentResponse(
            requestId: "msg_request",
            text: "The rollout is ready.",
            deliveryState: "complete"
        )

        let projected = CloudDirectMessageProjector.project(
            [
                wire(id: "msg_request", body: "Prepare the rollout", createdAt: "2026-08-08T10:00:00Z"),
                wire(id: "msg_processing", body: processing, createdAt: "2026-08-08T10:00:01Z"),
                wire(id: "msg_complete", body: complete, createdAt: "2026-08-08T10:00:02Z")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.map(\.text), ["Prepare the rollout", "The rollout is ready."])
        XCTAssertEqual(
            CloudAgentLifecycleProjector.activity(in: [
                wire(id: "msg_processing", body: processing, createdAt: "2026-08-08T10:00:01Z"),
                wire(id: "msg_complete", body: complete, createdAt: "2026-08-08T10:00:02Z")
            ]),
            .ready
        )
    }

    func testTerminalResponseRetainsTheLatestRealExecutionTrajectory() throws {
        let processing = try agentResponse(
            requestId: "msg_request",
            text: "processing...",
            deliveryState: "processing",
            execution: [
                "phase": "using-tool",
                "summary": "Running the disk usage command",
                "steps": [[
                    "id": "tool:disk-usage",
                    "label": "Check disk usage",
                    "state": "complete"
                ]],
                "thinkingText": "Inspect the real APFS volume values.",
                "updatedAtMs": 2_000,
                "startedAtMs": 1_000,
                "completed": false
            ]
        )
        let complete = try agentResponse(
            requestId: "msg_request",
            text: "The disk has 218 GiB available.",
            deliveryState: "complete"
        )

        let projected = CloudDirectMessageProjector.project(
            [
                wire(id: "msg_request", body: "Check disk usage", createdAt: "2026-08-08T10:00:00Z"),
                wire(id: "msg_processing", body: processing, createdAt: "2026-08-08T10:00:01Z"),
                wire(id: "msg_complete", body: complete, createdAt: "2026-08-08T10:00:02Z")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.count, 2)
        XCTAssertEqual(projected.first?.deliveryState, .read)
        XCTAssertEqual(projected.last?.text, "The disk has 218 GiB available.")
        XCTAssertEqual(projected.last?.agentExecution?.phase, .complete)
        XCTAssertEqual(projected.last?.agentExecution?.summary, "Running the disk usage command")
        XCTAssertEqual(
            projected.last?.agentExecution?.thinkingText,
            "Inspect the real APFS volume values."
        )
        XCTAssertTrue(projected.last?.agentExecution?.completed == true)
    }

    func testDelayedResponseStaysBesideItsRequestInsteadOfJumpingBelowNewerTurns() throws {
        let firstResponse = try agentResponse(
            requestId: "msg_first_request",
            text: "first answer",
            deliveryState: "complete"
        )
        let secondResponse = try agentResponse(
            requestId: "msg_second_request",
            text: "second answer",
            deliveryState: "complete"
        )

        let projected = CloudDirectMessageProjector.project(
            [
                wire(id: "msg_first_request", body: "first request", createdAt: "2026-08-16T16:58:00Z"),
                wire(id: "msg_second_request", body: "second request", createdAt: "2026-08-16T16:58:01Z"),
                wire(id: "msg_second_response", body: secondResponse, createdAt: "2026-08-16T16:58:02Z"),
                wire(id: "msg_delayed_first_response", body: firstResponse, createdAt: "2026-08-16T16:59:00Z")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(
            projected.map(\.text),
            ["first request", "first answer", "second request", "second answer"]
        )
    }

    func testOwnerExecutionTimelineProjectsOnlyInsideTheOwnersSelfAgentSession() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "agent-response",
            "requestId": "msg_request",
            "text": "processing...",
            "deliveryState": "processing",
            "execution": [
                "phase": "analyzing",
                "summary": "Analyzing the request",
                "steps": [[
                    "id": "analysis",
                    "label": "Analyzing the request",
                    "state": "running"
                ]],
                "updatedAtMs": 2_000,
                "completed": false
            ]
        ])
        let body = CloudMessageCodec.agentResponsePrefix + data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let selfMessage = wire(
            id: "msg_owner_progress",
            body: body,
            createdAt: "2026-08-08T10:00:01Z"
        )
        let peerMessage = CloudMessageDTO(
            messageId: "msg_peer_progress",
            fromAccountId: "acct_peer",
            toAccountId: "acct_me",
            body: body,
            createdAt: "2026-08-08T10:00:01Z",
            deliveredAt: nil,
            readAt: nil,
            direction: "incoming",
            sessionId: conversation.sessionId
        )

        let ownerProjected = CloudDirectMessageProjector.project(
            [selfMessage],
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let peerProjected = CloudDirectMessageProjector.project(
            [peerMessage],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(ownerProjected.first?.agentExecution?.phase, .analyzing)
        XCTAssertNil(peerProjected.first?.agentExecution)
    }

    func testLatestOwnerProcessingSnapshotStreamsInPlace() throws {
        let analyzing = try agentResponse(
            requestId: "msg_request",
            text: "processing...",
            deliveryState: "processing",
            execution: [
                "phase": "analyzing",
                "summary": "Analyzing the request",
                "steps": [[
                    "id": "analysis",
                    "label": "Analyzing the request",
                    "state": "running"
                ]],
                "updatedAtMs": 1_000,
                "completed": false
            ]
        )
        let usingTool = try agentResponse(
            requestId: "msg_request",
            text: "processing...",
            deliveryState: "processing",
            execution: [
                "phase": "using-tool",
                "summary": "Using Web Search",
                "steps": [[
                    "id": "tool:web-search",
                    "label": "Using Web Search",
                    "state": "running"
                ]],
                "updatedAtMs": 2_000,
                "completed": false
            ]
        )

        let projected = CloudDirectMessageProjector.project(
            [
                wire(id: "msg_execution_1", body: analyzing, createdAt: "2026-08-08T10:00:01Z"),
                wire(id: "msg_execution_2", body: usingTool, createdAt: "2026-08-08T10:00:02Z")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.count, 1)
        XCTAssertEqual(projected.first?.id, "msg_execution_2")
        XCTAssertEqual(projected.first?.agentExecution?.summary, "Using Web Search")
    }

    func testLateShorterProcessingSnapshotCannotRegressPartialResponse() throws {
        let growing = try agentResponse(
            requestId: "msg_request",
            text: "The rollout is nearly ready.",
            deliveryState: "processing",
            execution: [
                "phase": "writing",
                "summary": "Writing the response",
                "steps": [[
                    "id": "response",
                    "label": "Writing the response",
                    "state": "running"
                ]],
                "updatedAtMs": 2_000,
                "completed": false
            ]
        )
        let lateShorter = try agentResponse(
            requestId: "msg_request",
            text: "The rollout",
            deliveryState: "processing",
            execution: [
                "phase": "writing",
                "summary": "Writing the response",
                "steps": [],
                "updatedAtMs": 1_000,
                "completed": false
            ]
        )

        let projected = CloudDirectMessageProjector.project(
            [
                wire(id: "msg_partial", body: growing, createdAt: "2026-08-08T10:00:01Z"),
                wire(id: "msg_late_short", body: lateShorter, createdAt: "2026-08-08T10:00:02Z")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.count, 1)
        XCTAssertEqual(projected.first?.text, "The rollout is nearly ready.")
        XCTAssertEqual(projected.first?.agentExecution?.updatedAtMs, 2_000)
        XCTAssertFalse(projected.first?.agentExecution?.completed ?? true)
    }

    func testLateProcessingHeartbeatCannotRegressTerminalResponse() throws {
        let complete = try agentResponse(
            requestId: "msg_request",
            text: "Finished once.",
            deliveryState: "complete"
        )
        let lateProcessing = try agentResponse(
            requestId: "msg_request",
            text: "processing...",
            deliveryState: "processing"
        )

        let projected = CloudDirectMessageProjector.project(
            [
                wire(id: "msg_complete", body: complete, createdAt: "2026-08-08T10:00:02Z"),
                wire(id: "msg_late_processing", body: lateProcessing, createdAt: "2026-08-08T10:00:03Z")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.map(\.text), ["Finished once."])
        XCTAssertEqual(
            CloudAgentLifecycleProjector.state(
                forRequestId: "msg_request",
                in: [
                    wire(id: "msg_complete", body: complete, createdAt: "2026-08-08T10:00:02Z"),
                    wire(id: "msg_late_processing", body: lateProcessing, createdAt: "2026-08-08T10:00:03Z")
                ]
            ),
            .complete
        )
    }

    func testCanonicalProcessingAndFailureMapToConversationActivity() throws {
        let processing = try agentResponse(
            requestId: "msg_processing_request",
            text: "processing...",
            deliveryState: "processing"
        )
        let failed = try agentResponse(
            requestId: "msg_failed_request",
            text: "No provider configured yet.",
            deliveryState: "failed"
        )

        XCTAssertEqual(
            CloudAgentLifecycleProjector.activity(in: [
                wire(id: "msg_processing", body: processing, createdAt: "2026-08-08T10:00:01Z")
            ]),
            .replying
        )
        XCTAssertEqual(
            CloudAgentLifecycleProjector.activity(in: [
                wire(id: "msg_processing", body: processing, createdAt: "2026-08-08T10:00:01Z"),
                wire(id: "msg_failed", body: failed, createdAt: "2026-08-08T10:00:02Z")
            ]),
            .failed
        )
    }

    private var conversation: ConversationSummary {
        ConversationSummary(
            id: "agent-session:session:plain-id",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "Check all my chat",
            lastMessage: "check all my chat",
            lastActivityAt: .distantPast,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:plain-id",
            agentDisplayName: "My Kordi"
        )
    }

    private func wire(id: String, body: String, createdAt: String) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: "acct_me",
            toAccountId: "acct_me",
            body: body,
            createdAt: createdAt,
            deliveredAt: createdAt,
            readAt: createdAt,
            direction: "outgoing",
            sessionId: "session:plain-id"
        )
    }

    private func agentResponse(
        requestId: String,
        text: String,
        deliveryState: String,
        execution: [String: Any]? = nil
    ) throws -> String {
        var payload: [String: Any] = [
            "kind": "agent-response",
            "requestId": requestId,
            "text": text,
            "deliveryState": deliveryState
        ]
        if let execution {
            payload["execution"] = execution
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return CloudMessageCodec.agentResponsePrefix + data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
