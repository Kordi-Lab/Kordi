import Foundation

enum ConversationMessageOrdering {
    static func displayMessages(_ messages: [ChatMessage]) -> [ChatMessage] {
        let chronological = messages.sorted {
            $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id)
        }
        var aliases: [String: String] = [:]
        for message in chronological {
            aliases[message.id] = message.id
            if let clientID = message.clientMessageId { aliases[clientID] = message.id }
        }
        var children: [String: [ChatMessage]] = [:]
        var roots: [ChatMessage] = []
        var legacySending: [ChatMessage] = []
        let localIDs = Set(chronological.filter(isUnconfirmedSend).flatMap {
            [$0.id, $0.clientMessageId].compactMap { $0 }
        })
        for message in chronological {
            if isUnconfirmedSend(message), let anchor = message.localTimelineAnchorID,
               anchor.isEmpty || (aliases[anchor] != nil && aliases[anchor] != message.id) {
                children[aliases[anchor] ?? "", default: []].append(message)
            } else if message.author == .agent, let request = message.requestMessageId,
                      localIDs.contains(request), let anchor = aliases[request], anchor != message.id {
                children[anchor, default: []].append(message)
            } else if isUnconfirmedSend(message), message.deliveryState == .sending,
                      message.localTimelineAnchorID == nil {
                // Compatibility for drafts staged before local anchors existed.
                legacySending.append(message)
            } else {
                // Old failures retain their date instead of following every new send.
                roots.append(message)
            }
        }
        var result: [ChatMessage] = []
        var emitted = Set<String>()
        func append(_ message: ChatMessage) {
            guard emitted.insert(message.id).inserted else { return }
            result.append(message)
            for child in children[message.id] ?? [] { append(child) }
        }
        for message in children[""] ?? [] { append(message) }
        for message in roots + legacySending { append(message) }
        // Missing or cyclic legacy anchors must never hide a message.
        for message in chronological { append(message) }
        return result
    }

    static func anchorForSend(in messages: [ChatMessage], retrying message: ChatMessage?) -> String {
        if let anchor = message?.localTimelineAnchorID { return anchor }
        let ordered = displayMessages(messages)
        let preceding: ChatMessage?
        if let message, let index = ordered.firstIndex(where: { $0.id == message.id }) {
            preceding = index > 0 ? ordered[index - 1] : nil
        } else {
            preceding = ordered.last
        }
        return preceding?.clientMessageId ?? preceding?.id ?? ""
    }

    private static func isUnconfirmedSend(_ message: ChatMessage) -> Bool {
        message.author == .me
            && (message.conversationSequence ?? 0) <= 0
            && (message.deliveryState == .sending || message.deliveryState == .failed)
    }
}
