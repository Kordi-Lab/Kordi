import Foundation

/// A person who can be blocked, or whose account a report names.
struct SafetyAccount: Identifiable, Hashable {
    let accountId: String
    let name: String
    var kordiId: String? = nil
    var avatarUrl: String? = nil

    var id: String { accountId }

    init(accountId: String, name: String, kordiId: String? = nil, avatarUrl: String? = nil) {
        self.accountId = accountId
        self.name = name.nonEmpty ?? "Kordi user"
        self.kordiId = kordiId?.nonEmpty
        self.avatarUrl = avatarUrl?.nonEmpty
    }

    /// Kordi Support and the System accounts can't be blocked or reported.
    static func isServiceAccount(_ accountId: String) -> Bool {
        KordiSystemIdentity.isServiceAccount(accountId) || KordiSupportIdentity.matches(name: nil, seed: accountId)
    }
}

/// What a report is about: an account (optionally the contact request it
/// sent) or one message. The server copies message evidence itself.
struct ReportTarget: Identifiable, Hashable {
    let id = UUID()
    /// The reported person, when known. A message report without one lets
    /// the server find the sender and offers no "Also block".
    let account: SafetyAccount?
    /// The legacy session id of the reported message's conversation.
    var sessionId: String? = nil
    /// The chat sync v2 id of the reported message.
    var messageId: String? = nil
    var contactRequestId: String? = nil
    /// False when the reported account is an agent: block its owner instead.
    var offersBlock = true

    var title: String {
        messageId == nil ? "Report \(account?.name ?? "Kordi user")" : "Report message"
    }

    static func account(_ account: SafetyAccount, contactRequestId: String? = nil) -> ReportTarget {
        ReportTarget(account: account, contactRequestId: contactRequestId?.nonEmpty)
    }

    func request(reason: CloudReportReason, details: String, alsoBlock: Bool, clientReportId: String) -> CloudReportRequest {
        CloudReportRequest(
            clientReportId: clientReportId,
            reason: reason,
            details: Self.normalizedDetails(details),
            reportedAccountId: account?.accountId,
            messageIds: messageId.map { [$0] },
            contactRequestId: contactRequestId,
            alsoBlock: alsoBlock && offersBlock && account != nil ? true : nil
        )
    }

    /// Trimmed, at most 1,000 characters, and nil when empty.
    static func normalizedDetails(_ details: String) -> String? {
        let cleaned = details.replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(CloudReportRequest.maxDetailsLength))
    }

    /// A report for a message someone else wrote, or nil when the message
    /// can't be reported: yours, a notice, not yet on the server, or from
    /// Kordi Support or your own agent.
    static func message(
        _ message: ChatMessage,
        in conversation: ConversationSummary,
        selfAccountId: String?,
        isPreviewMode: Bool
    ) -> ReportTarget? {
        guard message.author != .me,
              !message.isSystemNotice,
              !KordiSystemIdentity.isSystemNotice(message),
              conversation.subsessionId == nil,
              !conversation.isLocalDraft,
              !conversation.representsKordiSupport,
              !(message.author == .agent && message.senderOwnerName == "You") else { return nil }
        if conversation.kind == .agent,
           conversation.personalAgentId != nil || conversation.peerAccountId.isEmpty || conversation.peerAccountId == selfAccountId {
            return nil
        }
        guard let messageId = reportableMessageId(message, isPreviewMode: isPreviewMode) else { return nil }
        return ReportTarget(
            account: sender(of: message, in: conversation, selfAccountId: selfAccountId),
            sessionId: conversation.sessionId,
            messageId: messageId
        )
    }

    /// The message's chat sync v2 id once it reached the server. Preview
    /// messages use their sample ids.
    static func reportableMessageId(_ message: ChatMessage, isPreviewMode: Bool) -> String? {
        let candidate = message.reactionTargetMessageId?.nonEmpty ?? message.id.nonEmpty
        if isPreviewMode { return candidate }
        guard message.deliveryState != .sending, !message.isLocalFailedSend,
              let candidate, let uuid = UUID(uuidString: candidate) else { return nil }
        return uuid.uuidString.lowercased()
    }

    /// The person behind a message: the other person in a direct chat, or
    /// the one group member whose name matches the author (or, for an
    /// agent's message, its owner). Nil when unknown or ambiguous.
    static func sender(of message: ChatMessage, in conversation: ConversationSummary, selfAccountId: String?) -> SafetyAccount? {
        switch conversation.kind {
        case .person:
            let peer = conversation.peerAccountId
            guard !peer.isEmpty, peer != selfAccountId, !SafetyAccount.isServiceAccount(peer) else { return nil }
            return SafetyAccount(accountId: peer, name: conversation.displayName, avatarUrl: conversation.avatarSource)
        case .group:
            let name = message.author == .agent ? message.senderOwnerName : message.authorName
            guard let name = name?.nonEmpty else { return nil }
            let matches = conversation.groupParticipants.filter { participant in
                participant.accountId != selfAccountId
                    && !SafetyAccount.isServiceAccount(participant.accountId)
                    && participant.displayName.localizedCaseInsensitiveCompare(name) == .orderedSame
            }
            guard matches.count == 1, let participant = matches.first else { return nil }
            return SafetyAccount(accountId: participant.accountId, name: participant.displayName, avatarUrl: participant.avatarUrl)
        case .agent:
            return nil
        }
    }

    /// The Report action for the message menu, or nil when the message can't be reported.
    @MainActor
    static func messageAction(
        for message: ChatMessage,
        in conversation: ConversationSummary,
        model: AppModel,
        present: @escaping (ReportTarget) -> Void
    ) -> (() -> Void)? {
        guard let target = ReportTarget.message(
            message, in: conversation, selfAccountId: model.account?.accountId, isPreviewMode: model.isPreviewMode
        ) else { return nil }
        return { present(target) }
    }
}

/// Keeps one client report id while the same report is retried, and starts
/// a new one when the person changes what they send.
struct ReportAttempt: Equatable {
    let key: String
    let clientReportId: String

    static func key(reason: CloudReportReason, details: String, alsoBlock: Bool) -> String {
        "\(reason.rawValue)\n\(alsoBlock)\n\(ReportTarget.normalizedDetails(details) ?? "")"
    }

    static func next(after previous: ReportAttempt?, key: String) -> ReportAttempt {
        if let previous, previous.key == key { return previous }
        return ReportAttempt(key: key, clientReportId: UUID().uuidString.lowercased())
    }
}

extension ContactProfilePresentation {
    /// Who Block applies to: the person, or an agent's owner. Nil for Kordi
    /// accounts, yourself, and your own agents.
    var blockAccount: SafetyAccount? {
        switch kind {
        case .system:
            return nil
        case .person:
            guard subject.accountId != selfAccountId, !SafetyAccount.isServiceAccount(subject.accountId) else { return nil }
            return SafetyAccount(accountId: subject.accountId, name: name, kordiId: kordiId, avatarUrl: avatarUrl)
        case .agent:
            guard !isOwnAgent, let owner = profile?.owner, owner.accountId != selfAccountId,
                  !SafetyAccount.isServiceAccount(owner.accountId) else { return nil }
            return SafetyAccount(
                accountId: owner.accountId,
                name: owner.displayName?.nonEmpty ?? owner.kordiId ?? "Kordi user",
                kordiId: owner.kordiId,
                avatarUrl: owner.avatarUrl
            )
        }
    }

    /// The account a report from the profile names: the person, or the agent itself.
    var reportTarget: ReportTarget? {
        switch kind {
        case .system:
            return nil
        case .person:
            return blockAccount.map { ReportTarget.account($0) }
        case .agent:
            guard !isOwnAgent, subject.accountId != selfAccountId, !SafetyAccount.isServiceAccount(subject.accountId) else { return nil }
            var target = ReportTarget.account(SafetyAccount(accountId: subject.accountId, name: name, kordiId: kordiId, avatarUrl: avatarUrl))
            target.offersBlock = false
            return target
        }
    }
}
