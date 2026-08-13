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
}
