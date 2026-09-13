import Foundation

enum ConversationMessageOrdering {
    static func displayMessages(_ messages: [ChatMessage]) -> [ChatMessage] {
        // Imported history and agent response anchors retain their display dates.
        let chronological = messages.sorted {
            $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id)
        }
        let unconfirmedIDs = Set(messages.filter(isUnconfirmedSend).flatMap {
            [$0.id, $0.clientMessageId].compactMap { $0 }
        })
        guard !unconfirmedIDs.isEmpty else { return chronological }

        var confirmed: [ChatMessage] = []
        var unconfirmed: [ChatMessage] = []
        for message in chronological {
            let followsUnconfirmedRequest = message.author == .agent
                && message.requestMessageId.map(unconfirmedIDs.contains) == true
            if isUnconfirmedSend(message) || followsUnconfirmedRequest {
                unconfirmed.append(message)
            } else {
                confirmed.append(message)
            }
        }
        // Device draft times must not place new sends inside server history.
        return confirmed + unconfirmed
    }

    private static func isUnconfirmedSend(_ message: ChatMessage) -> Bool {
        message.author == .me
            && (message.conversationSequence ?? 0) <= 0
            && (message.deliveryState == .sending || message.deliveryState == .failed)
    }
}
