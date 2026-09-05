import Foundation

extension AppModel {
    func loadRollingDigest() async throws -> RollingDigestResponse {
        let (api, token, accountId) = try digestContext()
        let response = try await api.rollingDigest(token: token)
        guard self.account?.accountId == accountId, response.accountId == accountId else { throw CancellationError() }
        return response
    }
    func refreshRollingDigest() async throws {
        let (api, token, _) = try digestContext()
        try await api.refreshDigest(token: token)
    }
    func loadDigestCalendar() async throws -> DigestCalendarResponse {
        let (api, token, _) = try digestContext()
        return try await api.digestCalendar(token: token)
    }
    func saveDigestCalendarEvent(_ event: DigestCalendarEvent) async throws {
        let (api, token, _) = try digestContext()
        _ = try await api.saveDigestEvent(token: token, event: event)
    }
    func removeDigestCalendarEvent(_ event: DigestCalendarEvent) async throws {
        let (api, token, _) = try digestContext()
        try await api.removeDigestEvent(token: token, event: event)
    }
    func dismissDigestItem(_ id: String, dismissed: Bool) async throws {
        let (api, token, _) = try digestContext()
        try await api.dismissDigestItem(token: token, id: id, dismissed: dismissed)
    }
    func createDigestTask(_ id: String, input: DigestTaskInput) async throws {
        let (api, token, _) = try digestContext()
        _ = try await api.createDigestTask(token: token, id: id, input: input)
    }
}
