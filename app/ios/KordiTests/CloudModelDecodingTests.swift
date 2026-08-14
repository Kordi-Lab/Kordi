import XCTest
import Security
@testable import Kordi

final class CloudModelDecodingTests: XCTestCase {
    func testInstallationDeviceIdentityIsStableAndDistinctAcrossStores() throws {
        let firstService = "io.kordi.tests.device.\(UUID().uuidString)"
        let secondService = "io.kordi.tests.device.\(UUID().uuidString)"
        defer {
            for service in [firstService, secondService] {
                SecItemDelete([
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service
                ] as CFDictionary)
            }
        }
        let firstStore = KeychainSessionStore(service: firstService)
        let secondStore = KeychainSessionStore(service: secondService)

        let firstKey = try firstStore.loadOrCreateDevicePublicKey()
        try firstStore.saveToken("temporary-session")
        try firstStore.deleteToken()

        XCTAssertEqual(firstKey.count, 65)
        XCTAssertEqual(firstKey.first, 0x04)
        XCTAssertEqual(try firstStore.loadOrCreateDevicePublicKey(), firstKey)
        XCTAssertNotEqual(try secondStore.loadOrCreateDevicePublicKey(), firstKey)
    }

    func testCancelledSessionLoadIsNotClassifiedAsACloudConnectionFailure() {
        XCTAssertTrue(CloudTransportErrorPolicy.isCancellation(CancellationError()))
        XCTAssertTrue(CloudTransportErrorPolicy.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(CloudTransportErrorPolicy.isCancellation(URLError(.timedOut)))
    }

    func testDefaultClientUsesConfiguredOriginAndWaitsForConnectivity() {
        XCTAssertEqual(CloudAPIClient.productionBaseURL.absoluteString, "https://kordi.ai")
        XCTAssertTrue(CloudAPIClient.reliableSession.configuration.waitsForConnectivity)
        XCTAssertEqual(CloudAPIClient.reliableSession.configuration.timeoutIntervalForRequest, 30)
    }

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
        XCTAssertNil(message.messageKind)
    }

    func testCloudCallActivityMessageKeepsItsWireKind() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let payload = Data(#"{"messageId":"msg_call","fromAccountId":"acct_maya","toAccountId":"acct_me","body":"Maya started a video chat.","createdAt":"2026-08-14T10:00:00Z","deliveredAt":"2026-08-14T10:00:01Z","readAt":null,"direction":"incoming","sessionId":"session:group","attachments":[],"kind":"call.started.0198aabc-8b27-7a30-8cba-215495609c7a"}"#.utf8)

        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)
        let activity = try XCTUnwrap(ChatCallActivity(messageKind: message.messageKind))

        XCTAssertEqual(message.messageKind, "call.started.\(callID)")
        XCTAssertEqual(activity.event, .started)
        XCTAssertEqual(activity.callId, callID)
        XCTAssertEqual(message.body, "Maya started a video chat.")
    }

    func testCallActivityMatchesOnlyItsOwnActiveCall() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let otherCallID = "0198aabc-8b27-7a30-8cba-215495609c7b"
        let activity = try XCTUnwrap(ChatCallActivity(
            messageKind: ChatCallActivity.messageKind(for: .started, callId: callID)
        ))
        let endedActivity = try XCTUnwrap(ChatCallActivity(
            messageKind: ChatCallActivity.messageKind(for: .ended, callId: callID)
        ))
        let activeCall = CloudCall(
            id: callID,
            conversationId: "conversation",
            kind: .video,
            state: .active,
            createdByAccountId: "acct_maya",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: "2026-08-14T10:00:01Z",
            endedAt: nil,
            participants: []
        )
        let otherCall = CloudCall(
            id: otherCallID,
            conversationId: "conversation",
            kind: .video,
            state: .active,
            createdByAccountId: "acct_maya",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: "2026-08-14T10:00:01Z",
            endedAt: nil,
            participants: []
        )

        XCTAssertTrue(activity.matchesActiveCall(activeCall))
        XCTAssertFalse(activity.matchesActiveCall(otherCall))
        XCTAssertFalse(endedActivity.matchesActiveCall(activeCall))
    }

    func testCachedChatMessagePreservesCallActivityKind() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let original = ChatMessage(
            id: "call-event",
            conversationId: "conversation",
            author: .person,
            authorName: "Maya",
            text: "The video call ended.",
            createdAt: Date(timeIntervalSince1970: 1_000),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatCallActivity.messageKind(for: .ended, callId: callID)
        )

        let restored = try JSONDecoder().decode(
            ChatMessage.self,
            from: JSONEncoder().encode(original)
        )

        XCTAssertEqual(restored.messageKind, original.messageKind)
        XCTAssertEqual(restored.callActivity?.event, .ended)
        XCTAssertEqual(restored.callActivity?.callId, callID)
    }

    func testCallSessionDecodesParticipantsAndShortLivedMediaConnection() throws {
        let payload = Data(#"{"call":{"id":"0198aabc-8b27-7a30-8cba-215495609c7a","conversation_id":"0198aabc-4b58-7770-b486-a8e3fb4d0b7e","kind":"meeting","state":"active","created_by_account_id":"acct_maya","created_at":"2026-08-14T10:00:00Z","answered_at":null,"ended_at":null,"participants":[{"account_id":"acct_maya","display_name":"Maya","avatar_url":null,"state":"joined","joined_at":"2026-08-14T10:00:00Z","left_at":null},{"account_id":"acct_me","display_name":"Alex","avatar_url":null,"state":"invited","joined_at":null,"left_at":null}]},"media":{"url":"wss://media.example.test","token":"short-lived-token"}}"#.utf8)

        let response = try JSONDecoder().decode(CloudCallSessionResponse.self, from: payload)

        XCTAssertEqual(response.call.kind, .meeting)
        XCTAssertEqual(response.call.state, .active)
        XCTAssertEqual(response.call.participants.map(\.state), ["joined", "invited"])
        XCTAssertEqual(response.media.url, "wss://media.example.test")
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

    func testDeviceListDecodesReviewAndSyncStateWithoutKeyMaterial() throws {
        let payload = Data(#"{"devices":[{"deviceId":"device_1","displayName":"Ada’s iPhone","platform":"ios","osVersion":"27.0","appVersion":"1.0","createdAt":"2026-08-13T09:00:00Z","lastActiveAt":"2026-08-13T09:05:00Z","authorizationState":"pending_review","currentDevice":false,"sessionExpiresAt":"2026-09-12T09:00:00Z","approximateLocation":null,"syncStatus":{"protocolVersion":2,"lastAppliedSequence":42,"lastSuccessfulCatchUpAt":"2026-08-13T09:04:00Z"}}]}"#.utf8)

        let response = try JSONDecoder().decode(CloudDeviceListResponse.self, from: payload)
        let device = try XCTUnwrap(response.devices.first)

        XCTAssertTrue(device.needsReview)
        XCTAssertFalse(device.currentDevice)
        XCTAssertEqual(device.syncStatus.protocolVersion, 2)
        XCTAssertEqual(device.syncStatus.lastAppliedSequence, 42)
    }

    func testAuthSessionAcceptsDeviceBindingAndLegacyResponses() throws {
        let decoder = JSONDecoder()
        let bound = try decoder.decode(
            CloudSession.self,
            from: Data(#"{"token":"token","expiresAt":"2026-09-12T09:00:00Z","deviceId":"device_1"}"#.utf8)
        )
        let legacy = try decoder.decode(
            CloudSession.self,
            from: Data(#"{"token":"legacy","expiresAt":"2026-09-12T09:00:00Z"}"#.utf8)
        )

        XCTAssertEqual(bound.deviceId, "device_1")
        XCTAssertNil(legacy.deviceId)
    }

    func testDeviceLifecycleEventCarriesTheAffectedInstallation() throws {
        let payload = Data(#"{"eventId":"44","eventType":"device.added","peerAccountId":"acct_me","messageId":null,"payload":{"deviceId":"device_other","authorizationState":"pending_review"},"occurredAt":"2026-08-13T09:00:00Z"}"#.utf8)

        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: payload)

        XCTAssertEqual(event.payload?.deviceId, "device_other")
    }

    func testChatConversationDecodesDurableForkLineage() throws {
        let payload = Data(#"{"id":"conversation-child","kind":"ai","shared_title":"Child","version":3,"created_by_account_id":"acct_me","legacy_session_id":"session:fork:child","forked_from_session_id":"session:self-agent:root","forked_from_message_id":"msg_root","latest_message_sequence":4,"created_at":"2026-08-09T10:00:00Z","updated_at":"2026-08-09T10:01:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-08-09T10:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-child","account_id":"acct_me","personal_title":null,"version":1}}"#.utf8)

        let conversation = try JSONDecoder().decode(CloudChatConversation.self, from: payload)

        XCTAssertEqual(conversation.legacySessionId, "session:fork:child")
        XCTAssertEqual(conversation.forkedFromSessionId, "session:self-agent:root")
        XCTAssertEqual(conversation.forkedFromMessageId, "msg_root")
    }
}
