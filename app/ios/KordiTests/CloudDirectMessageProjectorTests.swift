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
                name: "review.pdf",
                kind: "file",
                mimeType: "application/pdf",
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

        XCTAssertEqual(projected.first?.attachments.first?.name, "review.pdf")
        XCTAssertEqual(projected.first?.replyToMessageId, "msg_source")
        XCTAssertEqual(projected.first?.messageAction?.source.senderLabel, "Maya")
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
        deliveryState: String
    ) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "agent-response",
            "requestId": requestId,
            "text": text,
            "deliveryState": deliveryState
        ])
        return CloudMessageCodec.agentResponsePrefix + data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
