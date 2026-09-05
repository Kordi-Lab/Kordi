import Foundation

enum ConversationKind: String, Codable, Hashable {
    case person
    case agent
    case group

    var supportsQuotedReplies: Bool {
        self != .agent
    }

    var supportsThreadedReplies: Bool {
        true
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

func chatListTimestamp(
    _ date: Date,
    now: Date = Date(),
    calendar: Calendar = .autoupdatingCurrent,
    locale: Locale = .autoupdatingCurrent
) -> String {
    if date == .distantPast { return "" }
    let format = Date.FormatStyle(
        date: .omitted,
        time: .omitted,
        locale: locale,
        calendar: calendar,
        timeZone: calendar.timeZone
    )
    if calendar.isDate(date, inSameDayAs: now) {
        return date.formatted(Date.FormatStyle(
            date: .omitted,
            time: .shortened,
            locale: locale,
            calendar: calendar,
            timeZone: calendar.timeZone
        ))
    }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
       calendar.isDate(date, inSameDayAs: yesterday) {
        return "Yesterday"
    }
    let monthAndDay = format.month(.twoDigits).day(.twoDigits)
    return calendar.component(.year, from: date) == calendar.component(.year, from: now)
        ? date.formatted(monthAndDay)
        : date.formatted(monthAndDay.year())
}

struct ConversationSummary: Identifiable, Hashable {
    let id: String
    let kind: ConversationKind
    let peerAccountId: String
    let agentId: String?
    let ownerDisplayName: String?
    var displayName: String
    var lastMessage: String
    var lastAttachment: ChatAttachment?
    var lastActivityAt: Date
    var unreadCount: Int
    var unreadMentionCount: Int
    var lastReadSequence: Int64
    var avatarSource: String?
    var agentActivity: AgentActivity?
    let sessionId: String
    let agentDisplayName: String?
    let groupSpaceId: String?
    let groupParticipants: [CloudGroupParticipant]
    let messageCount: Int?
    let forkedFromSessionId: String?
    /// A locally created agent session has no remote history until its first send.
    let isLocalDraft: Bool

    init(
        id: String,
        kind: ConversationKind,
        peerAccountId: String,
        agentId: String?,
        ownerDisplayName: String?,
        displayName: String,
        lastMessage: String,
        lastAttachment: ChatAttachment? = nil,
        lastActivityAt: Date,
        unreadCount: Int,
        avatarSource: String?,
        agentActivity: AgentActivity?,
        sessionId: String,
        agentDisplayName: String? = nil,
        groupSpaceId: String? = nil,
        groupParticipants: [CloudGroupParticipant] = [],
        messageCount: Int? = nil,
        forkedFromSessionId: String? = nil,
        unreadMentionCount: Int = 0,
        lastReadSequence: Int64 = 0,
        isLocalDraft: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.peerAccountId = peerAccountId
        self.agentId = kind == .agent
            ? CanonicalAvatarSystem.agentID(agentId, ownerAccountID: peerAccountId)
            : agentId
        self.ownerDisplayName = ownerDisplayName
        self.displayName = displayName
        self.lastMessage = lastMessage
        self.lastAttachment = lastAttachment
        self.lastActivityAt = lastActivityAt
        self.unreadCount = unreadCount
        self.unreadMentionCount = unreadMentionCount
        self.lastReadSequence = lastReadSequence
        self.avatarSource = avatarSource
        self.agentActivity = agentActivity
        self.sessionId = sessionId
        self.agentDisplayName = agentDisplayName
        self.groupSpaceId = groupSpaceId
        self.groupParticipants = groupParticipants
        self.messageCount = messageCount
        self.forkedFromSessionId = forkedFromSessionId
        self.isLocalDraft = isLocalDraft
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
        let mentions = unreadMentionCount > 0
            ? ", \(unreadMentionCount) unread mention\(unreadMentionCount == 1 ? "" : "s")"
            : ""
        let state = agentActivity.map { ", \($0.label)" } ?? ""
        return "\(displayName)\(state)\(unread)\(mentions). \(BlobEmojiComposerText.plainText(previewText))"
    }

    var previewText: String {
        if let text = lastMessage.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
            return text
        }
        guard let attachment = lastAttachment else { return "" }
        if attachment.subtype == .sticker { return "Sticker" }
        let mimeType = attachment.mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if mimeType == "image/gif"
            || URL(fileURLWithPath: attachment.name).pathExtension.lowercased() == "gif" {
            return "GIF"
        }
        return attachment.kind == .image ? "Photo" : attachment.name
    }

    var hasUnreadAttention: Bool {
        unreadCount > 0 || unreadMentionCount > 0
    }

    func canManageGroup(accountId: String?) -> Bool {
        guard kind == .group,
              let accountId = accountId?.nonEmpty,
              let role = groupParticipants.first(where: { $0.accountId == accountId })?.role?.lowercased()
        else { return false }
        return role == "owner" || role == "admin"
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

enum ConversationAuthorProfileResolver {
    static func destination(
        currentConversation: ConversationSummary,
        message: ChatMessage,
        selfAccountID: String?,
        contacts: [CloudContact],
        conversations: [ConversationSummary]
    ) -> ConversationSummary? {
        guard message.author == .person else { return nil }
        if currentConversation.kind == .person { return currentConversation }
        guard currentConversation.kind == .group else { return nil }

        let matches = currentConversation.groupParticipants.filter { participant in
            participant.accountId != selfAccountID
                && participant.displayName.localizedCaseInsensitiveCompare(message.authorName) == .orderedSame
        }
        guard matches.count == 1, let participant = matches.first else { return nil }
        return destination(
            currentConversation: currentConversation,
            participant: participant,
            selfAccountID: selfAccountID,
            contacts: contacts,
            conversations: conversations
        )
    }

    static func destination(
        currentConversation: ConversationSummary,
        participant: CloudGroupParticipant,
        selfAccountID: String?,
        contacts: [CloudContact],
        conversations: [ConversationSummary]
    ) -> ConversationSummary? {
        guard currentConversation.kind == .group,
              participant.accountId.nonEmpty != nil,
              participant.accountId != selfAccountID else { return nil }
        if let existing = conversations.first(where: { conversation in
            conversation.kind == .person && conversation.peerAccountId == participant.accountId
        }) {
            return existing
        }
        guard let selfAccountID = selfAccountID?.nonEmpty else { return nil }

        let contact = contacts.first { $0.accountId == participant.accountId }
        let displayName = contact?.preferredName.nonEmpty
            ?? participant.displayName.nonEmpty
            ?? "Kordi user"
        return ConversationSummary(
            id: "person:\(participant.accountId)",
            kind: .person,
            peerAccountId: participant.accountId,
            agentId: nil,
            ownerDisplayName: displayName,
            displayName: displayName,
            lastMessage: "Start a conversation",
            lastActivityAt: currentConversation.lastActivityAt,
            unreadCount: 0,
            avatarSource: contact?.avatarUrl.nonEmpty ?? participant.avatarUrl?.nonEmpty,
            agentActivity: nil,
            sessionId: directPersonSessionId(selfAccountID, participant.accountId)
        )
    }
}
