import XCTest
@testable import Kordi

final class CloudConversationCatalogTests: XCTestCase {
    func testCanonicalV2AgentSessionAppearsBeforeHistoryBackfill() throws {
        let payload = Data(#"{"id":"conversation-agent","kind":"ai","shared_title":"Check all my chats","version":3,"created_by_account_id":"acct_me","legacy_session_id":"session:self-agent:canonical","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":12,"created_at":"2026-08-08T10:00:00Z","updated_at":"2026-08-08T10:01:00Z","members":[{"account_id":"acct_me","display_name":"Shuyang","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":12,"last_read_sequence":12,"joined_at":"2026-08-08T10:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-agent","account_id":"acct_me","personal_title":null,"version":1}}"#.utf8)
        let canonical = try JSONDecoder().decode(CloudChatV2Conversation.self, from: payload)

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [:],
            canonicalConversations: [canonical]
        )

        let session = try XCTUnwrap(catalog.first { $0.sessionId == "session:self-agent:canonical" })
        XCTAssertEqual(session.kind, .agent)
        XCTAssertEqual(session.displayName, "Check all my chats")
        XCTAssertEqual(session.messageCount, 12)
    }

    func testOpaqueCanonicalV2AgentSessionAppearsBeforeHistoryBackfill() throws {
        let payload = Data(#"{"id":"conversation-agent-opaque","kind":"ai","shared_title":"Model and identity","version":3,"created_by_account_id":"acct_me","legacy_session_id":"e98c478d-6da2-46db-bf16-5caaac677f62","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":8,"created_at":"2026-08-11T17:22:11Z","updated_at":"2026-08-11T17:23:04Z","members":[{"account_id":"acct_me","display_name":"Shuyang","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":8,"last_read_sequence":8,"joined_at":"2026-08-11T17:22:11Z","left_at":null}],"preferences":{"conversation_id":"conversation-agent-opaque","account_id":"acct_me","personal_title":"Model and identity","version":1}}"#.utf8)
        let canonical = try JSONDecoder().decode(CloudChatV2Conversation.self, from: payload)

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [:],
            canonicalConversations: [canonical]
        )

        let session = try XCTUnwrap(catalog.first {
            $0.sessionId == "e98c478d-6da2-46db-bf16-5caaac677f62"
        })
        XCTAssertEqual(session.kind, .agent)
        XCTAssertEqual(session.displayName, "Model and identity")
        XCTAssertEqual(session.messageCount, 8)
    }

    func testRebuildsEveryAgentSessionInsteadOfCollapsingByAgent() throws {
        let requestOne = try CloudMessageCodec.encodeDirect(
            text: "Plan the TestFlight release",
            agentId: "agent_research",
            agentName: "Research Agent",
            ownerAccountId: "acct_me",
            ownerName: "Shuyang"
        )
        let requestTwo = try CloudMessageCodec.encodeDirect(
            text: "Review the mobile design",
            agentId: "agent_research",
            agentName: "Research Agent",
            ownerAccountId: "acct_me",
            ownerName: "Shuyang"
        )
        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [ownedAgent],
            sharedAgents: [],
            messagesByPeer: [
                "acct_me": [
                    wire(id: "m1", body: requestOne, sessionId: "session:self-agent:release", createdAt: "2026-08-08T10:00:00Z"),
                    wire(id: "m2", body: requestTwo, sessionId: "session:self-agent:design", createdAt: "2026-08-08T11:00:00Z")
                ]
            ]
        )

        let sessions = catalog.filter { $0.kind == .agent && $0.agentId == "agent_research" }
        XCTAssertEqual(Set(sessions.map(\.sessionId)), ["session:self-agent:release", "session:self-agent:design"])
        XCTAssertEqual(Set(sessions.map(\.displayName)), ["Plan the TestFlight release", "Review the mobile design"])
        XCTAssertTrue(sessions.allSatisfy { $0.agentDisplayName == "Research Agent" })
    }

    func testAppliesCloudForkLineageToAgentSessions() throws {
        let rootBody = try CloudMessageCodec.encodeDirect(
            text: "Original approach",
            agentId: "agent_research",
            agentName: "Research Agent",
            ownerAccountId: "acct_me",
            ownerName: "Shuyang"
        )
        let forkBody = try CloudMessageCodec.encodeDirect(
            text: "Try another approach",
            agentId: "agent_research",
            agentName: "Research Agent",
            ownerAccountId: "acct_me",
            ownerName: "Shuyang"
        )
        let fork = CloudSessionForkSummary(
            forkSessionId: "session:fork:alternative",
            parentSessionId: "session:self-agent:root",
            parentMessageId: "m-root",
            createdByAccountId: "acct_me",
            createdAt: "2026-08-08T11:00:00Z"
        )

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [],
            ownedAgents: [ownedAgent],
            sharedAgents: [],
            messagesByPeer: [
                "acct_me": [
                    wire(id: "m-root", body: rootBody, sessionId: fork.parentSessionId, createdAt: "2026-08-08T10:00:00Z"),
                    wire(id: "m-fork", body: forkBody, sessionId: fork.forkSessionId, createdAt: "2026-08-08T11:00:00Z")
                ]
            ],
            sessionForksById: [fork.forkSessionId: fork]
        )

        XCTAssertEqual(
            catalog.first { $0.sessionId == fork.forkSessionId }?.forkedFromSessionId,
            fork.parentSessionId
        )
    }

    func testKordiSupportProducesOnlyOnePersonConversationAndNoAgentSession() throws {
        let supportContact = CloudContact(
            accountId: KordiSupportIdentity.accountId,
            kordiId: "100000001",
            displayName: KordiSupportIdentity.displayName,
            avatarUrl: nil,
            nodeId: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )
        let supportAgent = CloudAgent(
            agentId: KordiSupportIdentity.agentId,
            ownerAccountId: KordiSupportIdentity.accountId,
            accessScope: "shared",
            status: "active",
            name: KordiSupportIdentity.displayName,
            role: "Support",
            description: "Kordi Support",
            updatedAt: "2026-08-08T00:00:00Z",
            ownerDisplayName: KordiSupportIdentity.displayName
        )
        let supportBody = try CloudMessageCodec.encodeDirect(
            text: "Help me",
            agentId: KordiSupportIdentity.agentId,
            agentName: KordiSupportIdentity.displayName,
            ownerAccountId: KordiSupportIdentity.accountId,
            ownerName: KordiSupportIdentity.displayName
        )

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [supportContact, supportContact],
            ownedAgents: [],
            sharedAgents: [supportAgent],
            messagesByPeer: [
                KordiSupportIdentity.accountId: [
                    wire(
                        id: "support-agent-message",
                        body: supportBody,
                        sessionId: "session:direct-agent:support",
                        createdAt: "2026-08-08T10:00:00Z",
                        from: "acct_me",
                        to: KordiSupportIdentity.accountId
                    )
                ]
            ]
        )

        XCTAssertEqual(catalog.filter { $0.kind == .person && $0.representsKordiSupport }.count, 1)
        XCTAssertFalse(catalog.contains { $0.kind == .agent && $0.representsKordiSupport })
    }

    func testMigratedSupportSystemSessionIsPresentedAsTheSupportContactNotAGroup() throws {
        let supportAccountId = "acct_real_support_owner"
        let supportSessionId = "session:direct-system-agent:acct_me:cloud_agent_kordi_support"
        let supportContact = CloudContact(
            accountId: supportAccountId,
            kordiId: "100000001",
            displayName: KordiSupportIdentity.displayName,
            avatarUrl: nil,
            nodeId: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )
        let supportBody = try CloudMessageCodec.encodeDirect(
            text: "Help me",
            agentId: KordiSupportIdentity.agentId,
            agentName: KordiSupportIdentity.displayName,
            ownerAccountId: supportAccountId,
            ownerName: KordiSupportIdentity.displayName
        )
        let canonicalPayload = Data(#"{"id":"conversation-support","kind":"group","shared_title":null,"version":27,"created_by_account_id":"acct_me","legacy_session_id":"session:direct-system-agent:acct_me:cloud_agent_kordi_support","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":27,"created_at":"2026-08-08T10:00:00Z","updated_at":"2026-08-08T10:01:00Z","members":[{"account_id":"acct_me","display_name":"Shuyang","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":27,"last_read_sequence":27,"joined_at":"2026-08-08T10:00:00Z","left_at":null},{"account_id":"acct_real_support_owner","display_name":"Kordi Support","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":27,"last_read_sequence":27,"joined_at":"2026-08-08T10:00:00Z","left_at":null},{"account_id":"acct_shu","display_name":"Shu Yang","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":27,"last_read_sequence":27,"joined_at":"2026-08-08T10:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-support","account_id":"acct_me","personal_title":null,"version":1}}"#.utf8)
        let canonical = try JSONDecoder().decode(CloudChatV2Conversation.self, from: canonicalPayload)

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [supportContact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                supportAccountId: [
                    wire(
                        id: "support-message",
                        body: supportBody,
                        sessionId: supportSessionId,
                        createdAt: "2026-08-08T10:00:00Z",
                        from: "acct_me",
                        to: supportAccountId
                    )
                ]
            ],
            canonicalConversations: [canonical]
        )

        let support = try XCTUnwrap(catalog.first { $0.representsKordiSupport })
        XCTAssertEqual(support.kind, .person)
        XCTAssertEqual(support.sessionId, supportSessionId)
        XCTAssertEqual(support.lastMessage, "Help me")
        XCTAssertFalse(catalog.contains { $0.kind == .group })
    }

    func testRebuildsArbitrarySelfAgentSessionAndIgnoresCancelControlForPreview() {
        let requestId = "msg:ui:05f68dc1-8d3f-4955-9131-b6429369bcce"
        let cancel = "kordi-cloud-agent-cancel:eyJraW5kIjoiYWdlbnQtY2FuY2VsIiwicmVxdWVzdElkIjoibXNnOnVpOjA1ZjY4ZGMxLThkM2YtNDk1NS05MTMxLWI2NDI5MzY5YmNjZSJ9"
        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_me": [
                    wire(id: requestId, body: "check all my chat", sessionId: "session:desktop:custom", createdAt: "2026-08-08T10:00:00Z"),
                    wire(id: "cancel", body: cancel, sessionId: "session:desktop:custom", createdAt: "2026-08-08T10:00:01Z")
                ]
            ]
        )

        let session = catalog.first { $0.sessionId == "session:desktop:custom" }
        XCTAssertEqual(session?.kind, .agent)
        XCTAssertEqual(session?.displayName, "check all my chat")
        XCTAssertEqual(session?.lastMessage, "check all my chat")
    }

    func testHiddenAndDeletedMacSessionsStayOutOfThePhoneCatalog() {
        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_me": [
                    wire(id: "hidden", body: "Hidden session", sessionId: "session:hidden", createdAt: "2026-08-08T10:00:00Z"),
                    wire(id: "deleted", body: "Deleted session", sessionId: "session:deleted", createdAt: "2026-08-08T11:00:00Z"),
                    wire(id: "visible", body: "Visible session", sessionId: "session:visible", createdAt: "2026-08-08T12:00:00Z")
                ]
            ],
            hiddenSessionIds: ["session:hidden"],
            deletedSessionIds: ["session:deleted"]
        )

        XCTAssertNil(catalog.first { $0.sessionId == "session:hidden" })
        XCTAssertNil(catalog.first { $0.sessionId == "session:deleted" })
        XCTAssertNotNil(catalog.first { $0.sessionId == "session:visible" })
    }

    func testRebuildsOneGroupSessionFromFanoutCopies() throws {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let invite = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-invite",
            groupId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: nil
        ))
        let message = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:mobile",
            groupSpaceId: "session:group:mobile",
            groupTitle: nil,
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: CloudGroupMessagePayload(
                id: "group_message_1",
                senderAccountId: "acct_maya",
                text: "The iPhone build is ready",
                createdAtMs: 1_786_180_800_000,
                senderKind: "human",
                senderDisplayName: "Maya",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        ))
        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(id: "invite", body: invite, sessionId: "session:group:mobile", createdAt: "2026-08-08T09:00:00Z"),
                    wire(id: "fanout-a", body: message, sessionId: "session:group:mobile", createdAt: "2026-08-08T12:00:00Z", from: "acct_maya", to: "acct_me"),
                    wire(id: "fanout-b", body: message, sessionId: "session:group:mobile", createdAt: "2026-08-08T12:00:00Z", from: "acct_maya", to: "acct_me")
                ]
            ]
        )

        let groups = catalog.filter { $0.kind == .group }
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].sessionId, "session:group:mobile")
        XCTAssertEqual(groups[0].displayName, "Mobile builders")
        XCTAssertEqual(groups[0].lastMessage, "The iPhone build is ready")
        XCTAssertEqual(groups[0].unreadCount, 1)
        XCTAssertEqual(groups[0].groupParticipants.count, 2)
        XCTAssertEqual(groups[0].messageCount, 1)
    }

    func testControlOnlyCanonicalGroupSessionIsNotPresentedAsChatHistory() throws {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "owner")
        ]
        let rootId = "session:group:root"
        let artifactId = "session:group:control-only"
        let rootMessage = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: rootId,
            groupSpaceId: rootId,
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: CloudGroupMessagePayload(
                id: "root-message",
                senderAccountId: "acct_maya",
                text: "Real group message",
                createdAtMs: 1_786_180_800_000,
                senderKind: "human",
                senderDisplayName: "Maya",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        ))
        let groupUpdate = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-update",
            groupId: artifactId,
            groupSpaceId: rootId,
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: nil
        ))
        let titleUpdate = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "session-title-update",
            groupId: artifactId,
            groupSpaceId: rootId,
            groupTitle: "New chat",
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: nil
        ))
        let canonicalPayload = Data(#"{"id":"conversation-control-only","kind":"group","shared_title":"New chat","version":18,"created_by_account_id":"acct_maya","legacy_session_id":"session:group:control-only","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":18,"created_at":"2026-07-21T08:04:25Z","updated_at":"2026-07-22T09:25:10Z","members":[{"account_id":"acct_me","display_name":"Shuyang","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":18,"last_read_sequence":18,"joined_at":"2026-07-21T08:04:25Z","left_at":null},{"account_id":"acct_maya","display_name":"Maya","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":18,"last_read_sequence":18,"joined_at":"2026-07-21T08:04:25Z","left_at":null}],"preferences":{"conversation_id":"conversation-control-only","account_id":"acct_me","personal_title":null,"version":1}}"#.utf8)
        let canonical = try JSONDecoder().decode(CloudChatV2Conversation.self, from: canonicalPayload)

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(id: "root", body: rootMessage, sessionId: rootId, createdAt: "2026-08-08T12:00:00Z", from: "acct_maya", to: "acct_me"),
                    wire(id: "update", body: groupUpdate, sessionId: artifactId, createdAt: "2026-07-21T08:04:25Z", from: "acct_maya", to: "acct_me"),
                    wire(id: "title", body: titleUpdate, sessionId: artifactId, createdAt: "2026-07-22T09:25:10Z", from: "acct_maya", to: "acct_me")
                ]
            ],
            canonicalConversations: [canonical]
        )

        XCTAssertEqual(catalog.first { $0.sessionId == artifactId }?.messageCount, 0)
        let spaces = GroupSpaceCatalog.build(conversations: catalog, ownAccountId: "acct_me")
        XCTAssertEqual(spaces.count, 1)
        XCTAssertEqual(spaces[0].sessions.map(\.sessionId), [rootId])
    }

    func testGroupUnreadIgnoresNonIncomingFanoutCopies() throws {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let message = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:fanout",
            groupSpaceId: "session:group:fanout",
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: CloudGroupMessagePayload(
                id: "group_message_outgoing_copy",
                senderAccountId: "acct_maya",
                text: "Already handled",
                createdAtMs: 1_786_180_800_000,
                senderKind: "human",
                senderDisplayName: "Maya",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        ))
        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(
                        id: "outgoing-copy",
                        body: message,
                        sessionId: "session:group:fanout",
                        createdAt: "2026-08-08T12:00:00Z",
                        from: "acct_me",
                        to: "acct_maya"
                    )
                ]
            ]
        )

        XCTAssertEqual(catalog.first { $0.kind == .group }?.unreadCount, 0)
    }

    func testGroupSessionWithoutAnExplicitTitleUsesItsFirstMessageLikeMac() throws {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let message = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:followup",
            groupSpaceId: "session:group:root",
            groupTitle: nil,
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: CloudGroupMessagePayload(
                id: "first-message",
                senderAccountId: "acct_maya",
                text: "hiiiii",
                createdAtMs: 1_786_180_800_000,
                senderKind: "human",
                senderDisplayName: "Maya",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        ))

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(
                        id: "followup-message",
                        body: message,
                        sessionId: "session:group:followup",
                        createdAt: "2026-08-08T12:00:00Z",
                        from: "acct_maya",
                        to: "acct_me"
                    )
                ]
            ]
        )

        XCTAssertEqual(catalog.first { $0.kind == .group }?.displayName, "hiiiii")
    }

    func testGroupParticipantAvatarsAreEnrichedFromCurrentProfiles() throws {
        let staleParticipants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Old me", avatarUrl: "https://old.example/me.png", role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Old Maya", avatarUrl: "https://old.example/maya.png", role: "admin")
        ]
        let invite = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-invite",
            groupId: "session:group:avatars",
            groupSpaceId: "session:group:avatars",
            groupTitle: nil,
            createdByAccountId: "acct_maya",
            actor: staleParticipants[1],
            participants: staleParticipants,
            message: nil
        ))
        let currentAccount = CloudAccount(
            accountId: "acct_me",
            kordiId: "123456789",
            displayName: "Shuyang",
            primaryEmail: "shu@example.com",
            avatarUrl: "data:image/png;base64,bWU=",
            nodeId: nil,
            passwordSet: true
        )
        let currentContact = CloudContact(
            accountId: "acct_maya",
            kordiId: "987654321",
            displayName: "Maya Chen",
            avatarUrl: "https://cdn.example/maya-current.png",
            nodeId: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )

        let catalog = CloudConversationCatalog.build(
            account: currentAccount,
            contacts: [currentContact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(id: "invite", body: invite, sessionId: "session:group:avatars", createdAt: "2026-08-08T09:00:00Z")
                ]
            ]
        )

        let participants = try XCTUnwrap(catalog.first { $0.kind == .group }?.groupParticipants)
        XCTAssertEqual(participants.first { $0.accountId == "acct_me" }?.displayName, "Shuyang")
        XCTAssertEqual(participants.first { $0.accountId == "acct_me" }?.avatarUrl, "data:image/png;base64,bWU=")
        XCTAssertEqual(participants.first { $0.accountId == "acct_maya" }?.displayName, "Maya Chen")
        XCTAssertEqual(participants.first { $0.accountId == "acct_maya" }?.avatarUrl, "https://cdn.example/maya-current.png")
    }

    func testGroupParticipantAvatarsAreEnrichedFromCanonicalV2MembersWithoutContacts() throws {
        let staleParticipants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "owner"),
            CloudGroupParticipant(accountId: "acct_jiaxin", displayName: "Jiaxin", avatarUrl: nil, role: "member")
        ]
        let invite = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-invite",
            groupId: "session:group:canonical-avatar",
            groupSpaceId: "session:group:canonical-avatar",
            groupTitle: "Main",
            createdByAccountId: "acct_me",
            actor: staleParticipants[0],
            participants: staleParticipants,
            message: nil
        ))
        let currentAccount = CloudAccount(
            accountId: "acct_me",
            kordiId: "123456789",
            displayName: "Me",
            primaryEmail: "me@example.com",
            avatarUrl: nil,
            nodeId: nil,
            passwordSet: true
        )
        let canonicalJiaxinAvatar = "data:image/jpeg;base64,/9j/2Q=="

        let catalog = CloudConversationCatalog.build(
            account: currentAccount,
            contacts: [],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_jiaxin": [
                    wire(
                        id: "invite",
                        body: invite,
                        sessionId: "session:group:canonical-avatar",
                        createdAt: "2026-08-08T09:00:00Z"
                    )
                ]
            ],
            canonicalParticipantsBySessionId: [
                "session:group:canonical-avatar": [
                    CloudGroupParticipant(
                        accountId: "acct_me",
                        displayName: "Me",
                        avatarUrl: nil,
                        role: "owner"
                    ),
                    CloudGroupParticipant(
                        accountId: "acct_jiaxin",
                        displayName: "Jiaxin Pei",
                        avatarUrl: canonicalJiaxinAvatar,
                        role: "member"
                    )
                ]
            ]
        )

        let participants = try XCTUnwrap(catalog.first { $0.kind == .group }?.groupParticipants)
        XCTAssertEqual(participants.first { $0.accountId == "acct_jiaxin" }?.displayName, "Jiaxin Pei")
        XCTAssertEqual(participants.first { $0.accountId == "acct_jiaxin" }?.avatarUrl, canonicalJiaxinAvatar)
    }

    func testLaterSparseGroupSnapshotDoesNotEraseEarlierParticipantProfiles() throws {
        let richParticipants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: "https://cdn.example/me.png", role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: "https://cdn.example/maya.png", role: "admin")
        ]
        let sparseParticipants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "", avatarUrl: nil, role: "person")
        ]
        let invite = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-invite",
            groupId: "session:group:sparse-profile",
            groupSpaceId: "session:group:sparse-profile",
            groupTitle: "Profile-safe group",
            createdByAccountId: "acct_maya",
            actor: richParticipants[1],
            participants: richParticipants,
            message: nil
        ))
        let sparseMessage = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: "session:group:sparse-profile",
            groupSpaceId: "session:group:sparse-profile",
            groupTitle: nil,
            createdByAccountId: "acct_me",
            actor: sparseParticipants[0],
            participants: sparseParticipants,
            message: CloudGroupMessagePayload(
                id: "group-message-sparse",
                senderAccountId: "acct_me",
                text: "hello",
                createdAtMs: 1_786_180_800_000,
                senderKind: "human",
                senderDisplayName: "Shuyang",
                deliveryState: "complete",
                replyToMessageId: nil,
                requestId: nil
            )
        ))

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(id: "rich", body: invite, sessionId: "session:group:sparse-profile", createdAt: "2026-08-08T09:00:00Z"),
                    wire(id: "sparse", body: sparseMessage, sessionId: "session:group:sparse-profile", createdAt: "2026-08-08T10:00:00Z")
                ]
            ]
        )

        let participants = try XCTUnwrap(catalog.first { $0.kind == .group }?.groupParticipants)
        XCTAssertEqual(participants.first { $0.accountId == "acct_me" }?.avatarUrl, "https://cdn.example/me.png")
        XCTAssertEqual(participants.first { $0.accountId == "acct_maya" }?.displayName, "Maya")
        XCTAssertEqual(participants.first { $0.accountId == "acct_maya" }?.avatarUrl, "https://cdn.example/maya.png")
        XCTAssertEqual(participants.first { $0.accountId == "acct_maya" }?.role, "person")
    }

    func testRejectsMalformedGroupControls() {
        XCTAssertNil(CloudGroupMessageCodec.parse("hello"))
        XCTAssertNil(CloudGroupMessageCodec.parse("kordi-cloud-group:not-base64"))
    }

    func testGroupSpaceCatalogExpandsOneGroupIntoMultipleSessions() {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let root = groupConversation(
            id: "session:group:root",
            spaceId: "session:group:root",
            title: "Mobile builders",
            preview: "Root message",
            date: Date(timeIntervalSince1970: 1),
            participants: participants
        )
        let followup = groupConversation(
            id: "session:group:followup",
            spaceId: "session:group:root",
            title: "Release checklist",
            preview: "Follow-up message",
            date: Date(timeIntervalSince1970: 2),
            participants: participants
        )

        let spaces = GroupSpaceCatalog.build(conversations: [root, followup], ownAccountId: "acct_me")

        XCTAssertEqual(spaces.count, 1)
        XCTAssertEqual(spaces[0].displayName, "Mobile builders")
        XCTAssertEqual(spaces[0].sessions.map(\.sessionId), ["session:group:followup", "session:group:root"])
        XCTAssertEqual(spaces[0].lastMessage, "Follow-up message")
    }

    func testGroupSpaceCatalogKeepsMembershipChangesInOneCanonicalSpace() {
        let original = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let expanded = original + [
            CloudGroupParticipant(accountId: "acct_ethan", displayName: "Ethan", avatarUrl: nil, role: "person")
        ]
        let root = groupConversation(
            id: "session:group:root",
            spaceId: "session:group:root",
            title: "Mobile builders",
            preview: "Before Ethan joined",
            date: Date(timeIntervalSince1970: 1),
            participants: original
        )
        let followup = groupConversation(
            id: "session:group:followup",
            spaceId: "session:group:root",
            title: "Release checklist",
            preview: "After Ethan joined",
            date: Date(timeIntervalSince1970: 2),
            participants: expanded
        )

        let spaces = GroupSpaceCatalog.build(conversations: [root, followup], ownAccountId: "acct_me")

        XCTAssertEqual(spaces.count, 1)
        XCTAssertEqual(Set(spaces[0].participants.map(\.accountId)), ["acct_me", "acct_maya", "acct_ethan"])
    }

    func testGroupSpaceCatalogDoesNotMergeDistinctGroupsWithTheSameMembers() {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let first = groupConversation(
            id: "session:group:first",
            spaceId: "session:group:first",
            title: "First group",
            preview: "One",
            date: Date(timeIntervalSince1970: 1),
            participants: participants
        )
        let second = groupConversation(
            id: "session:group:second",
            spaceId: "session:group:second",
            title: "Second group",
            preview: "Two",
            date: Date(timeIntervalSince1970: 2),
            participants: participants
        )

        let spaces = GroupSpaceCatalog.build(conversations: [first, second], ownAccountId: "acct_me")

        XCTAssertEqual(spaces.count, 2)
    }

    func testGroupSpaceCatalogHidesForksAndControlOnlyPlaceholders() {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let root = groupConversation(
            id: "session:group:root",
            spaceId: "session:group:root",
            title: "main",
            preview: "Root message",
            date: Date(timeIntervalSince1970: 4),
            participants: participants,
            messageCount: 341
        )
        let followup = groupConversation(
            id: "session:group:followup",
            spaceId: "session:group:root",
            title: "hiiiii",
            preview: "Follow-up message",
            date: Date(timeIntervalSince1970: 3),
            participants: participants,
            messageCount: 47
        )
        let placeholder = groupConversation(
            id: "session:group:placeholder",
            spaceId: "session:group:root",
            title: "New chat",
            preview: "Group conversation",
            date: Date(timeIntervalSince1970: 2),
            participants: participants,
            messageCount: 0
        )
        let fork = groupConversation(
            id: "session:fork:one",
            spaceId: "session:group:root",
            title: "Fork",
            preview: "Fork message",
            date: Date(timeIntervalSince1970: 5),
            participants: participants,
            messageCount: 22,
            forkedFromSessionId: "session:group:root"
        )

        let spaces = GroupSpaceCatalog.build(
            conversations: [root, followup, placeholder, fork],
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(spaces.count, 1)
        XCTAssertEqual(spaces[0].sessions.map(\.displayName), ["main", "hiiiii"])
        XCTAssertEqual(spaces[0].sessions.map(\.messageCount), [341, 47])
    }

    func testHistoricalForkLineageResolvesBackToTheRootGroupSpace() throws {
        let participants = [
            CloudGroupParticipant(accountId: "acct_me", displayName: "Shuyang", avatarUrl: nil, role: "self"),
            CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "admin")
        ]
        let rootId = "session:group:root"
        let firstForkId = "session:fork:first"
        let secondForkId = "session:fork:second"
        let root = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-invite",
            groupId: rootId,
            groupSpaceId: rootId,
            groupTitle: "Mobile builders",
            createdByAccountId: "acct_maya",
            actor: participants[1],
            participants: participants,
            message: nil
        ))
        let firstFork = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "session-fork",
            groupId: firstForkId,
            groupSpaceId: firstForkId,
            groupTitle: "Release checklist",
            createdByAccountId: "acct_me",
            actor: participants[0],
            participants: participants,
            fork: CloudGroupForkPayload(
                forkSessionId: firstForkId,
                parentSessionId: rootId,
                parentMessageId: "message:one",
                createdAtMs: 2
            ),
            message: nil
        ))
        let secondFork = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "session-fork",
            groupId: secondForkId,
            groupSpaceId: secondForkId,
            groupTitle: "QA follow-up",
            createdByAccountId: "acct_me",
            actor: participants[0],
            participants: participants,
            fork: CloudGroupForkPayload(
                forkSessionId: secondForkId,
                parentSessionId: firstForkId,
                parentMessageId: "message:two",
                createdAtMs: 3
            ),
            message: nil
        ))
        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [
                "acct_maya": [
                    wire(id: "root", body: root, sessionId: rootId, createdAt: "2026-08-08T09:00:00Z"),
                    wire(id: "fork-one", body: firstFork, sessionId: firstForkId, createdAt: "2026-08-08T10:00:00Z"),
                    wire(id: "fork-two", body: secondFork, sessionId: secondForkId, createdAt: "2026-08-08T11:00:00Z")
                ]
            ]
        )
        let groups = catalog.filter { $0.kind == .group }

        XCTAssertEqual(groups.count, 3)
        XCTAssertTrue(groups.allSatisfy { $0.groupSpaceId == rootId })
        XCTAssertNil(groups.first { $0.sessionId == rootId }?.forkedFromSessionId)
        XCTAssertEqual(groups.first { $0.sessionId == firstForkId }?.forkedFromSessionId, rootId)
        XCTAssertEqual(groups.first { $0.sessionId == secondForkId }?.forkedFromSessionId, firstForkId)
        XCTAssertEqual(GroupSpaceCatalog.build(conversations: groups, ownAccountId: "acct_me").count, 1)
    }

    private var account: CloudAccount {
        CloudAccount(
            accountId: "acct_me",
            kordiId: "123456789",
            displayName: "Shuyang",
            primaryEmail: "shu@example.com",
            avatarUrl: nil,
            nodeId: nil,
            passwordSet: true
        )
    }

    private var contact: CloudContact {
        CloudContact(
            accountId: "acct_maya",
            kordiId: "987654321",
            displayName: "Maya",
            avatarUrl: nil,
            nodeId: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )
    }

    private var ownedAgent: CloudAgent {
        CloudAgent(
            agentId: "agent_research",
            ownerAccountId: "acct_me",
            accessScope: "private",
            status: "active",
            name: "Research Agent",
            role: "Researcher",
            description: nil,
            updatedAt: "2026-08-08T00:00:00Z",
            ownerDisplayName: "Shuyang"
        )
    }

    private func groupConversation(
        id: String,
        spaceId: String,
        title: String,
        preview: String,
        date: Date,
        participants: [CloudGroupParticipant],
        messageCount: Int? = nil,
        forkedFromSessionId: String? = nil
    ) -> ConversationSummary {
        ConversationSummary(
            id: "group:\(id)",
            kind: .group,
            peerAccountId: "acct_maya",
            agentId: nil,
            ownerDisplayName: id == spaceId ? title : "Mobile builders",
            displayName: title,
            lastMessage: preview,
            lastActivityAt: date,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: id,
            groupSpaceId: spaceId,
            groupParticipants: participants,
            messageCount: messageCount,
            forkedFromSessionId: forkedFromSessionId
        )
    }

    private func wire(
        id: String,
        body: String,
        sessionId: String,
        createdAt: String,
        from: String = "acct_me",
        to: String = "acct_me"
    ) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: from,
            toAccountId: to,
            body: body,
            createdAt: createdAt,
            deliveredAt: createdAt,
            readAt: nil,
            direction: from == "acct_me" ? "outgoing" : "incoming",
            sessionId: sessionId
        )
    }
}
