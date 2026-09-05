import Foundation

extension CloudAPIClient {
    func rollingDigest(token: String) async throws -> RollingDigestResponse {
        try await send(path: "/v1/cloud/digest", method: "GET", token: token,
                       query: [URLQueryItem(name: "locale", value: Locale.current.identifier(.bcp47)), URLQueryItem(name: "timezone", value: TimeZone.current.identifier)],
                       fallback: "Could not load the digest.")
    }
    func refreshDigest(token: String) async throws {
        try await sendWithoutResponse(path: "/v1/cloud/digest/refresh", method: "POST", token: token, query: [URLQueryItem(name: "locale", value: Locale.current.identifier(.bcp47)), URLQueryItem(name: "timezone", value: TimeZone.current.identifier)], fallback: "Could not refresh the digest.")
    }
    func digestCalendar(token: String) async throws -> DigestCalendarResponse {
        try await send(path: "/v1/cloud/calendar/events", method: "GET", token: token, fallback: "Could not load the calendar.")
    }
    func saveDigestEvent(token: String, event: DigestCalendarEvent) async throws -> DigestCalendarEvent {
        let id = event.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? event.id
        return try await send(path: "/v1/cloud/calendar/events/\(id)", method: "PUT", token: token, body: try event.normalizedForSave(), fallback: "Could not save the event.")
    }
    func removeDigestEvent(token: String, event: DigestCalendarEvent) async throws {
        let id = event.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? event.id
        try await sendWithoutResponse(path: "/v1/cloud/calendar/events/\(id)", method: "DELETE", token: token, query: [URLQueryItem(name: "revision", value: String(event.revision))], fallback: "Could not remove the event.")
    }
    func dismissDigestItem(token: String, id: String, dismissed: Bool) async throws {
        let id = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        try await sendWithoutResponse(path: "/v1/cloud/digest/items/\(id)/feedback", method: "PUT", token: token, body: DigestDismissInput(dismissed: dismissed), fallback: "Could not update this suggestion.")
    }
    func createDigestTask(token: String, id: String, input: DigestTaskInput) async throws -> DigestTaskResult {
        let id = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await send(path: "/v1/cloud/digest/items/\(id)/task", method: "POST", token: token, body: input, fallback: "Could not create the task.")
    }

}
