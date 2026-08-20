import Foundation
import UIKit

struct PreviewFixture {
    let account: CloudAccount
    let contacts: [CloudContact]
    let conversations: [ConversationSummary]
    let messagesByConversation: [String: [ChatMessage]]
}

enum PreviewData {
    static func make(now: Date = Date()) -> PreviewFixture {
        let previewAvatarSource = ProcessInfo.processInfo.environment["KORDI_PREVIEW_AVATAR_SOURCE"]?.nonEmpty
        let avatarSeed = "preview_account"
        let account = CloudAccount(
            accountId: "acct_me",
            kordiId: "482731906",
            displayName: "Alex",
            primaryEmail: "preview@kordi.ai",
            avatarUrl: previewAvatarSource ?? CanonicalAvatarSystem.marker(
                style: CanonicalAvatarSystem.humanStyle,
                seed: avatarSeed,
                version: 1
            ),
            avatar: CanonicalAvatarDescriptor(
                entityType: "human",
                entityId: "acct_me",
                source: previewAvatarSource == nil ? "generated" : "uploaded",
                style: CanonicalAvatarSystem.humanStyle,
                seed: avatarSeed,
                rendererVersion: CanonicalAvatarSystem.rendererVersion,
                uploadedAsset: previewAvatarSource,
                version: 1,
                updatedAt: "2026-08-19T00:00:00Z"
            ),
            nodeId: nil,
            passwordSet: true
        )
        let contacts = [
            CloudContact(accountId: KordiSupportIdentity.accountId, kordiId: "100000001", displayName: KordiSupportIdentity.displayName, avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -300)),
            CloudContact(accountId: "acct_maya", kordiId: "284106395", displayName: "Maya Chen", avatarUrl: previewAvatarSource, nodeId: nil, createdAt: timestamp(now, -500)),
            CloudContact(accountId: "acct_ethan", kordiId: "318457209", displayName: "Ethan Park", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -900)),
            CloudContact(accountId: "acct_priya", kordiId: "650917284", displayName: "Priya Shah", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -1_400)),
            CloudContact(accountId: "acct_marcus", kordiId: "761235480", displayName: "Marcus Johnson", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -2_000)),
            CloudContact(accountId: "acct_aisha", kordiId: "407182639", displayName: "Aisha Rahman", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -2_400)),
            CloudContact(accountId: "acct_daniel", kordiId: "592714806", displayName: "Daniel Kim", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -2_800)),
            CloudContact(accountId: "acct_li", kordiId: "813506247", displayName: "Li Wei", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -3_200)),
            CloudContact(accountId: "acct_nora", kordiId: "935208164", displayName: "Nora Hassan", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -3_600)),
            CloudContact(accountId: "acct_sofia", kordiId: "246809531", displayName: "Sofia Rossi", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -4_000)),
            CloudContact(accountId: "acct_yuki", kordiId: "174630925", displayName: "Yuki Tanaka", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -4_400))
        ]

        let conversations = [
            ConversationSummary(id: "agent:my-kordi", kind: .agent, peerAccountId: "acct_me", agentId: CanonicalAvatarSystem.defaultAgentId, ownerDisplayName: "Alex", displayName: "Plan the mobile release", lastMessage: "Start with the mobile API contract.", lastActivityAt: now.addingTimeInterval(-80), unreadCount: 1, avatarSource: nil, agentActivity: .ready, sessionId: "session:self-agent:default", agentDisplayName: "My Kordi"),
            ConversationSummary(id: "agent:research", kind: .agent, peerAccountId: "acct_me", agentId: "cloud_agent_research", ownerDisplayName: "Alex", displayName: "Review the TestFlight checklist", lastMessage: "Comparing the latest sources…", lastActivityAt: now.addingTimeInterval(-160), unreadCount: 0, avatarSource: nil, agentActivity: .replying, sessionId: "session:self-agent:cloud_agent_research", agentDisplayName: "Research Agent", forkedFromSessionId: "session:self-agent:default"),
            ConversationSummary(id: "agent:support", kind: .agent, peerAccountId: "acct_maya", agentId: "cloud_agent_support", ownerDisplayName: "Maya Chen", displayName: "Support Agent", lastMessage: "I can help with that.", lastActivityAt: now.addingTimeInterval(-300), unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "session:direct-agent:acct_maya:cloud_agent_support"),
            ConversationSummary(id: "group:mobile", kind: .group, peerAccountId: "acct_maya", agentId: nil, ownerDisplayName: "Mobile builders", displayName: "main", lastMessage: "The latest iPhone build is ready.", lastActivityAt: now.addingTimeInterval(-120), unreadCount: 1, avatarSource: nil, agentActivity: nil, sessionId: "session:group:mobile", groupSpaceId: "session:group:mobile", groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Alex", avatarUrl: previewAvatarSource, role: "self"),
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya Chen", avatarUrl: previewAvatarSource, role: "admin"),
                CloudGroupParticipant(accountId: "acct_ethan", displayName: "Ethan Park", avatarUrl: nil, role: "person")
            ], messageCount: 341),
            ConversationSummary(id: "group:mobile-release", kind: .group, peerAccountId: "acct_maya", agentId: nil, ownerDisplayName: "Mobile builders", displayName: "hiiiii", lastMessage: "I added the device testing notes.", lastActivityAt: now.addingTimeInterval(-240), unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:group:mobile-release", groupSpaceId: "session:group:mobile", groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Alex", avatarUrl: previewAvatarSource, role: "self"),
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya Chen", avatarUrl: previewAvatarSource, role: "admin"),
                CloudGroupParticipant(accountId: "acct_ethan", displayName: "Ethan Park", avatarUrl: nil, role: "person")
            ], messageCount: 47),
            ConversationSummary(id: "person:acct_kordi_support", kind: .person, peerAccountId: KordiSupportIdentity.accountId, agentId: nil, ownerDisplayName: KordiSupportIdentity.displayName, displayName: KordiSupportIdentity.displayName, lastMessage: "Welcome to Kordi.", lastActivityAt: now.addingTimeInterval(-25), unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:direct-person:acct_kordi_support:acct_me"),
            ConversationSummary(id: "person:acct_maya", kind: .person, peerAccountId: "acct_maya", agentId: nil, ownerDisplayName: "Maya Chen", displayName: "Maya Chen", lastMessage: "Can you send the latest numbers?", lastActivityAt: now.addingTimeInterval(-60), unreadCount: 2, avatarSource: previewAvatarSource, agentActivity: nil, sessionId: "session:direct-person:acct_maya:acct_me"),
            ConversationSummary(id: "person:acct_ethan", kind: .person, peerAccountId: "acct_ethan", agentId: nil, ownerDisplayName: "Ethan Park", displayName: "Ethan Park", lastMessage: "Sounds good, let’s do it.", lastActivityAt: now.addingTimeInterval(-1_100), unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:direct-person:acct_ethan:acct_me"),
            ConversationSummary(id: "person:acct_priya", kind: .person, peerAccountId: "acct_priya", agentId: nil, ownerDisplayName: "Priya Shah", displayName: "Priya Shah", lastMessage: "Perfect, I’ll update the deck.", lastActivityAt: now.addingTimeInterval(-82_000), unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:direct-person:acct_me:acct_priya"),
            ConversationSummary(id: "person:acct_marcus", kind: .person, peerAccountId: "acct_marcus", agentId: nil, ownerDisplayName: "Marcus Johnson", displayName: "Marcus Johnson", lastMessage: "Thanks — that clears it up.", lastActivityAt: now.addingTimeInterval(-86_000), unreadCount: 1, avatarSource: nil, agentActivity: nil, sessionId: "session:direct-person:acct_marcus:acct_me")
        ]

        let messages: [String: [ChatMessage]] = [
            "agent:my-kordi": agentConversation(now: now),
            "agent:research": [
                ChatMessage(
                    id: "research1",
                    conversationId: "agent:research",
                    author: .agent,
                    authorName: "Research Agent",
                    text: "I am comparing the TestFlight checklist with the latest device results.",
                    createdAt: now.addingTimeInterval(-160),
                    deliveryState: .delivered,
                    errorMessage: nil,
                    requestMessageId: nil
                )
            ],
            "agent:support": [
                ChatMessage(
                    id: "agent-support1",
                    conversationId: "agent:support",
                    author: .agent,
                    authorName: "Support Agent",
                    text: "I can help with that.",
                    createdAt: now.addingTimeInterval(-300),
                    deliveryState: .delivered,
                    errorMessage: nil,
                    requestMessageId: nil
                )
            ],
            "person:acct_kordi_support": [
                ChatMessage(id: "support1", conversationId: "person:acct_kordi_support", author: .person, authorName: KordiSupportIdentity.displayName, text: "Welcome to Kordi.", createdAt: now.addingTimeInterval(-25), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
            ],
            "person:acct_maya": mayaConversation(now: now),
            "person:acct_ethan": [
                ChatMessage(
                    id: "ethan1",
                    conversationId: "person:acct_ethan",
                    author: .person,
                    authorName: "Ethan Park",
                    text: "Sounds good, let’s do it.",
                    createdAt: now.addingTimeInterval(-1_100),
                    deliveryState: .delivered,
                    errorMessage: nil,
                    requestMessageId: nil
                )
            ],
            "person:acct_priya": [
                ChatMessage(
                    id: "priya1",
                    conversationId: "person:acct_priya",
                    author: .person,
                    authorName: "Priya Shah",
                    text: "Perfect, I’ll update the deck.",
                    createdAt: now.addingTimeInterval(-82_000),
                    deliveryState: .delivered,
                    errorMessage: nil,
                    requestMessageId: nil
                )
            ],
            "person:acct_marcus": [
                ChatMessage(
                    id: "marcus1",
                    conversationId: "person:acct_marcus",
                    author: .person,
                    authorName: "Marcus Johnson",
                    text: "Thanks — that clears it up.",
                    createdAt: now.addingTimeInterval(-86_000),
                    deliveryState: .delivered,
                    errorMessage: nil,
                    requestMessageId: nil
                )
            ],
            "group:mobile": groupConversation(now: now),
            "group:mobile-release": [
                ChatMessage(id: "gm2", conversationId: "group:mobile-release", author: .person, authorName: "Ethan Park", text: "I added the device testing notes.", createdAt: now.addingTimeInterval(-240), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
            ]
        ]
        return PreviewFixture(account: account, contacts: contacts, conversations: conversations, messagesByConversation: messages)
    }

    private static func timestamp(_ date: Date, _ offset: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: date.addingTimeInterval(offset))
    }

    private static func agentConversation(now: Date) -> [ChatMessage] {
        let conversationId = "agent:my-kordi"
        let sampleTurns = [
            "Review the mobile API contract before the next build.",
            "I checked the authentication and message synchronization paths.",
            "Summarize the remaining iPhone release risks.",
            "The session entry behavior needs one more verification pass.",
            "Compare the cached transcript with the latest server response.",
            "I will keep the newest message visible after synchronization."
        ]
        var messages = (0..<72).map { index in
            let isAgent = !index.isMultiple(of: 2)
            return ChatMessage(
                id: "agent-history-\(index)",
                conversationId: conversationId,
                author: isAgent ? .agent : .me,
                authorName: isAgent ? "My Kordi" : "You",
                text: sampleTurns[index % sampleTurns.count],
                createdAt: now.addingTimeInterval(-80_000 + Double(index) * 600),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            )
        }
        messages.append(contentsOf: [
            ChatMessage(id: "m1", conversationId: conversationId, author: .me, authorName: "You", text: "What should I focus on today?", createdAt: now.addingTimeInterval(-600), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
            ChatMessage(
                id: "m2",
                conversationId: conversationId,
                author: .agent,
                authorName: "My Kordi",
                text: """
                ## Mobile release

                Start with the **mobile API contract**, then validate one complete chat flow.

                - [x] Sync avatars
                - [ ] Verify messages on iPhone

                ```swift
                let environment = "production"
                ```
                """,
                createdAt: now.addingTimeInterval(-80),
                deliveryState: .delivered,
                errorMessage: nil,
                requestMessageId: "m1",
                attachments: [
                    ChatAttachment(
                        attachmentId: "att_preview_release",
                        name: "TestFlight-release-checklist.pdf",
                        kind: .file,
                        mimeType: "application/pdf",
                        sizeBytes: 248_320,
                        previewURL: nil
                    )
                ],
                replyToMessageId: "m1",
                messageAction: .quote(MessageActionSource(
                    sourceSessionId: "session:self-agent:default",
                    sourceMessageId: "m1",
                    senderLabel: "You",
                    textPreview: "What should I focus on today?",
                    attachmentCount: 0
                ))
            )
        ])
        return messages
    }

    private static func groupConversation(now: Date) -> [ChatMessage] {
        let conversationId = "group:mobile"
        let sampleTurns = [
            "The device test results are ready for review.",
            "I will compare them with the previous iPhone build.",
            "Please add the latest release notes to this session.",
            "The group timeline now includes the full test history.",
            "I checked the sign-in and notification scenarios.",
            "Great. Keep the newest result visible when the session opens."
        ]
        var messages = (0..<72).map { index in
            let author: MessageAuthor
            let authorName: String
            switch index % 3 {
            case 0:
                author = .person
                authorName = "Maya Chen"
            case 1:
                author = .me
                authorName = "You"
            default:
                author = .person
                authorName = "Ethan Park"
            }
            return ChatMessage(
                id: "group-history-\(index)",
                conversationId: conversationId,
                author: author,
                authorName: authorName,
                text: sampleTurns[index % sampleTurns.count],
                createdAt: now.addingTimeInterval(-80_000 + Double(index) * 600),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            )
        }
        messages.append(contentsOf: [
            ChatMessage(id: "gm0", conversationId: conversationId, author: .person, authorName: "Maya Chen", text: "Hi", createdAt: now.addingTimeInterval(-1_200), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil),
            ChatMessage(id: "gm1", conversationId: conversationId, author: .person, authorName: "Maya Chen", text: "The latest iPhone build is ready. Please review the TestFlight notes before we invite the next group of testers.", createdAt: now.addingTimeInterval(-1_170), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil),
            ChatMessage(id: "gm2", conversationId: conversationId, author: .me, authorName: "You", text: "Got it", createdAt: now.addingTimeInterval(-700), deliveryState: .read, errorMessage: nil, requestMessageId: nil, readByCount: 2, readByAccountIds: ["acct_maya", "acct_ethan"]),
            ChatMessage(id: "gm2b", conversationId: conversationId, author: .me, authorName: "You", text: "I’ll send the review notes here.", createdAt: now.addingTimeInterval(-670), deliveryState: .read, errorMessage: nil, requestMessageId: nil, readByCount: 2, readByAccountIds: ["acct_maya", "acct_ethan"]),
            ChatMessage(id: "msg:group-member-join:preview:session:group:mobile", conversationId: conversationId, author: .me, authorName: "You", text: "Ethan Park joined the group, invited by Alex.", createdAt: now.addingTimeInterval(-150), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil, messageKind: ChatMessage.groupMemberJoinMessageKind),
            ChatMessage(id: "gm3", conversationId: conversationId, author: .person, authorName: "Ethan Park", text: "I also added the device matrix.", createdAt: now.addingTimeInterval(-120), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        ])
        return messages
    }

    private static func mayaConversation(now: Date) -> [ChatMessage] {
        if ProcessInfo.processInfo.arguments.contains("--preview-call-activity") {
            return callActivityConversation(now: now)
        }

        let conversationId = "person:acct_maya"
        let sampleTurns = [
            "I finished the navigation audit for the iPhone build.",
            "Thanks. I am checking the entry animation and message position now.",
            "The contact and group timelines both use the latest fixture.",
            "I will compare the first frame with the final resting position.",
            "The updated session list is ready for another pass.",
            "Great. I will verify that the tab bar stays hidden in the detail view.",
            "Please also check the pull-to-refresh indicator when you return.",
            "I will test that after the conversation scrolling checks.",
            "The newest participant names and avatars are included.",
            "Perfect. I will confirm that stale profile data never replaces them.",
            "I added enough history to test quick-return restoration.",
            "That should make the latest-message button easy to review."
        ]
        var messages = (0..<96).map { index in
            let isMaya = index.isMultiple(of: 2)
            return ChatMessage(
                id: "maya-history-\(index)",
                conversationId: conversationId,
                author: isMaya ? .person : .me,
                authorName: isMaya ? "Maya Chen" : "You",
                text: sampleTurns[index % sampleTurns.count],
                createdAt: now.addingTimeInterval(-72_000 + Double(index) * 600),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            )
        }
        messages.append(contentsOf: [
            ChatMessage(id: "m3", conversationId: conversationId, author: .person, authorName: "Maya Chen", text: "The rollout notes are ready.", createdAt: now.addingTimeInterval(-3_600), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
            ChatMessage(id: "m4", conversationId: conversationId, author: .me, authorName: "You", text: "Great — I’ll review them after lunch.", createdAt: now.addingTimeInterval(-3_400), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
            ChatMessage(id: "m5", conversationId: conversationId, author: .person, authorName: "Maya Chen", text: "Can you send the latest numbers?", createdAt: now.addingTimeInterval(-60), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil),
        ])
        messages.append(contentsOf: previewMediaMessages(now: now))
        return messages
    }

    private static func callActivityConversation(now: Date) -> [ChatMessage] {
        let conversationId = "person:acct_maya"
        return [
            ChatMessage(
                id: "preview-call-ended-peer",
                conversationId: conversationId,
                author: .person,
                authorName: "Maya Chen",
                text: "Voice call ended. Duration 00:18",
                createdAt: now.addingTimeInterval(-900),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil,
                messageKind: ChatCallActivity.messageKind(for: .ended, callId: "preview-peer")
            ),
            ChatMessage(
                id: "preview-call-reply",
                conversationId: conversationId,
                author: .me,
                authorName: "You",
                text: "Hello",
                createdAt: now.addingTimeInterval(-840),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            ),
            ChatMessage(
                id: "preview-call-follow-up",
                conversationId: conversationId,
                author: .person,
                authorName: "Maya Chen",
                text: "Test message",
                createdAt: now.addingTimeInterval(-810),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            ),
            ChatMessage(
                id: "preview-call-ended-own",
                conversationId: conversationId,
                author: .me,
                authorName: "You",
                text: "Voice call ended. Duration 00:04",
                createdAt: now.addingTimeInterval(-420),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil,
                messageKind: ChatCallActivity.messageKind(for: .ended, callId: "preview-own")
            ),
            ChatMessage(
                id: "preview-call-started-peer",
                conversationId: conversationId,
                author: .person,
                authorName: "Maya Chen",
                text: "Maya Chen started a voice call.",
                createdAt: now.addingTimeInterval(-60),
                deliveryState: .delivered,
                errorMessage: nil,
                requestMessageId: nil,
                messageKind: ChatCallActivity.messageKind(for: .started, callId: "preview-started")
            ),
        ]
    }

    static func pendingPhotoAttachments() -> [PendingAttachment] {
        let sources = [
            ("preview-photo-1", "Photo-1.png", previewImageDataURL()),
            ("preview-photo-2", "Photo-2.png", previewPortraitImageDataURL()),
            ("preview-photo-3", "Photo-3.png", previewBarsImageDataURL()),
        ]
        return sources.compactMap { id, name, source in
            guard let data = AttachmentPreviewDataURL.decode(source) else { return nil }
            return PendingAttachment(
                id: id,
                name: name,
                kind: .image,
                mimeType: "image/png",
                data: data,
                previewURL: source
            )
        }
    }

    private static func previewMediaMessages(now: Date) -> [ChatMessage] {
        let attachments = previewChatAttachments()
        if ProcessInfo.processInfo.arguments.contains("--preview-media-separated") {
            return attachments.enumerated().map { index, attachment in
                ChatMessage(
                    id: "m6-\(index + 1)",
                    conversationId: "person:acct_maya",
                    author: .me,
                    authorName: "You",
                    text: "",
                    createdAt: now.addingTimeInterval(TimeInterval(-32 + index)),
                    deliveryState: .read,
                    errorMessage: nil,
                    requestMessageId: nil,
                    attachments: [attachment]
                )
            }
        }
        return [
            ChatMessage(
                id: "m6",
                conversationId: "person:acct_maya",
                author: .me,
                authorName: "You",
                text: "",
                createdAt: now.addingTimeInterval(-30),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil,
                attachments: attachments
            )
        ]
    }

    private static func previewChatAttachments() -> [ChatAttachment] {
        [
            ChatAttachment(
                attachmentId: "att_preview_image",
                name: "Screenshot-Preview.png",
                kind: .image,
                mimeType: "image/png",
                sizeBytes: 28_400,
                previewURL: previewImageDataURL()
            ),
            ChatAttachment(
                attachmentId: "att_preview_image_portrait",
                name: "Mobile-Profile-Preview.png",
                kind: .image,
                mimeType: "image/png",
                sizeBytes: 19_600,
                previewURL: previewPortraitImageDataURL()
            ),
            ChatAttachment(
                attachmentId: "att_preview_image_bars",
                name: "Color-Bars-Preview.png",
                kind: .image,
                mimeType: "image/png",
                sizeBytes: 17_800,
                previewURL: previewBarsImageDataURL()
            ),
        ]
    }

    private static func previewImageDataURL() -> String? {
        let size = CGSize(width: 640, height: 420)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor(red: 0.94, green: 0.95, blue: 0.98, alpha: 1).setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))
            let circles: [(UIColor, CGRect)] = [
                (UIColor(red: 0.95, green: 0.24, blue: 0.55, alpha: 0.92), CGRect(x: 210, y: 72, width: 150, height: 150)),
                (UIColor(red: 0.05, green: 0.72, blue: 0.78, alpha: 0.92), CGRect(x: 145, y: 176, width: 150, height: 150)),
                (UIColor(red: 0.98, green: 0.68, blue: 0.08, alpha: 0.92), CGRect(x: 275, y: 176, width: 150, height: 150)),
            ]
            for (color, rect) in circles {
                color.setFill()
                context.cgContext.fillEllipse(in: rect)
            }
        }
        guard let data = image.pngData() else { return nil }
        return "data:image/png;base64,\(data.base64EncodedString())"
    }

    private static func previewPortraitImageDataURL() -> String? {
        let size = CGSize(width: 420, height: 640)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 1).setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))

            UIColor(red: 0.17, green: 0.42, blue: 0.91, alpha: 1).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 90, y: 88, width: 240, height: 240))

            UIColor(white: 0.98, alpha: 1).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 145, y: 143, width: 130, height: 130))

            UIColor(red: 0.95, green: 0.24, blue: 0.55, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 70, y: 410, width: 280, height: 28))
            UIColor(red: 0.05, green: 0.72, blue: 0.78, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 110, y: 464, width: 200, height: 28))
        }
        guard let data = image.pngData() else { return nil }
        return "data:image/png;base64,\(data.base64EncodedString())"
    }

    private static func previewBarsImageDataURL() -> String? {
        let size = CGSize(width: 640, height: 480)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 1).setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))

            UIColor(red: 0.95, green: 0.24, blue: 0.55, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 90, y: 108, width: 460, height: 54))
            UIColor(red: 0.05, green: 0.72, blue: 0.78, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 150, y: 214, width: 340, height: 54))
            UIColor(red: 0.98, green: 0.68, blue: 0.08, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 210, y: 320, width: 220, height: 54))
        }
        guard let data = image.pngData() else { return nil }
        return "data:image/png;base64,\(data.base64EncodedString())"
    }
}
