import XCTest
@testable import Kordi

final class CloudModelDecodingTests: XCTestCase {
    func testCloudSessionVisibilityDecodesMacHiddenAndDeletedSessions() throws {
        let payload = Data(#"{"hiddenSessionIds":["session:hidden"],"deletedSessionIds":["session:deleted"]}"#.utf8)
        let visibility = try JSONDecoder().decode(CloudSessionVisibility.self, from: payload)

        XCTAssertEqual(visibility.hiddenSessionIds, ["session:hidden"])
        XCTAssertEqual(visibility.deletedSessionIds, ["session:deleted"])
    }

    func testCloudSessionPinDecodesSharedAndPrivateMacShape() throws {
        let payload = Data(#"{"sessionId":"session:group","sharedMessageId":"msg_shared","privateMessageId":"msg_private","effectiveMessageId":"msg_private","updatedAt":"2026-08-09T10:00:00Z"}"#.utf8)
        let pin = try JSONDecoder().decode(CloudSessionPin.self, from: payload)

        XCTAssertEqual(pin.sessionId, "session:group")
        XCTAssertEqual(pin.sharedMessageId, "msg_shared")
        XCTAssertEqual(pin.privateMessageId, "msg_private")
        XCTAssertEqual(pin.effectiveMessageId, "msg_private")
    }

    func testOwnedAndSharedAgentShapesDecodeThroughOneModel() throws {
        let owned = Data(#"{"agentId":"cloud_agent_owned","ownerAccountId":"acct_me","accessScope":"participant_conversations","status":"active","name":"Research Agent","role":"Researcher","description":null,"systemPrompt":"Help","sourceSummary":null,"boundaries":[],"resources":[],"skills":[{"name":"research","description":"Research sources","content":"Verify every source."}],"modelRouting":{"defaultModel":"codex/gpt-5.6-sol","thinking":"high","tools":["web-search"],"plugins":["citations"]},"createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","archivedAt":null}"#.utf8)
        let shared = Data(#"{"agentId":"cloud_agent_shared","ownerAccountId":"acct_maya","ownerDisplayName":"Maya","accessScope":"participant_conversations","name":"Support Agent","role":"Support","description":"Answers product questions","updatedAt":"2026-08-08T00:00:00Z"}"#.utf8)

        let decoder = JSONDecoder()
        let ownedAgent = try decoder.decode(CloudAgent.self, from: owned)
        XCTAssertEqual(ownedAgent.status, "active")
        XCTAssertEqual(ownedAgent.modelRouting.defaultModel, "codex/gpt-5.6-sol")
        XCTAssertEqual(ownedAgent.modelRouting.thinking, "high")
        XCTAssertEqual(ownedAgent.modelRouting.tools, ["web-search"])
        XCTAssertEqual(ownedAgent.modelRouting.plugins, ["citations"])
        XCTAssertEqual(ownedAgent.skills.first?.content, "Verify every source.")
        let draft = CloudAgentDraft(agent: ownedAgent)
        XCTAssertEqual(draft.tools.map(\.name), ["web-search"])
        XCTAssertEqual(draft.plugins.map(\.name), ["citations"])
        XCTAssertNil(draft.modelRouting.tools)
        XCTAssertNil(draft.modelRouting.plugins)
        XCTAssertEqual(try decoder.decode(CloudAgent.self, from: shared).ownerDisplayName, "Maya")
    }

    func testContactRequestAndSessionActivityUseProductionCloudShapes() throws {
        let requestPayload = Data(#"{"requestId":"req_1","fromAccountId":"acct_maya","toAccountId":"acct_me","status":"pending","direction":"incoming","message":"Let's connect","createdAt":"2026-08-09T10:00:00Z","decidedAt":null,"counterpart":{"accountId":"acct_maya","kordiId":"284106395","displayName":"Maya","avatarUrl":null,"nodeId":null,"createdAt":"2026-08-09T10:00:00Z"}}"#.utf8)
        let activityPayload = Data(#"{"tasks":[{"taskActivityId":"taskact_1","sessionId":"session:one","taskId":"task_1","title":"Review build","summary":"Check TestFlight","status":"active","createdByAccountId":"acct_me","targetAccountId":null,"participants":[],"artifactIds":[],"responseMessageId":null,"createdAt":"2026-08-09T10:00:00Z","updatedAt":"2026-08-09T10:01:00Z","archivedAt":null}],"artifacts":[{"artifactActivityId":"artifactact_1","sessionId":"session:one","artifactId":"docs/plan.md","name":"plan.md","path":"docs/plan.md","kind":"document","category":"artifact","summary":"Release plan","createdByAccountId":"acct_me","sourceMessageId":"msg_1","attachmentId":null,"contentType":"text/markdown","sizeBytes":42,"createdAt":"2026-08-09T10:00:00Z","updatedAt":"2026-08-09T10:01:00Z","archivedAt":null}]}"#.utf8)

        let request = try JSONDecoder().decode(CloudContactRequest.self, from: requestPayload)
        let activity = try JSONDecoder().decode(CloudSessionActivity.self, from: activityPayload)

        XCTAssertTrue(request.isIncoming)
        XCTAssertEqual(request.counterpart?.preferredName, "Maya")
        XCTAssertEqual(activity.tasks.first?.title, "Review build")
        XCTAssertEqual(activity.artifacts.first?.attachmentId, nil)
    }

    func testCloudMessageDecodesWithoutAttachmentModel() throws {
        let payload = Data(#"{"messageId":"msg_1","fromAccountId":"acct_me","toAccountId":"acct_maya","body":"Hello","createdAt":"2026-08-08T00:00:00Z","deliveredAt":"2026-08-08T00:00:01Z","readAt":null,"direction":"outgoing","sessionId":"session:direct-person:acct_maya:acct_me","attachments":[]}"#.utf8)
        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)
        XCTAssertEqual(message.body, "Hello")
        XCTAssertEqual(message.direction, "outgoing")
        XCTAssertEqual(message.attachments, [])
    }

    func testCloudMessageDecodesAttachmentMetadataUsedByMacOS() throws {
        let payload = Data(#"{"messageId":"msg_file","fromAccountId":"acct_me","toAccountId":"acct_maya","body":"Review this","createdAt":"2026-08-08T00:00:00Z","deliveredAt":"2026-08-08T00:00:01Z","readAt":null,"direction":"outgoing","sessionId":"session:files","attachments":[{"attachmentId":"att_1","name":"launch-plan.pdf","kind":"file","mimeType":"application/pdf","sizeBytes":2048,"downloadUrl":null,"previewUrl":null}]}"#.utf8)
        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)

        XCTAssertEqual(message.attachments.first?.attachmentId, "att_1")
        XCTAssertEqual(message.attachments.first?.name, "launch-plan.pdf")
        XCTAssertEqual(message.attachments.first?.sizeBytes, 2_048)
    }

    func testAgentExecutionLocationNamesOnlyRemoteHosts() {
        XCTAssertEqual(AgentExecutionLocation.cloud.activeLabel, "Running in Kordi Cloud")
        XCTAssertEqual(AgentExecutionLocation.mac(label: "your Mac").activeLabel, "Running on your Mac")
        XCTAssertFalse(AgentExecutionLocation.cloud.activeLabel.localizedCaseInsensitiveContains("iPhone"))
    }

    func testSyncEventDecodesFullHistoricalMessagePayload() throws {
        let payload = Data(#"{"eventId":"42","eventType":"message.upsert","peerAccountId":"acct_me","messageId":"msg_old","payload":{"message":{"messageId":"msg_old","fromAccountId":"acct_me","toAccountId":"acct_me","body":"Older session content","sessionId":"session:desktop:older","createdAt":"2026-08-01T00:00:00Z","deliveredAt":"2026-08-01T00:00:01Z","readAt":"2026-08-01T00:00:01Z","direction":"outgoing","attachments":[]}},"occurredAt":"2026-08-01T00:00:01Z"}"#.utf8)

        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: payload)

        XCTAssertEqual(event.payload?.message?.sessionId, "session:desktop:older")
        XCTAssertEqual(event.payload?.message?.body, "Older session content")
    }

    func testSyncEventDecodesAgentForkLineagePayload() throws {
        let payload = Data(#"{"eventId":"43","eventType":"session-forked","peerAccountId":"session:self-agent:root","messageId":null,"payload":{"forkSessionId":"session:fork:child","parentSessionId":"session:self-agent:root","parentMessageId":"msg_root","createdByAccountId":"acct_me","createdAt":"2026-08-09T10:00:00Z"},"occurredAt":"2026-08-09T10:00:00Z"}"#.utf8)

        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: payload)

        XCTAssertEqual(event.payload?.forkSessionId, "session:fork:child")
        XCTAssertEqual(event.payload?.parentSessionId, "session:self-agent:root")
        XCTAssertEqual(event.payload?.parentMessageId, "msg_root")
    }

    func testChatConversationDecodesDurableForkLineage() throws {
        let payload = Data(#"{"id":"conversation-child","kind":"ai","shared_title":"Child","version":3,"created_by_account_id":"acct_me","legacy_session_id":"session:fork:child","forked_from_session_id":"session:self-agent:root","forked_from_message_id":"msg_root","latest_message_sequence":4,"created_at":"2026-08-09T10:00:00Z","updated_at":"2026-08-09T10:01:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-08-09T10:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-child","account_id":"acct_me","personal_title":null,"version":1}}"#.utf8)

        let conversation = try JSONDecoder().decode(CloudChatConversation.self, from: payload)

        XCTAssertEqual(conversation.legacySessionId, "session:fork:child")
        XCTAssertEqual(conversation.forkedFromSessionId, "session:self-agent:root")
        XCTAssertEqual(conversation.forkedFromMessageId, "msg_root")
    }
}
