import Foundation

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
        let (api, token, accountId) = try digestContext()
        try await api.removeDigestEvent(token: token, event: event)
        invalidateDigestReads(accountId: accountId)
    }
    func removeDigestCalendarSeries(_ id: String, events: [DigestCalendarEvent]) async throws {
        let (api, token, accountId) = try digestContext()
        try await api.removeDigestSeries(token: token, id: id, events: events)
        invalidateDigestReads(accountId: accountId)
    }
    func dismissDigestItem(_ id: String, dismissed: Bool) async throws {
        let (api, token, accountId) = try digestContext()
        try await api.dismissDigestItem(token: token, id: id, dismissed: dismissed)
        invalidateDigestReads(accountId: accountId)
    }
    func createDigestTask(_ id: String, input: DigestTaskInput) async throws {
        let (api, token, accountId) = try digestContext()
        _ = try await api.createDigestTask(token: token, id: id, input: input)
        invalidateDigestReads(accountId: accountId)
    }
}
