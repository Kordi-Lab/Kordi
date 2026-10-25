import Foundation

/// `--preview-personal-agent`: the Personal agent section with three owned
/// agents, unread outreach messages with source chips, and an empty session.
extension PreviewData {
    static func personalAgentFixture(
        now: Date
    ) -> (conversations: [ConversationSummary], messages: [String: [ChatMessage]]) {
        func session(
            _ key: String, agentId: String, name: String, lastMessage: String,
            minutesAgo: Double, unread: Int, messageCount: Int
        ) -> ConversationSummary {
            var conversation = ConversationSummary(
                id: "agent:personal-\(key)", kind: .agent, peerAccountId: "acct_me", agentId: agentId,
                ownerDisplayName: "Alex", displayName: name, lastMessage: lastMessage,
                lastActivityAt: now.addingTimeInterval(-minutesAgo * 60), unreadCount: unread,
                avatarSource: nil, agentActivity: .ready,
                sessionId: "session:self-agent:acct_me:personal:\(agentId)", agentDisplayName: name,
                messageCount: messageCount
            )
            conversation.personalAgentId = agentId
            return conversation
        }
        func agentMessage(
            _ id: String, conversation: String, name: String, text: String,
            minutesAgo: Double, sources: [MessageSource]
        ) -> ChatMessage {
            ChatMessage(
                id: id, conversationId: conversation, author: .agent, authorName: name, text: text,
                createdAt: now.addingTimeInterval(-minutesAgo * 60), deliveryState: .delivered,
                errorMessage: nil, requestMessageId: nil, sources: sources
            )
        }
        let kordi = session(
            "kordi", agentId: "cloud-agent:acct_me", name: "Alex's Kordi",
            lastMessage: "Lab sync moved to 10 am Thursday. Mei wants your review on #412 before it.",
            minutesAgo: 4, unread: 2, messageCount: 2
        )
        let research = session(
            "research", agentId: "cloud_agent_research", name: "Research Agent",
            lastMessage: "Two new papers cite your workshop draft.",
            minutesAgo: 190, unread: 1, messageCount: 1
        )
        let inbox = session(
            "inbox", agentId: "cloud_agent_inbox", name: "Inbox helper",
            lastMessage: PersonalAgentSessionCatalog.emptyPreview,
            minutesAgo: 2_900, unread: 0, messageCount: 0
        )
        let messages: [String: [ChatMessage]] = [
            kordi.id: [
                agentMessage(
                    "personal-kordi-1", conversation: kordi.id, name: "Alex's Kordi",
                    text: "Sam asked on Airbnb if they can check in at 1 pm tomorrow. You're free then.",
                    minutesAgo: 330,
                    sources: [MessageSource(eventId: "cnevt_preview_airbnb", provider: "gmail", title: "Airbnb · Sam")]
                ),
                agentMessage(
                    "personal-kordi-2", conversation: kordi.id, name: "Alex's Kordi",
                    text: "Lab sync moved to 10 am Thursday. Mei wants your review on #412 before it.",
                    minutesAgo: 4,
                    sources: [
                        MessageSource(eventId: "cnevt_preview_calendar", provider: "google_calendar", title: "Lab sync"),
                        MessageSource(eventId: "cnevt_preview_github", provider: "github", title: "#412 review requested"),
                    ]
                ),
            ],
            research.id: [
                agentMessage(
                    "personal-research-1", conversation: research.id, name: "Research Agent",
                    text: "Two new papers cite your workshop draft.", minutesAgo: 190,
                    sources: [MessageSource(eventId: "cnevt_preview_scholar", provider: "gmail", title: "Scholar alert")]
                ),
            ],
            inbox.id: [],
        ]
        return ([kordi, research, inbox], messages)
    }
}
