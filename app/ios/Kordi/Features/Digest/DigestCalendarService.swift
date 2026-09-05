import CryptoKit
import EventKit
import Foundation
import JavaScriptCore
import UserNotifications

struct DigestDeviceCalendar: Identifiable { let id: String; let title: String }
struct DigestImportResult: Sendable { let events: [DigestCalendarEvent]; let warnings: [String] }
struct DigestCalendarError: LocalizedError { let message: String; var errorDescription: String? { message } }

@MainActor
enum DigestCalendarService {
    private static var reminderOperation: Task<Void, Never>?
    static func calendars() async throws -> [DigestDeviceCalendar] {
        let store = EKEventStore()
        guard try await store.requestFullAccessToEvents() else { throw DigestCalendarError(message: "Calendar access is off. Allow Kordi in Settings, or import an ICS file.") }
        return store.calendars(for: .event).map { DigestDeviceCalendar(id: $0.calendarIdentifier, title: $0.title) }
    }
    static func events(in ids: Set<String>, from: Date, to: Date) throws -> [DigestCalendarEvent] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw DigestCalendarError(message: "Calendar permission was revoked.") }
        let store = EKEventStore()
        let calendars = store.calendars(for: .event).filter { ids.contains($0.calendarIdentifier) }
        guard !calendars.isEmpty, calendars.count == ids.count, to > from, to.timeIntervalSince(from) <= 366 * 86400 else { throw DigestCalendarError(message: "Choose available calendars and a range of up to one year.") }
        let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars))
        guard events.count <= 1000 else { throw DigestCalendarError(message: "More than 1,000 events. Choose fewer calendars.") }
        let formatter = ISO8601DateFormatter()
        return events.map { event in
            let start = event.isAllDay ? DigestDate.key(event.startDate) + "T00:00:00Z" : formatter.string(from: event.startDate)
            let end = event.isAllDay ? DigestDate.key(event.endDate) + "T00:00:00Z" : formatter.string(from: event.endDate)
            let uid = "device:\(event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier):\(start)"
            return DigestCalendarEvent(id: "calendar-" + hash(uid), title: event.title ?? "Event", startAt: start, endAt: end, allDay: event.isAllDay, description: String((event.notes ?? "").prefix(5000)), externalUid: uid)
        }
    }
    static func syncReminders(accountId: String, events: [DigestCalendarEvent], requestPermission: Bool = false, isCurrentAccount: @escaping @MainActor () -> Bool) async throws -> Bool {
        let previous = reminderOperation
        let operation = Task { @MainActor in
            await previous?.value
            guard isCurrentAccount() else { throw CancellationError() }
            return try await applyReminders(accountId: accountId, events: events, requestPermission: requestPermission, isCurrentAccount: isCurrentAccount)
        }
        reminderOperation = Task { _ = try? await operation.value }
        return try await operation.value
    }
    private static func applyReminders(accountId: String, events: [DigestCalendarEvent], requestPermission: Bool, isCurrentAccount: @MainActor () -> Bool) async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        if requestPermission { _ = try await center.requestAuthorization(options: [.alert, .sound]) }
        let settings = await center.notificationSettings()
        let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        let pending = await center.pendingNotificationRequests()
        guard isCurrentAccount() else { throw CancellationError() }
        let prefix = "kordi-calendar:\(hash(accountId)):"
        let now = Date()
        let future = events.compactMap { event -> (DigestCalendarEvent, Date, String)? in
            guard let date = DigestDate.parse(event.reminderAt), date > now else { return nil }
            return (event, date, prefix + hash(event.id) + ":\(event.revision)")
        }.sorted { $0.1 < $1.1 }.prefix(60)
        let wanted = Set(allowed ? future.map(\.2) : [])
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.identifier.hasPrefix("kordi-calendar:") && !wanted.contains($0.identifier) }.map(\.identifier))
        guard allowed else { return false }
        let existing = Set(pending.map(\.identifier))
        for (event, date, id) in future where !existing.contains(id) {
            guard isCurrentAccount() else { throw CancellationError() }
            let content = UNMutableNotificationContent()
            content.title = "Kordi calendar"
            content.body = "You have a calendar reminder."
            content.sound = .default
            content.categoryIdentifier = "KORDI_CALENDAR"
            content.userInfo = ["calendarEventId": event.id, "accountId": accountId]
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSinceNow), repeats: false)
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
        return true
    }
    static func clearReminders() async {
        let previous = reminderOperation
        let operation = Task { @MainActor in
            await previous?.value
            let center = UNUserNotificationCenter.current()
            let pending = await center.pendingNotificationRequests()
            center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.identifier.hasPrefix("kordi-calendar:") }.map(\.identifier))
        }
        reminderOperation = operation
        await operation.value
    }
    static func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
}

enum DigestICSImporter {
    private struct ResultDTO: Decodable { let events: [EventDTO]; let warnings: [String] }
    private struct EventDTO: Decodable {
        let id: String; let title: String; let startAt: String; let endAt: String; let date: String
        let endDateExclusive: String?; let allDay: Bool; let description: String
    }
    static func parse(_ text: String, from: String, to: String, bundle: Bundle = .main) throws -> DigestImportResult {
        guard text.utf8.count <= 1_000_000, let context = JSContext() else { throw DigestCalendarError(message: "Choose an ICS file smaller than 1 MB.") }
        for name in ["ical", "import"] {
            guard let url = bundle.url(forResource: name, withExtension: "js", subdirectory: "digest") else { throw DigestCalendarError(message: "The calendar parser is unavailable. Reinstall the app.") }
            context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        }
        context.exception = nil
        guard let parser = context.objectForKeyedSubscript("DigestICS"),
              let value = parser.invokeMethod("parse", withArguments: [text, from, to]), context.exception == nil,
              let json = context.objectForKeyedSubscript("JSON")?.invokeMethod("stringify", withArguments: [value])?.toString(),
              let data = json.data(using: .utf8) else {
            throw DigestCalendarError(message: context.exception?.toString() ?? "This ICS file could not be read.")
        }
        let result = try JSONDecoder().decode(ResultDTO.self, from: data)
        let events = result.events.map { event in
            let id = "ics-" + SHA256.hash(data: Data(event.id.utf8)).map { String(format: "%02x", $0) }.joined()
            let start = event.allDay ? event.date + "T00:00:00Z" : event.startAt
            let end = event.allDay ? event.endDateExclusive.map { $0 + "T00:00:00Z" } : event.endAt == event.startAt ? nil : event.endAt
            return DigestCalendarEvent(id: id, title: event.title, startAt: start, endAt: end, allDay: event.allDay, description: event.description, externalUid: event.id)
        }
        return DigestImportResult(events: events, warnings: result.warnings)
    }
}

private final class DigestFeedDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
extension DigestICSImporter {
    static func fetchLink(_ value: String) async throws -> String {
        guard let url = URL(string: value.replacingOccurrences(of: "webcal://", with: "https://")), url.scheme == "https", url.user == nil, url.password == nil else { throw DigestCalendarError(message: "Use an HTTPS calendar link without embedded login credentials.") }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config, delegate: DigestFeedDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(from: url)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw DigestCalendarError(message: "This link is unavailable or redirects. Use the final ICS link or choose the file.") }
        var data = Data()
        for try await byte in bytes { guard data.count < 1_000_000 else { throw DigestCalendarError(message: "Choose a calendar smaller than 1 MB.") }; data.append(byte) }
        guard let text = String(data: data, encoding: .utf8) else { throw DigestCalendarError(message: "The calendar is not UTF-8 text.") }
        return text
    }
}
