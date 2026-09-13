import Foundation
import UserNotifications

struct KordiDeliveredMessageNotification {
    let identifier: String
    let payload: KordiMessageNotificationPayload
}

@MainActor
protocol KordiMessageNotificationStore {
    func deliveredMessages() async -> [KordiDeliveredMessageNotification]
    func removeDeliveredMessages(withIdentifiers identifiers: [String])
}

@MainActor
struct SystemMessageNotificationStore: KordiMessageNotificationStore {
    func deliveredMessages() async -> [KordiDeliveredMessageNotification] {
        await UNUserNotificationCenter.current().deliveredNotifications().compactMap { notification in
            guard let payload = KordiMessageNotificationPayload(notification.request.content.userInfo) else {
                return nil
            }
            return KordiDeliveredMessageNotification(identifier: notification.request.identifier, payload: payload)
        }
    }

    func removeDeliveredMessages(withIdentifiers identifiers: [String]) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}

struct KordiMessageNotificationReadState {
    let lastReadSequence: Int64
    let threadReadCursors: [String: Int64]
    let messages: [ChatMessage]

    func contains(_ payload: KordiMessageNotificationPayload) -> Bool {
        // Older pushes omit the sequence. Resolve their server ID against the
        // cached message aliases; missing history is not evidence of a read.
        let sequence = payload.messageSequence ?? messages.first(where: {
            $0.id == payload.messageID || $0.reactionTargetMessageId == payload.messageID
                || $0.clientMessageId == payload.messageID
        })?.conversationSequence
        guard let sequence, sequence > 0 else { return false }
        if let root = payload.threadRootID {
            // Reading the main timeline does not read its thread replies.
            return sequence <= (threadReadCursors[root] ?? 0)
        }
        return sequence <= lastReadSequence
    }
}
