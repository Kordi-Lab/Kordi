import Foundation

enum ConversationKind: String, Codable, Hashable {
    case person
    case agent
    case group

    var supportsQuotedReplies: Bool {
        self != .agent
    }
}

enum AgentActivity: String, Codable, Hashable {
    case ready
    case replying
    case failed

    var label: String {
        switch self {
        case .ready: "Ready"
        case .replying: "Replying"
        case .failed: "Needs attention"
        }
    }
}

enum AgentExecutionLocation: Hashable {
    case cloud
    case mac(label: String)

    var activeLabel: String {
        switch self {
        case .cloud:
            return "Running in Kordi Cloud"
        case let .mac(label):
            return "Running on \(label)"
        }
    }
}

struct ConversationSummary: Identifiable, Codable, Hashable {
    let id: String
    let kind: ConversationKind
    let peerAccountId: String
    let agentId: String?
    let ownerDisplayName: String?
    var displayName: String
    var lastMessage: String
    var lastActivityAt: Date
    var unreadCount: Int
    var avatarSource: String?
    var agentActivity: AgentActivity?
    let sessionId: String
    let agentDisplayName: String?
    let groupSpaceId: String?
    let groupParticipants: [CloudGroupParticipant]
    let messageCount: Int?
    let forkedFromSessionId: String?

    init(
        id: String,
        kind: ConversationKind,
        peerAccountId: String,
        agentId: String?,
        ownerDisplayName: String?,
        displayName: String,
        lastMessage: String,
        lastActivityAt: Date,
        unreadCount: Int,
        avatarSource: String?,
        agentActivity: AgentActivity?,
        sessionId: String,
        agentDisplayName: String? = nil,
        groupSpaceId: String? = nil,
        groupParticipants: [CloudGroupParticipant] = [],
        messageCount: Int? = nil,
        forkedFromSessionId: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.peerAccountId = peerAccountId
        self.agentId = agentId
        self.ownerDisplayName = ownerDisplayName
        self.displayName = displayName
        self.lastMessage = lastMessage
        self.lastActivityAt = lastActivityAt
        self.unreadCount = unreadCount
        self.avatarSource = avatarSource
        self.agentActivity = agentActivity
        self.sessionId = sessionId
        self.agentDisplayName = agentDisplayName
        self.groupSpaceId = groupSpaceId
        self.groupParticipants = groupParticipants
        self.messageCount = messageCount
        self.forkedFromSessionId = forkedFromSessionId
    }

    var remotePeerAccountIds: [String] {
        if kind == .group {
            return groupParticipants.map(\.accountId).filter { !$0.isEmpty }
        }
        return peerAccountId.isEmpty ? [] : [peerAccountId]
    }

    var cloudChatKind: String {
        switch kind {
        case .person: "direct"
        case .agent: "ai"
        case .group: "group"
        }
    }

    var accessibilitySummary: String {
        let unread = unreadCount > 0 ? ", \(unreadCount) unread" : ""
        let state = agentActivity.map { ", \($0.label)" } ?? ""
        return "\(displayName)\(state)\(unread). \(lastMessage)"
    }

    var representsKordiSupport: Bool {
        KordiSupportIdentity.matches(name: displayName, seed: peerAccountId)
            || KordiSupportIdentity.matches(name: agentDisplayName, seed: agentId)
    }

    /// Agent definitions remain available as launch targets without pretending
    /// that a conversation already exists in the user's session history.
    var isAgentLaunchTemplate: Bool {
        kind == .agent && id.hasPrefix("agent-template:")
    }
}
