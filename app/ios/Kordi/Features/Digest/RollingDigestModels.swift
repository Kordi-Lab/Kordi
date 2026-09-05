import Foundation

struct RollingDigestSource: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let conversationId: String
    let sessionId: String
    let sessionTitle: String
    let senderAccountId: String
    let senderName: String
    let text: String
    let createdAt: String
    let version: Int
    let isAgent: Bool?
}
struct RollingDigestItem: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let text: String
    let sourceIds: [String]
    let kind: String
    let ownerAccountId: String?
    let dueAt: String?
    let existingTaskId: String?
    let startAt: String?
    let endAt: String?
}
struct RollingDigestContent: Codable, Equatable {
    let claims: [RollingDigestItem]
    let commitments: [RollingDigestItem]
    let suggestions: [RollingDigestItem]
    let calendarCandidates: [RollingDigestItem]
}
struct RollingDigestFeedback: Codable, Equatable {
    let id: String
    let status: String
    let taskId: String?
}
struct RollingDigestResponse: Codable, Equatable {
    let accountId: String
    let snapshot: RollingDigestContent?
    let sources: [RollingDigestSource]
    let partial: Bool
    let revision: Int64
    let updatedAt: String
    let status: String
    let errorCode: String?
    let feedback: [RollingDigestFeedback]
}
struct DigestCalendarEvent: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var title: String
    var startAt: String
    var endAt: String?
    var reminderAt: String?
    var allDay = false
    var sourceIds: [String] = []
    var description = ""
    var externalUid: String?
    var revision: Int64 = 0
}
struct DigestCalendarResponse: Decodable { let events: [DigestCalendarEvent]; let pushAvailable: Bool }
struct DigestTaskInput: Encodable { let title: String; let ownerAccountId: String?; let dueAt: String? }
struct DigestTaskResult: Decodable { let taskId: String }
struct DigestDismissInput: Encodable { let dismissed: Bool }

enum DigestDate {
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
    static func key(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
    static func monthDays(containing date: Date, calendar: Calendar = .current) -> [Date] {
        guard let first = calendar.dateInterval(of: .month, for: date)?.start,
              let start = calendar.date(byAdding: .day, value: -(calendar.component(.weekday, from: first) - 1), to: first) else { return [] }
        return (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }
    static func event(_ event: DigestCalendarEvent, occursOn date: Date, calendar: Calendar = .current) -> Bool {
        if event.allDay {
            let day = key(date, calendar: calendar)
            return day >= String(event.startAt.prefix(10)) && day < String((event.endAt ?? "").prefix(10))
        }
        guard let start = parse(event.startAt) else { return false }
        let end = parse(event.endAt) ?? start.addingTimeInterval(1)
        let range = calendar.dateInterval(of: .day, for: date)
        return range.map { start < $0.end && end > $0.start } ?? false
    }
}
