import XCTest
@testable import Kordi

final class CloudGroupMessageCodecTests: XCTestCase {
    func testOutboundGroupControlsNeverTransportAvatarImageValues() throws {
        let actor = CloudGroupParticipant(
            accountId: "acct_me",
            displayName: "Me",
            avatarUrl: "data:image/jpeg;base64,\(String(repeating: "a", count: 190_000))",
            role: "owner"
        )
        let peer = CloudGroupParticipant(
            accountId: "acct_peer",
            displayName: "Peer",
            avatarUrl: "https://images.example/peer.jpg",
            role: "member"
        )
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:avatars",
            groupSpaceId: "session:group:avatars",
            groupTitle: "Avatar test",
            createdByAccountId: actor.accountId,
            actor: actor,
            participants: [actor, peer],
            message: CloudGroupMessagePayload(
                id: "message",
                senderAccountId: actor.accountId,
                text: "hello",
                createdAtMs: 1,
                senderKind: "human",
                senderDisplayName: actor.displayName,
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        )

        let body = try CloudGroupMessageCodec.encode(envelope)
        let decoded = try XCTUnwrap(CloudGroupMessageCodec.parse(body))

        XCTAssertNil(decoded.actor.avatarUrl)
        XCTAssertTrue(decoded.participants.allSatisfy { $0.avatarUrl == nil })
        XCTAssertLessThan(body.utf8.count, 4_096)
    }

    func testGroupAvatarOrderUsesJoinTimeThenAccountIdentity() {
        let participants = [
            CloudGroupParticipant(
                accountId: "acct_z",
                displayName: "Later",
                avatarUrl: nil,
                role: "member",
                joinedAt: "2026-08-25T10:00:00Z"
            ),
            CloudGroupParticipant(
                accountId: "acct_b",
                displayName: "First B",
                avatarUrl: nil,
                role: "member",
                joinedAt: "2026-08-24T10:00:00Z"
            ),
            CloudGroupParticipant(
                accountId: "acct_a",
                displayName: "First A",
                avatarUrl: nil,
                role: "member",
                joinedAt: "2026-08-24T10:00:00Z"
            )
        ]

        XCTAssertEqual(
            participants.sorted(by: CloudGroupParticipant.canonicalPrecedes).map(\.accountId),
            ["acct_a", "acct_b", "acct_z"]
        )
    }


    func testCanonicalGroupCallActivityProjectsWithoutALegacyGroupEnvelope() {
        let conversation = ConversationSummary(
            id: "group:mobile",
            kind: .group,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: "Mobile builders",
            displayName: "Mobile builders",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:mobile",
            groupSpaceId: "session:group:mobile"
        )
        let wire = CloudMessageDTO(
            messageId: "call-activity",
            fromAccountId: "acct_me",
            toAccountId: "acct_peer",
            body: "The video chat ended. Duration 00:05.",
            createdAt: "2026-08-14T10:00:00Z",
            deliveredAt: "2026-08-14T10:00:01Z",
            readAt: nil,
            direction: "outgoing",
            sessionId: conversation.sessionId,
            messageKind: "call.ended.0198aabc-8b27-7a30-8cba-215495609c7a"
        )

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [wire]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.map(\.text), [wire.body])
        XCTAssertTrue(projected.allSatisfy(\.isSystemNotice))
    }

    func testCanonicalGroupTextProjectsWithoutALegacyGroupEnvelope() throws {
        let conversation = ConversationSummary(
            id: "group:mobile",
            kind: .group,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: "Mobile builders",
            displayName: "Mobile builders",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupParticipants: [
                CloudGroupParticipant(
                    accountId: "acct_peer",
                    displayName: "Maya",
                    avatarUrl: nil,
                    role: "member"
                )
            ]
        )
        let wire = CloudMessageDTO(
            messageId: "canonical-message",
            fromAccountId: "acct_peer",
            toAccountId: "acct_me",
            body: "Synced canonical group text",
            createdAt: "2026-08-14T10:00:00Z",
            editedAt: "2026-08-14T10:01:00Z",
            deliveredAt: "2026-08-14T10:00:01Z",
            readAt: nil,
            direction: "incoming",
            sessionId: conversation.sessionId,
            conversationId: "conversation-canonical",
            conversationSequence: 4,
            version: 2
        )

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [wire]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first)

        XCTAssertEqual(message.text, wire.body)
        XCTAssertEqual(message.authorName, "Maya")
        XCTAssertEqual(message.cloudMessageVersion, 2)
        XCTAssertTrue(message.isEdited)
        XCTAssertEqual(message.reactionTargetMessageId, wire.messageId)
    }

    func testGroupAgentResponseProjectsLinkedBackgroundSession() throws {
        let participant = CloudGroupParticipant(
            accountId: "acct_me",
            displayName: "Alex",
            avatarUrl: nil,
            role: "admin"
        )
        let tool = AgentExecutionTool(
            id: "background-session:session-child",
            name: "task_operator",
            status: "completed",
            arguments: "{}",
            liveOutput: "",
            resultText: "Task agent running\n\nBackground session: {\"sessionId\":\"session-child\",\"turnId\":\"turn-child\",\"title\":\"Review runtime\",\"status\":\"running\"}",
            detail: "Started linked background session",
            toolLayer: "operator",
            isError: false
        )
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_me",
            actor: participant,
            participants: [participant],
            message: CloudGroupMessagePayload(
                id: "agent-response",
                senderAccountId: "acct_me",
                text: "Background session started",
                createdAtMs: 1_000,
                senderKind: "agent",
                senderDisplayName: "My Kordi",
                deliveryState: "complete",
                replyToMessageId: "request",
                requestId: "request",
                structuredContent: CloudGroupStructuredContent(tools: [tool])
            )
        )
        let body = try CloudGroupMessageCodec.encode(envelope)
        let conversation = ConversationSummary(
            id: "group:mobile",
            kind: .group,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: "Mobile builders",
            displayName: "Mobile builders",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupParticipants: [participant]
        )
        let projected = AppModel.mapGroupMessages(
            [groupWire(id: "wire-agent-response", body: body, to: "acct_me")],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(
            CloudGroupMessageCodec.parse(body)?.message?.structuredContent?.tools,
            [tool]
        )
        XCTAssertEqual(projected.first?.backgroundAgentSessions.first?.sessionId, "session-child")
        XCTAssertEqual(projected.first?.backgroundAgentSessions.first?.state, .running)
    }

    func testGroupMemberJoinsRoundTripProjectAndDeduplicateReplay() throws {
        let participants = [
            CloudGroupParticipant(
                accountId: "acct_me",
                displayName: "Alex Morgan",
                avatarUrl: nil,
                role: "admin"
            ),
            CloudGroupParticipant(
                accountId: "acct_maya",
                displayName: "Maya Chen",
                avatarUrl: nil,
                role: "person"
            ),
            CloudGroupParticipant(
                accountId: "acct_ethan",
                displayName: "Ethan Park",
                avatarUrl: nil,
                role: "person"
            )
        ]
        let joins = [
            CloudGroupMemberJoin(
                eventId: "invite_event_maya",
                accountId: "acct_maya",
                displayName: "Maya Chen",
                createdAtMs: 1_234
            ),
            CloudGroupMemberJoin(
                eventId: "invite_event_ethan",
                accountId: "acct_ethan",
                displayName: "Ethan Park",
                createdAtMs: 1_235
            )
        ]
        let envelope = CloudGroupControlEnvelope(
            kind: "group-invite",
            groupId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_me",
            actor: participants[0],
            participants: participants,
            memberJoins: joins,
            message: nil
        )
        let body = try CloudGroupMessageCodec.encode(envelope)

        XCTAssertEqual(CloudGroupMessageCodec.parse(body)?.memberJoins, joins)

        let conversation = ConversationSummary(
            id: "group:mobile",
            kind: .group,
            peerAccountId: "acct_maya",
            agentId: nil,
            ownerDisplayName: "Mobile builders",
            displayName: "main",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 2),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupParticipants: participants
        )
        let projected = AppModel.mapGroupMessages(
            [
                groupWire(id: "wire-copy-a", body: body, to: "acct_maya"),
                groupWire(id: "wire-copy-b", body: body, to: "acct_ethan")
            ],
            conversation: conversation,
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(projected.map(\.id), [
            "msg:group-member-join:invite_event_maya:session:group:mobile",
            "msg:group-member-join:invite_event_ethan:session:group:mobile"
        ])
        XCTAssertEqual(projected.map(\.text), [
            "Maya Chen joined the group, invited by Alex Morgan.",
            "Ethan Park joined the group, invited by Alex Morgan."
        ])
        XCTAssertTrue(projected.allSatisfy(\.isGroupMemberJoinNotice))
        XCTAssertTrue(projected.allSatisfy(\.isSystemNotice))
    }

    func testGroupMemberJoinNoticeBreaksMessageGrouping() {
        let start = Date(timeIntervalSince1970: 1_000)
        let messages = [
            timelineMessage(id: "before", text: "Before", date: start),
            timelineMessage(
                id: "join",
                text: "Ethan Park joined the group, invited by Alex Morgan.",
                date: start.addingTimeInterval(10),
                messageKind: ChatMessage.groupMemberJoinMessageKind
            ),
            timelineMessage(id: "after", text: "After", date: start.addingTimeInterval(20))
        ]

        let presentation = ConversationTimelinePresentation.make(
            messages: messages,
            selfAccountId: "acct_me",
            participants: [
                CloudGroupParticipant(
                    accountId: "acct_maya",
                    displayName: "Maya Chen",
                    avatarUrl: nil,
                    role: "person"
                )
            ]
        )

        XCTAssertEqual(presentation.map(\.groupedWithPrevious), [false, false, false])
        XCTAssertEqual(presentation.map(\.groupedWithNext), [false, false, false])
        XCTAssertEqual(presentation.map(\.showsAvatar), [true, false, true])
    }

    func testGroupPreviewIncludesMemberJoinNotice() throws {
        let fixture = PreviewData.make(now: Date(timeIntervalSince1970: 1_000))
        let messages = try XCTUnwrap(fixture.messagesByConversation["group:mobile"])
        let notice = try XCTUnwrap(messages.first(where: \.isGroupMemberJoinNotice))
        let broadcast = try XCTUnwrap(messages.first(where: { $0.id == "gm3" }))

        XCTAssertEqual(notice.text, "Ethan Park joined the group, invited by Alex.")
        XCTAssertTrue(notice.isSystemNotice)
        XCTAssertEqual(broadcast.text, "@all I also added the device matrix.")
        XCTAssertEqual(broadcast.mentions.first?.targetIdentityId, "group:session:group:mobile")
    }

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
                mentions: [MessageMention(
                    label: "Research Agent",
                    targetKind: "agent",
                    targetIdentityId: "agent:cloud_agent_research",
                    startUtf16: 0,
                    lengthUtf16: ("@Research Agent" as NSString).length,
                    displayText: "@Research Agent"
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
        XCTAssertEqual(decoded.message?.mentions?.first?.targetIdentityId, "agent:cloud_agent_research")
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

    private func groupWire(id: String, body: String, to: String) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: "acct_me",
            toAccountId: to,
            body: body,
            createdAt: "2026-08-14T10:00:00Z",
            deliveredAt: "2026-08-14T10:00:01Z",
            readAt: nil,
            direction: "outgoing",
            sessionId: "session:group:mobile"
        )
    }

    private func timelineMessage(
        id: String,
        text: String,
        date: Date,
        messageKind: String? = nil
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: "group:mobile",
            author: .person,
            authorName: "Maya Chen",
            text: text,
            createdAt: date,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: messageKind
        )
    }
}
