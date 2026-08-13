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
        let account = CloudAccount(
            accountId: "acct_me",
            kordiId: "482731906",
            displayName: "Alex",
            primaryEmail: "preview@kordi.ai",
            avatarUrl: previewAvatarSource,
            nodeId: nil,
            passwordSet: true
        )
        let contacts = [
            CloudContact(accountId: KordiSupportIdentity.accountId, kordiId: "100000001", displayName: KordiSupportIdentity.displayName, avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -300)),
            CloudContact(accountId: "acct_maya", kordiId: "284106395", displayName: "Maya Chen", avatarUrl: previewAvatarSource, nodeId: nil, createdAt: timestamp(now, -500)),
            CloudContact(accountId: "acct_ethan", kordiId: "318457209", displayName: "Ethan Park", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -900)),
            CloudContact(accountId: "acct_priya", kordiId: "650917284", displayName: "Priya Shah", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -1_400)),
            CloudContact(accountId: "acct_marcus", kordiId: "761235480", displayName: "Marcus Johnson", avatarUrl: nil, nodeId: nil, createdAt: timestamp(now, -2_000))
        ]

        let conversations = [
            ConversationSummary(id: "agent:my-kordi", kind: .agent, peerAccountId: "acct_me", agentId: nil, ownerDisplayName: "Alex", displayName: "Plan the mobile release", lastMessage: "Start with the mobile API contract.", lastActivityAt: now.addingTimeInterval(-80), unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "session:self-agent:default", agentDisplayName: "My Kordi"),
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
            "agent:my-kordi": [
                ChatMessage(id: "m1", conversationId: "agent:my-kordi", author: .me, authorName: "You", text: "What should I focus on today?", createdAt: now.addingTimeInterval(-600), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
                ChatMessage(
                    id: "m2",
                    conversationId: "agent:my-kordi",
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
                    createdAt: now.addingTimeInterval(-560),
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
            ],
            "person:acct_kordi_support": [
                ChatMessage(id: "support1", conversationId: "person:acct_kordi_support", author: .person, authorName: KordiSupportIdentity.displayName, text: "Welcome to Kordi.", createdAt: now.addingTimeInterval(-25), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
            ],
            "person:acct_maya": [
                ChatMessage(id: "m3", conversationId: "person:acct_maya", author: .person, authorName: "Maya Chen", text: "The rollout notes are ready.", createdAt: now.addingTimeInterval(-3_600), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
                ChatMessage(id: "m4", conversationId: "person:acct_maya", author: .me, authorName: "You", text: "Great — I’ll review them after lunch.", createdAt: now.addingTimeInterval(-3_400), deliveryState: .read, errorMessage: nil, requestMessageId: nil),
                ChatMessage(id: "m5", conversationId: "person:acct_maya", author: .person, authorName: "Maya Chen", text: "Can you send the latest numbers?", createdAt: now.addingTimeInterval(-60), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil),
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
                    attachments: [
                        ChatAttachment(
                            attachmentId: "att_preview_image",
                            name: "Screenshot-Preview.png",
                            kind: .image,
                            mimeType: "image/png",
                            sizeBytes: 28_400,
                            previewURL: previewImageDataURL()
                        )
                    ]
                )
            ],
            "group:mobile": [
                ChatMessage(id: "gm0", conversationId: "group:mobile", author: .person, authorName: "Maya Chen", text: "Hi", createdAt: now.addingTimeInterval(-1_200), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil),
                ChatMessage(id: "gm1", conversationId: "group:mobile", author: .person, authorName: "Maya Chen", text: "The latest iPhone build is ready. Please review the TestFlight notes before we invite the next group of testers.", createdAt: now.addingTimeInterval(-1_170), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil),
                ChatMessage(id: "gm2", conversationId: "group:mobile", author: .me, authorName: "You", text: "Got it", createdAt: now.addingTimeInterval(-700), deliveryState: .read, errorMessage: nil, requestMessageId: nil, readByCount: 2, readByAccountIds: ["acct_maya", "acct_ethan"]),
                ChatMessage(id: "gm2b", conversationId: "group:mobile", author: .me, authorName: "You", text: "I’ll send the review notes here.", createdAt: now.addingTimeInterval(-670), deliveryState: .read, errorMessage: nil, requestMessageId: nil, readByCount: 2, readByAccountIds: ["acct_maya", "acct_ethan"]),
                ChatMessage(id: "gm3", conversationId: "group:mobile", author: .person, authorName: "Ethan Park", text: "I also added the device matrix.", createdAt: now.addingTimeInterval(-120), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
            ],
            "group:mobile-release": [
                ChatMessage(id: "gm2", conversationId: "group:mobile-release", author: .person, authorName: "Ethan Park", text: "I added the device testing notes.", createdAt: now.addingTimeInterval(-240), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
            ]
        ]
        return PreviewFixture(account: account, contacts: contacts, conversations: conversations, messagesByConversation: messages)
    }

    private static func timestamp(_ date: Date, _ offset: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: date.addingTimeInterval(offset))
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
}
