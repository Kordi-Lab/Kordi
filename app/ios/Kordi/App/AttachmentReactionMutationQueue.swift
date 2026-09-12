import Foundation

/// Serializes writes to a message and overlays pending choices on older snapshots.
/// UI state and reconciliation belong to AppModel's main actor. Requests outlive
/// the originating view, but account/session guards remain the caller's responsibility.
@MainActor
final class AttachmentReactionMutationQueue {
    struct Scope: Hashable {
        let accountID: String
        // In-memory isolation only; never persisted or used as a view identifier.
        let sessionToken: String?
        let conversationID: String
        let messageID: String
    }

    struct Target: Hashable {
        let attachmentID: String
        let reaction: String
    }

    private struct Intent {
        let id = UUID()
        let target: Target
        let active: Bool
    }

    private final class Entry {
        var confirmed: [Target: Bool] = [:]
        var pending: [Intent] = []
        var tail: Task<Bool, Never>?
    }

    private var entries: [Scope: Entry] = [:]

    func pendingValues(in scope: Scope) -> [Target: Bool] {
        guard let entry = entries[scope] else { return [:] }
        return entry.pending.reduce(into: [:]) { $0[$1.target] = $1.active }
    }

    func toggle(
        in scope: Scope,
        target: Target,
        current: Bool,
        perform: @escaping (Bool) async throws -> Void,
        reconcile: @escaping ([Target: Bool]) -> Void,
        onFailure: @escaping (Error) -> Void
    ) async -> Bool {
        let entry = entries[scope] ?? Entry()
        entries[scope] = entry
        let previousChoice = entry.pending.last { $0.target == target }?.active
        if previousChoice == nil { entry.confirmed[target] = current }
        let intent = Intent(target: target, active: !(previousChoice ?? current))
        entry.pending.append(intent)
        reconcile(pendingValues(in: scope))
        let previous = entry.tail
        let task = Task { @MainActor in
            if let previous { _ = await previous.value }
            let succeeded: Bool
            do {
                try await perform(intent.active)
                entry.confirmed[target] = intent.active
                succeeded = true
            } catch {
                if entry.pending.last(where: { $0.target == target })?.id == intent.id {
                    onFailure(error)
                }
                succeeded = false
            }
            entry.pending.removeAll { $0.id == intent.id }
            var values = pendingValues(in: scope)
            if values[target] == nil { values[target] = entry.confirmed[target] }
            reconcile(values)
            if entry.pending.isEmpty {
                entries[scope] = nil
                entry.tail = nil
            }
            return succeeded
        }
        entry.tail = task
        return await task.value
    }
}
