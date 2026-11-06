import Foundation

/// The accounts the signed-in person blocked, as message surfaces need them.
struct BlockedAuthorFilter: Hashable {
    var viewerAccountId: String?
    var blockedAccountIds: Set<String> = []

    /// Whether a blocked account wrote the message. An agent's message
    /// counts for its owner when the owner is known.
    func isFromBlockedAccount(_ message: ChatMessage, in conversation: ConversationSummary) -> Bool {
        guard !blockedAccountIds.isEmpty,
              message.author != .me,
              !message.isSystemNotice,
              let sender = ReportTarget.sender(of: message, in: conversation, selfAccountId: viewerAccountId) else { return false }
        return blockedAccountIds.contains(sender.accountId)
    }

    /// In a shared group, a blocked account's message shows as one row.
    func collapses(_ message: ChatMessage, in conversation: ConversationSummary) -> Bool {
        conversation.kind == .group && isFromBlockedAccount(message, in: conversation)
    }
}

extension AppModel {
    var blockedAuthorFilter: BlockedAuthorFilter {
        BlockedAuthorFilter(
            viewerAccountId: account?.accountId,
            blockedAccountIds: Set(blockedAccounts?.map(\.accountId) ?? [])
        )
    }

    /// True when a message alert names a cached message from a blocked
    /// account. The server already drops these pushes; this covers alerts
    /// that arrive while the list changes.
    func isMessageNotificationFromBlockedAccount(_ payload: KordiMessageNotificationPayload) -> Bool {
        let filter = blockedAuthorFilter
        guard !filter.blockedAccountIds.isEmpty,
              payload.accountID == account?.accountId,
              let conversation = conversationForNotification(canonicalConversationID: payload.sessionID),
              let message = messagesByConversation[conversation.id]?.first(where: {
                  $0.id == payload.messageID || $0.reactionTargetMessageId == payload.messageID
                      || (payload.messageSequence != nil && $0.conversationSequence == payload.messageSequence)
              }) else { return false }
        return filter.isFromBlockedAccount(message, in: conversation)
    }
}
