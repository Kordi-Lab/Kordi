import XCTest
@testable import Kordi

final class CloudGroupMessageCodecTests: XCTestCase {
    func testOutboundMessageNormalizesFractionalMilliseconds() throws {
        let participant = CloudGroupParticipant(
            accountId: "acct_me",
            displayName: "Alex",
            avatarUrl: nil,
            role: "self"
        )
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:timestamp",
            groupSpaceId: "session:group:timestamp",
            groupTitle: "Cross-device test",
            createdByAccountId: "acct_me",
            actor: participant,
            participants: [participant],
            message: CloudGroupMessagePayload(
                id: "ios_fractional_message",
                senderAccountId: "acct_me",
                text: "send from iphone test",
                createdAtMs: 1_786_443_676_216.46,
                senderKind: "human",
                senderDisplayName: "Alex",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        )

        let decoded = try XCTUnwrap(CloudGroupMessageCodec.parse(CloudGroupMessageCodec.encode(envelope)))

        XCTAssertEqual(decoded.message?.createdAtMs, 1_786_443_676_216)
    }

    func testGroupMessageRoundTripsAttachmentsReplyAndMentionTarget() throws {
        var runtimeRoute = CloudModelRouting.empty
        runtimeRoute.defaultModel = "openai-codex/gpt-5.6-sol"
        runtimeRoute.defaultAuthProvider = "openai-codex"
        runtimeRoute.defaultAuthChoice = "local-active-oauth"
        runtimeRoute.thinking = "xhigh"
        let participant = CloudGroupParticipant(
            accountId: "acct_me",
            displayName: "Alex",
            avatarUrl: "https://example.com/me.png",
            role: "self"
        )
        let source = MessageActionSource(
            sourceSessionId: "session:group",
            sourceMessageId: "msg_source",
            senderLabel: "Maya",
            textPreview: "Original",
            attachmentCount: 0
        )
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group",
            groupSpaceId: "group:space",
            groupTitle: nil,
            createdByAccountId: "acct_me",
            actor: participant,
            participants: [participant],
            message: CloudGroupMessagePayload(
                id: "msg_reply",
                senderAccountId: "acct_me",
                text: "@Research Agent please review",
                createdAtMs: 1_786_000_000_000,
                senderKind: "human",
                senderDisplayName: "Alex",
                deliveryState: "complete",
                replyToMessageId: "msg_source",
                requestId: nil,
                attachments: [CloudMessageAttachment(
                    attachmentId: "att_1",
                    name: "notes.md",
                    kind: "file",
                    mimeType: "text/markdown",
                    sizeBytes: 512,
                    downloadUrl: nil,
                    previewUrl: nil
                )],
                messageAction: .quote(source),
                targetCloudAgentId: "cloud_agent_research",
                targetCloudAgentName: "Research Agent",
                targetCloudAgentOwnerAccountId: "acct_me",
                targetCloudAgentOwnerName: "Alex",
                agentRuntimeRoute: runtimeRoute
            )
        )

        let decoded = try XCTUnwrap(CloudGroupMessageCodec.parse(CloudGroupMessageCodec.encode(envelope)))

        XCTAssertEqual(decoded.message?.attachments?.first?.name, "notes.md")
        XCTAssertEqual(decoded.message?.messageAction?.source.sourceMessageId, "msg_source")
        XCTAssertEqual(decoded.message?.targetCloudAgentId, "cloud_agent_research")
        XCTAssertEqual(decoded.message?.agentRuntimeRoute, runtimeRoute)
    }

    func testForwardedGroupMessageKeepsSourceWithoutReplyLink() throws {
        let participant = CloudGroupParticipant(
            accountId: "acct_me",
            displayName: "Alex",
            avatarUrl: nil,
            role: "self"
        )
        let source = MessageActionSource(
            sourceSessionId: "session:direct",
            sourceMessageId: "msg_original",
            senderLabel: "Maya",
            textPreview: "Launch update",
            attachmentCount: 0
        )
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group",
            groupSpaceId: "group:space",
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_me",
            actor: participant,
            participants: [participant],
            message: CloudGroupMessagePayload(
                id: "msg_forward",
                senderAccountId: "acct_me",
                text: "Launch update",
                createdAtMs: 1_786_000_000_000,
                senderKind: "human",
                senderDisplayName: "Alex",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil,
                attachments: nil,
                messageAction: .forward(source),
                targetCloudAgentId: nil,
                targetCloudAgentName: nil,
                targetCloudAgentOwnerAccountId: nil,
                targetCloudAgentOwnerName: nil,
                agentRuntimeRoute: nil
            )
        )

        let decoded = try XCTUnwrap(CloudGroupMessageCodec.parse(CloudGroupMessageCodec.encode(envelope)))

        XCTAssertEqual(decoded.message?.messageAction?.kind, "forward")
        XCTAssertNil(decoded.message?.replyToMessageId)
        XCTAssertNil(decoded.message?.messageAction?.replyToMessageId)
    }

    func testAgentLifecycleProjectsOneMonotonicMessagePerRequest() {
        let processing = agentPayload(
            id: "processing",
            text: "processing...",
            state: "processing",
            createdAtMs: 1_000
        )
        let partial = agentPayload(
            id: "partial",
            text: "The response is growing.",
            state: "processing",
            createdAtMs: 2_000
        )
        let lateShorterPartial = agentPayload(
            id: "late-shorter",
            text: "The response",
            state: "processing",
            createdAtMs: 3_000
        )
        let complete = agentPayload(
            id: "complete",
            text: "The response is complete.",
            state: "complete",
            createdAtMs: 4_000
        )

        let processingIds = CloudGroupAgentLifecycleProjector.visibleMessageIds(
            in: [processing, partial, lateShorterPartial]
        )
        let completeIds = CloudGroupAgentLifecycleProjector.visibleMessageIds(
            in: [processing, partial, lateShorterPartial, complete]
        )

        XCTAssertEqual(processingIds, Set(["partial"]))
        XCTAssertEqual(completeIds, Set(["complete"]))
        XCTAssertEqual(
            CloudGroupAgentLifecycleProjector.readRequestIds(in: [processing]),
            Set(["request"])
        )
    }

    private func agentPayload(
        id: String,
        text: String,
        state: String,
        createdAtMs: Double
    ) -> CloudGroupMessagePayload {
        CloudGroupMessagePayload(
            id: id,
            senderAccountId: "acct_owner",
            text: text,
            createdAtMs: createdAtMs,
            senderKind: "agent",
            senderDisplayName: "Owner's Kordi",
            deliveryState: state,
            replyToMessageId: "request",
            requestId: "request"
        )
    }
}
