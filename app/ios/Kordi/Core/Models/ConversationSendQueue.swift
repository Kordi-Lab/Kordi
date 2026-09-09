import Foundation

/// Orders delivery within a conversation while each composer stages new messages.
@MainActor
final class ConversationSendQueue {
    private var active = Set<String>()
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func acquire(_ conversationID: String) async {
        if active.insert(conversationID).inserted { return }
        await withCheckedContinuation { continuation in
            waiters[conversationID, default: []].append(continuation)
        }
    }

    func release(_ conversationID: String) {
        guard var queued = waiters[conversationID], !queued.isEmpty else {
            active.remove(conversationID)
            return
        }
        let next = queued.removeFirst()
        waiters[conversationID] = queued.isEmpty ? nil : queued
        next.resume()
    }
}
