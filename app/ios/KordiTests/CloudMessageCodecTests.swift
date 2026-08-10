import XCTest
@testable import Kordi

final class CloudMessageCodecTests: XCTestCase {
    func testDirectAgentEnvelopeRoundTripsDisplayTextAndTarget() throws {
        var runtimeRoute = CloudModelRouting.empty
        runtimeRoute.defaultModel = "openai-codex/gpt-5.6-sol"
        runtimeRoute.defaultAuthProvider = "openai-codex"
        runtimeRoute.defaultAuthChoice = "local-active-oauth"
        runtimeRoute.thinking = "high"
        let encoded = try CloudMessageCodec.encodeDirect(
            text: "Summarize the launch notes",
            agentId: "cloud_agent_research",
            agentName: "Research Agent",
            ownerAccountId: "acct_owner",
            ownerName: "Maya",
            agentRuntimeRoute: runtimeRoute
        )

        XCTAssertTrue(encoded.hasPrefix(CloudMessageCodec.directPrefix))
        XCTAssertEqual(CloudMessageCodec.displayText(encoded), "Summarize the launch notes")
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.targetCloudAgentId, "cloud_agent_research")
        XCTAssertEqual(CloudMessageCodec.directEnvelope(encoded)?.targetCloudAgentOwnerAccountId, "acct_owner")
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
