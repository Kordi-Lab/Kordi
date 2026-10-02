import Foundation

/// What a report is about: an account (optionally with the contact request
/// it sent) or one message. The server builds the evidence itself from these
/// ids; the app never sends message content.
struct ReportTarget: Identifiable, Hashable {
    static let networkFailureMessage = "Couldn't send your report. Your selections are kept. Try again."

    let id: String
    /// The reported account when it is known. Required for account reports;
    /// for a message report it only enables "Also block".
    let accountId: String?
    let name: String
    /// The session of the reported message.
    let sessionId: String?
    /// The cloud id of the reported message.
    let messageId: String?
    let messagePreview: String?
    let contactRequestId: String?

    var isMessageReport: Bool { messageId != nil }

    var title: String {
        isMessageReport ? "Report messages from \(name)" : "Report \(name)"
    }

    static func account(accountId: String, name: String, contactRequestId: String? = nil) -> ReportTarget {
        ReportTarget(
            id: UUID().uuidString,
            accountId: accountId,
            name: name.nonEmpty ?? "Kordi user",
            sessionId: nil,
            messageId: nil,
            messagePreview: nil,
            contactRequestId: contactRequestId?.nonEmpty
        )
    }

    /// A report for one message someone else sent, or nil when the message
    /// cannot be reported: it is yours, a notice, not yet sent, or from a
    /// conversation the server cannot attribute to another person.
    static func message(
        _ message: ChatMessage,
        in conversation: ConversationSummary,
        selfAccountId: String?
    ) -> ReportTarget? {
        guard message.author != .me,
              !message.isSystemNotice,
              conversation.subsessionId == nil,
              !conversation.isLocalDraft,
              !conversation.representsKordiSupport,
              let messageId = reportableMessageId(message) else { return nil }
        // Your own agent's replies are sent as you.
        if conversation.kind == .agent,
           conversation.peerAccountId.isEmpty || conversation.peerAccountId == selfAccountId {
            return nil
        }
        let accountId = knownSender(of: message, in: conversation, selfAccountId: selfAccountId)
        let participantName = accountId.flatMap { id in
            conversation.groupParticipants.first { $0.accountId == id }?.displayName.nonEmpty
        }
        let name = participantName
            ?? (conversation.kind == .person ? conversation.displayName.nonEmpty : nil)
            ?? message.authorName.nonEmpty
            ?? "Kordi user"
        return ReportTarget(
            id: UUID().uuidString,
            accountId: accountId,
            name: name,
            sessionId: conversation.sessionId,
            messageId: messageId,
            messagePreview: message.text.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
            contactRequestId: nil
        )
    }

    /// The message's cloud id (`reactionTargetMessageId`, else `id`) when
    /// the message has reached the server.
    static func reportableMessageId(_ message: ChatMessage) -> String? {
        guard message.deliveryState != .sending, !message.isLocalFailedSend else { return nil }
        let candidate = message.reactionTargetMessageId?.nonEmpty ?? message.id.nonEmpty
        guard let candidate, let uuid = UUID(uuidString: candidate) else { return nil }
        return uuid.uuidString.lowercased()
    }

    /// The other person in a direct chat, or the one group participant whose
    /// name matches the author. Nil when it is ambiguous.
    static func knownSender(
        of message: ChatMessage,
        in conversation: ConversationSummary,
        selfAccountId: String?
    ) -> String? {
        switch conversation.kind {
        case .person:
            let peer = conversation.peerAccountId
            return peer.isEmpty || peer == selfAccountId || GroupLeavePlan.isServiceAccount(peer) ? nil : peer
        case .group:
            guard message.author == .person else { return nil }
            let matches = conversation.groupParticipants.filter { participant in
                participant.accountId != selfAccountId
                    && !GroupLeavePlan.isServiceAccount(participant.accountId)
                    && participant.displayName.localizedCaseInsensitiveCompare(message.authorName) == .orderedSame
            }
            return matches.count == 1 ? matches[0].accountId : nil
        case .agent:
            return nil
        }
    }

    /// Details as sent: trimmed, without NUL characters, at most 1,000
    /// characters, and nil when empty.
    static func normalizedDetails(_ details: String) -> String? {
        let cleaned = details.replacingOccurrences(of: "\0", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(CloudReportRequest.maxDetailsLength))
    }
}

/// Keeps one client report id while the same report is retried, and starts
/// a new one when the person changes what they send.
struct ReportAttempt: Equatable {
    let key: String
    let clientReportId: String

    static func key(reason: CloudReportReason, details: String) -> String {
        "\(reason.rawValue)\n\(ReportTarget.normalizedDetails(details) ?? "")"
    }

    static func next(after previous: ReportAttempt?, key: String) -> ReportAttempt {
        if let previous, previous.key == key { return previous }
        return ReportAttempt(key: key, clientReportId: UUID().uuidString.lowercased())
    }
}
