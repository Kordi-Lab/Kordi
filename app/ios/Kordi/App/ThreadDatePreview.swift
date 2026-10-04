import Foundation

enum ThreadDatePreview {
    static func replacing(_ messages: [ChatMessage], now: Date) -> [ChatMessage] {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("--preview-data"), arguments.contains("--preview-thread-dates") else { return messages }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        let source = message("m5", author: .person, text: "Can you send the latest numbers?", date: today.addingTimeInterval(9 * 3_600 + 15 * 60))
        let reply = message("m5-reply-own", author: .me, text: "The updated report is ready for review.", date: today.addingTimeInterval(11 * 3_600), source: source)
        return [
            message("m3", author: .person, text: "The rollout notes are ready.", date: yesterday.addingTimeInterval(9 * 3_600)),
            message("m4", author: .me, text: "Thanks. I will review them after lunch.", date: yesterday.addingTimeInterval(14 * 3_600 + 30 * 60)),
            message("thread-date-evening", author: .person, text: "I added the final device checks to the notes.", date: yesterday.addingTimeInterval(18 * 3_600)),
            source, reply,
            message("m5-reply-peer", author: .person, text: "Looks good. The numbers match the release checklist.", date: today.addingTimeInterval(11 * 3_600 + 60), source: reply),
        ]
    }

    private static func message(_ id: String, author: MessageAuthor, text: String, date: Date, source: ChatMessage? = nil) -> ChatMessage {
        ChatMessage(id: id, conversationId: "person:acct_maya", author: author,
                    authorName: author == .me ? "You" : "Maya Chen", text: text, createdAt: date,
                    deliveryState: .read, errorMessage: nil, requestMessageId: nil,
                    replyToMessageId: source?.id,
                    messageAction: source.map { .quote(MessageActionSource(
                        sourceSessionId: $0.conversationId, sourceMessageId: $0.id, senderLabel: $0.authorName,
                        textPreview: $0.text, attachmentCount: 0)) })
    }
}
