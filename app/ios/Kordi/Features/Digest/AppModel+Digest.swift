import Foundation

enum DigestOptimisticChange: Equatable {
    case feedback(id: String, dismissed: Bool)
    case removal(key: String, eventIDs: Set<String>)

    var key: String {
        switch self {
        case .feedback(let id, _): "suggestion:\(id)"
        case .removal(let key, _): key
        }
    }
    var eventIDs: Set<String> {
        if case .removal(_, let ids) = self { return ids }
        return []
    }
    var failureMessage: String {
        switch self {
        case .feedback: "Could not confirm the suggestion change. Please try again."
        case .removal: "Removal was not confirmed. Please review the event and try again."
        }
    }
}

struct DigestMutationState: Equatable {
    var overlays: [String: DigestOptimisticChange] = [:]
    var pending: Set<String> = []
    var errors: [String: String] = [:]

    var removedEventIDs: Set<String> { overlays.values.reduce(into: Set<String>()) { $0.formUnion($1.eventIDs) } }
    var hasPendingFeedback: Bool { pending.contains { if case .feedback = overlays[$0] { return true }; return false } }
    var hasPendingRemoval: Bool { pending.contains { !(overlays[$0]?.eventIDs.isEmpty ?? true) } }

    func suggestions(in digest: RollingDigestResponse?, dismissed: Bool) -> [RollingDigestItem] {
        let serverDismissed = Set((digest?.feedback ?? []).filter { $0.status == "dismissed" }.map(\.id))
        return (digest?.snapshot?.suggestions ?? []).filter { item in
            let isDismissed: Bool
            if case .feedback(_, let value) = overlays["suggestion:\(item.id)"] { isDismissed = value }
            else { isDismissed = serverDismissed.contains(item.id) }
            return isDismissed == dismissed
        }
    }

    mutating func reconcile(digest: RollingDigestResponse) {
        let dismissed = Set(digest.feedback.filter { $0.status == "dismissed" }.map(\.id))
        for (key, change) in overlays where !pending.contains(key) {
            if case .feedback(let id, let value) = change, dismissed.contains(id) == value {
                overlays[key] = nil
            }
        }
    }

    mutating func reconcile(calendar: DigestCalendarResponse) {
        let existing = Set(calendar.events.map(\.id))
        for (key, change) in overlays where !pending.contains(key) {
            if case .removal(_, let ids) = change, existing.isDisjoint(with: ids) { overlays[key] = nil }
        }
    }
}

/// One account-owned read survives transient screen cancellation. Keep only one
/// recent response to join refreshes and avoid repeated reads during rapid reentry.
@MainActor
final class DigestReadCoordinator<Value> {
    private var running: (scope: [String], id: UUID, task: Task<Value, Error>)?
    private var completed: (scope: [String], value: Value, at: ContinuousClock.Instant)?

    func read(scope: [String], maximumAge: Duration = .seconds(3), operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        if let completed, completed.scope == scope,
           completed.at.duration(to: .now) < maximumAge { return completed.value }
        let task: Task<Value, Error>
        if let running, running.scope == scope {
            task = running.task
        } else {
            reset()
            let id = UUID()
            task = Task { @MainActor [weak self] in
                defer { if self?.running?.id == id { self?.running = nil } }
                let result = try await operation()
                try Task.checkCancellation()
                guard self?.running?.id == id else { throw CancellationError() }
                self?.completed = (scope, result, .now)
                return result
            }
            running = (scope, id, task)
        }
        let result = try await task.value
        try Task.checkCancellation()
        return result
    }

    func reset() {
        running?.task.cancel()
        running = nil
        completed = nil
    }
}

extension AppModel {
    func resetDigestReads() {
        invalidateDigestReads()
        digestMutationTasks.values.forEach { $0.task.cancel() }
        digestMutationTasks = [:]
        digestMutationState = DigestMutationState()
        rollingDigestSnapshot = nil
        digestCalendarSnapshot = nil
    }
    private func invalidateDigestReads() {
        rollingDigestRead.reset()
        digestCalendarRead.reset()
    }
    func invalidateDigestReads(accountId: String) {
        if account?.accountId == accountId { invalidateDigestReads() }
    }
    private func discardUnauthorizedDigest(error: Error, token: String, accountId: String) {
        guard let error = error as? CloudAPIError, [401, 403].contains(error.statusCode),
              let (_, currentToken, currentAccount) = try? digestContext(),
              currentToken == token, currentAccount == accountId else { return }
        resetDigestReads()
    }
    func loadRollingDigest() async throws -> RollingDigestResponse {
        let (api, token, accountId) = try digestContext()
        let response = try await rollingDigestRead.read(scope: [accountId, token, Locale.current.identifier, TimeZone.current.identifier]) {
            let response: RollingDigestResponse
            do { response = try await api.rollingDigest(token: token) }
            catch { self.discardUnauthorizedDigest(error: error, token: token, accountId: accountId); throw error }
            try Task.checkCancellation()
            let (_, currentToken, currentAccount) = try self.digestContext()
            guard currentToken == token, currentAccount == accountId,
                  response.accountId == accountId else { throw CancellationError() }
            if self.rollingDigestSnapshot != response { self.rollingDigestSnapshot = response }
            var mutations = self.digestMutationState
            mutations.reconcile(digest: response)
            if mutations != self.digestMutationState { self.digestMutationState = mutations }
            return response
        }
        let (_, currentToken, currentAccount) = try digestContext()
        guard currentToken == token, currentAccount == accountId else { throw CancellationError() }
        return response
    }
    func refreshRollingDigest() async throws {
        let (api, token, accountId) = try digestContext()
        try await api.refreshDigest(token: token)
        invalidateDigestReads(accountId: accountId)
    }
    func loadDigestCalendar() async throws -> DigestCalendarResponse {
        let (api, token, accountId) = try digestContext()
        let response = try await digestCalendarRead.read(scope: [accountId, token, Locale.current.identifier, TimeZone.current.identifier]) {
            let response: DigestCalendarResponse
            do { response = try await api.digestCalendar(token: token) }
            catch { self.discardUnauthorizedDigest(error: error, token: token, accountId: accountId); throw error }
            try Task.checkCancellation()
            let (_, currentToken, currentAccount) = try self.digestContext()
            guard currentToken == token, currentAccount == accountId else { throw CancellationError() }
            if self.digestCalendarSnapshot != response { self.digestCalendarSnapshot = response }
            var mutations = self.digestMutationState
            mutations.reconcile(calendar: response)
            if mutations != self.digestMutationState { self.digestMutationState = mutations }
            return response
        }
        let (_, currentToken, currentAccount) = try digestContext()
        guard currentToken == token, currentAccount == accountId else { throw CancellationError() }
        return response
    }
    func saveDigestCalendarEvent(_ event: DigestCalendarEvent) async throws {
        let (api, token, accountId) = try digestContext()
        _ = try await api.saveDigestEvent(token: token, event: event)
        invalidateDigestReads(accountId: accountId)
    }
    func previewDigestCalendarSeries(_ event: DigestCalendarEvent) async throws -> [DigestCalendarEvent] {
        let (api, token, accountId) = try digestContext()
        let result = try await api.previewDigestSeries(token: token, event: event)
        guard self.account?.accountId == accountId else { throw CancellationError() }
        return result.events
    }
    func importDigestCalendar(_ events: [DigestCalendarEvent]) async throws -> DigestCalendarImportReport {
        let (api, token, accountId) = try digestContext()
        defer { invalidateDigestReads(accountId: accountId) }
        let current = try await api.digestCalendar(token: token)
        return try await importDigestCalendarEvents(events, existing: current.events) { event in
            guard self.account?.accountId == accountId else { throw CancellationError() }
            _ = try await api.saveDigestEvent(token: token, event: event)
        }
    }
    func removeDigestCalendarEvent(_ event: DigestCalendarEvent) async throws {
        try await beginRemovingDigestCalendarEvent(event).value
    }
    func beginRemovingDigestCalendarEvent(_ event: DigestCalendarEvent) throws -> Task<Void, Error> {
        let (api, token, accountId) = try digestContext()
        return try beginDigestMutation(.removal(key: "event:\(event.id)", eventIDs: [event.id]), token: token, accountId: accountId) {
            try await api.removeDigestEvent(token: token, event: event)
        }
    }
    func removeDigestCalendarSeries(_ id: String, events: [DigestCalendarEvent]) async throws {
        try await beginRemovingDigestCalendarSeries(id, events: events).value
    }
    func beginRemovingDigestCalendarSeries(_ id: String, events: [DigestCalendarEvent]) throws -> Task<Void, Error> {
        let (api, token, accountId) = try digestContext()
        return try beginDigestMutation(.removal(key: "series:\(id)", eventIDs: Set(events.map(\.id))), token: token, accountId: accountId) {
            try await api.removeDigestSeries(token: token, id: id, events: events)
        }
    }
    func dismissDigestItem(_ id: String, dismissed: Bool) async throws {
        try await beginDismissingDigestItem(id, dismissed: dismissed).value
    }
    func beginDismissingDigestItem(_ id: String, dismissed: Bool) throws -> Task<Void, Error> {
        let (api, token, accountId) = try digestContext()
        return try beginDigestMutation(.feedback(id: id, dismissed: dismissed), token: token, accountId: accountId) {
            try await api.dismissDigestItem(token: token, id: id, dismissed: dismissed)
        }
    }

    /// Called only by an explicit user action. The account owns the save after a
    /// sheet closes; polling remains authoritative underneath this per-item overlay.
    func beginDigestMutation(_ change: DigestOptimisticChange, token: String, accountId: String,
                             operation: @escaping @MainActor () async throws -> Void) throws -> Task<Void, Error> {
        let (_, currentToken, currentAccount) = try digestContext()
        guard currentToken == token, currentAccount == accountId else { throw CancellationError() }
        let key = change.key
        if let running = digestMutationTasks[key] {
            guard digestMutationState.overlays[key] == change else { throw DigestCalendarError(message: "This change is still saving. Please wait.") }
            return running.task
        }
        if digestMutationState.overlays[key] == change { return Task {} }
        guard digestMutationState.pending.allSatisfy({ digestMutationState.overlays[$0]?.eventIDs.isDisjoint(with: change.eventIDs) != false }) else {
            throw DigestCalendarError(message: "These events are still saving. Please wait.")
        }
        let previous = digestMutationState.overlays[key]
        invalidateDigestReads()
        digestMutationState.overlays[key] = change
        digestMutationState.pending.insert(key)
        digestMutationState.errors[key] = nil
        let id = UUID()
        let task = Task { @MainActor [weak self] in
            do {
                try await operation()
                try Task.checkCancellation()
                guard let self, self.digestMutationTasks[key]?.id == id else { throw CancellationError() }
                let (_, latestToken, latestAccount) = try self.digestContext()
                guard latestToken == token, latestAccount == accountId else { throw CancellationError() }
                self.digestMutationTasks[key] = nil
                self.digestMutationState.pending.remove(key)
                // Reject reads started before acknowledgment. Keep this overlay
                // until a later successful read confirms it, even if refresh fails.
                self.invalidateDigestReads()
            } catch {
                if let self, self.digestMutationTasks[key]?.id == id {
                    self.digestMutationTasks[key] = nil
                    self.digestMutationState.pending.remove(key)
                    self.digestMutationState.overlays[key] = previous
                    if let (_, latestToken, latestAccount) = try? self.digestContext(), latestToken == token, latestAccount == accountId {
                        self.digestMutationState.errors[key] = change.failureMessage
                        self.invalidateDigestReads()
                    }
                }
                throw error
            }
        }
        digestMutationTasks[key] = (id, task)
        return task
    }
    func createDigestTask(_ id: String, input: DigestTaskInput) async throws {
        let (api, token, accountId) = try digestContext()
        _ = try await api.createDigestTask(token: token, id: id, input: input)
        invalidateDigestReads(accountId: accountId)
    }
}
