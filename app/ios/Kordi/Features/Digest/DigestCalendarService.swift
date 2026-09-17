import CryptoKit
import EventKit
import Foundation
import JavaScriptCore
import UserNotifications

struct DigestDeviceCalendar: Identifiable, Equatable, Sendable { let id: String; let title: String; var allowsModifications = true }
struct DigestImportResult: Sendable { let events: [DigestCalendarEvent]; let warnings: [String] }
struct DigestCalendarError: LocalizedError { let message: String; var errorDescription: String? { message } }

func shouldAutomaticallyRequestCalendarAuthorization(
    accountAvailable: Bool,
    status: EKAuthorizationStatus
) -> Bool {
    accountAvailable && status == .notDetermined
}

@MainActor
enum DigestCalendarService {
    private static var reminderOperation: Task<Void, Never>?

    static func requestAccessIfNeeded(accountAvailable: Bool) async {
        let status = EKEventStore.authorizationStatus(for: .event)
        guard shouldAutomaticallyRequestCalendarAuthorization(
            accountAvailable: accountAvailable,
            status: status
        ) else { return }

        _ = try? await EKEventStore().requestFullAccessToEvents()
    }

    static func accessStatus(request: Bool) async -> EKAuthorizationStatus {
        let status = EKEventStore.authorizationStatus(for: .event)
        guard request, status == .notDetermined else { return status }
        _ = try? await EKEventStore().requestFullAccessToEvents()
        return EKEventStore.authorizationStatus(for: .event)
    }
    /// Stable identity for a device event. Occurrences of a repeating event share the item
    /// identifier, so the original occurrence date tells them apart and survives a reschedule.
    static func externalUid(_ event: EKEvent) -> String {
        let base = event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier
        if event.hasRecurrenceRules || event.isDetached, let occurrence = event.occurrenceDate {
            return "device:\(base):occurrence:\(Int(occurrence.timeIntervalSince1970))"
        }
        return "device:\(base)"
    }
    static func deviceEvent(_ event: EKEvent, calendar: Calendar = .current) -> DigestDeviceEvent {
        let formatter = ISO8601DateFormatter()
        let startDate: Date = event.startDate ?? Date()
        let endDate: Date = event.endDate ?? startDate
        let start: String, end: String
        if event.isAllDay {
            // The device store ends an all-day event late on its last day; Kordi stores the exclusive next date.
            var lastExclusive = endDate
            if calendar.startOfDay(for: endDate) != endDate { lastExclusive = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: endDate)) ?? endDate }
            if lastExclusive <= startDate { lastExclusive = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: startDate)) ?? startDate }
            start = DigestDate.key(startDate, calendar: calendar) + "T00:00:00Z"
            end = DigestDate.key(lastExclusive, calendar: calendar) + "T00:00:00Z"
        } else {
            start = formatter.string(from: startDate)
            end = formatter.string(from: endDate)
        }
        let uid = externalUid(event)
        let title = (event.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let mapped = DigestCalendarEvent(id: "calendar-" + hash(uid), title: title.isEmpty ? "Event" : title, startAt: start, endAt: end, allDay: event.isAllDay, description: String((event.notes ?? "").prefix(5000)), externalUid: uid)
        return DigestDeviceEvent(event: mapped, deviceId: event.eventIdentifier ?? "", calendarId: event.calendar?.calendarIdentifier ?? "", modifiedAt: event.lastModifiedDate)
    }
    /// Every calendar on the device with the events inside the sync window. Exclusions are applied by the planner.
    static func readDevice(from: Date, to: Date) throws -> (calendars: [DigestDeviceCalendar], events: [DigestDeviceEvent]) {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw DigestCalendarPermissionError(status: EKEventStore.authorizationStatus(for: .event)) }
        let store = EKEventStore()
        let calendars = Array(store.calendars(for: .event).prefix(DigestCalendarSyncEngine.maximumCalendars))
        guard !calendars.isEmpty else { return ([], []) }
        let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars)).map { deviceEvent($0) }.filter { !$0.deviceId.isEmpty }
        return (calendars.map { DigestDeviceCalendar(id: $0.calendarIdentifier, title: $0.title, allowsModifications: $0.allowsContentModifications) }, events)
    }
    /// The occurrence timestamp encoded in a device identity, when the event repeats.
    nonisolated static func occurrenceTimestamp(_ uid: String?) -> Int? {
        guard let uid, let marker = uid.range(of: ":occurrence:", options: .backwards) else { return nil }
        return Int(uid[marker.upperBound...])
    }
    /// Finds exactly the event a device identity names. `event(withIdentifier:)` returns the FIRST
    /// occurrence of a repeating event, so an occurrence is searched for by its original date,
    /// near both that date and where the device copy currently starts (it may have been moved).
    static func resolve(in store: EKEventStore, deviceId: String, externalUid: String?, currentStart: String?) -> EKEvent? {
        guard let timestamp = occurrenceTimestamp(externalUid) else { return store.event(withIdentifier: deviceId) }
        var anchors = [Date(timeIntervalSince1970: TimeInterval(timestamp))]
        if let start = DigestDate.parse(currentStart), abs(start.timeIntervalSince(anchors[0])) > 86_400 { anchors.append(start) }
        for anchor in anchors {
            let predicate = store.predicateForEvents(withStart: anchor.addingTimeInterval(-2 * 86_400), end: anchor.addingTimeInterval(2 * 86_400), calendars: nil)
            if let match = store.events(matching: predicate).first(where: { $0.eventIdentifier == deviceId && $0.occurrenceDate.map { Int($0.timeIntervalSince1970) } == timestamp }) { return match }
        }
        return nil
    }
    static func write(_ event: DigestCalendarEvent, deviceId: String?, calendarId: String?, deviceStartAt: String? = nil, calendar: Calendar = .current) throws -> (deviceId: String, externalUid: String) {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw DigestCalendarPermissionError(status: EKEventStore.authorizationStatus(for: .event)) }
        guard let start = DigestDate.parse(event.startAt) else { throw DigestCalendarError(message: "Invalid start date.") }
        let end = DigestDate.parse(event.endAt)
        let store = EKEventStore()
        let target: EKEvent
        if let deviceId {
            guard let existing = resolve(in: store, deviceId: deviceId, externalUid: event.externalUid, currentStart: deviceStartAt) else { throw DigestCalendarError(message: "The device calendar event is no longer available.") }
            guard existing.calendar?.allowsContentModifications ?? true else { throw DigestCalendarError(message: "This device calendar is read-only.") }
            target = existing
        } else {
            target = EKEvent(eventStore: store)
            let chosen = calendarId.flatMap { id in store.calendars(for: .event).first { $0.calendarIdentifier == id && $0.allowsContentModifications } }
            guard let destination = chosen ?? store.defaultCalendarForNewEvents, destination.allowsContentModifications else { throw DigestCalendarError(message: "No writable calendar is available on this iPhone.") }
            target.calendar = destination
        }
        target.title = event.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = event.description.trimmingCharacters(in: .whitespacesAndNewlines)
        target.notes = notes.isEmpty ? nil : notes
        target.isAllDay = event.allDay
        if event.allDay {
            let first = calendar.startOfDay(for: start)
            let lastExclusive = end.map { calendar.startOfDay(for: $0) }.flatMap { $0 > first ? $0 : nil } ?? calendar.date(byAdding: .day, value: 1, to: first) ?? first
            target.startDate = first
            // The device store expects the last day itself, not the exclusive boundary.
            target.endDate = lastExclusive.addingTimeInterval(-1)
        } else {
            target.startDate = start
            target.endDate = end.flatMap { $0 > start ? $0 : nil } ?? start.addingTimeInterval(30 * 60)
        }
        try store.save(target, span: .thisEvent, commit: true)
        guard let identifier = target.eventIdentifier else { throw DigestCalendarError(message: "The saved event has no identifier.") }
        return (identifier, externalUid(target))
    }
    /// Removes exactly one device event, or one occurrence of a repeating event.
    static func delete(deviceId: String, externalUid: String?, startAt: String?) throws {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw DigestCalendarPermissionError(status: EKEventStore.authorizationStatus(for: .event)) }
        let store = EKEventStore()
        guard let event = resolve(in: store, deviceId: deviceId, externalUid: externalUid, currentStart: startAt) else { return }
        try store.remove(event, span: .thisEvent, commit: true)
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

struct DigestCalendarImportReport {
    var imported = 0
    var duplicates = 0
    var skipped: [String] = []
}
@MainActor
func importDigestCalendarEvents(_ incoming: [DigestCalendarEvent], existing: [DigestCalendarEvent], save: (DigestCalendarEvent) async throws -> Void) async throws -> DigestCalendarImportReport {
    var report = DigestCalendarImportReport()
    var ids = Set(existing.map(\.id)), externalIds = Set(existing.compactMap(\.externalUid))
    for event in incoming {
        if ids.contains(event.id) || event.externalUid.map({ externalIds.contains($0) }) == true { report.duplicates += 1; continue }
        let normalized: DigestCalendarEvent
        do { normalized = try event.normalizedForSave() }
        catch { report.skipped.append("\(event.title): \(error.localizedDescription)"); continue }
        do { try await save(normalized) }
        catch is CancellationError { throw CancellationError() }
        catch { throw DigestCalendarError(message: "Imported \(report.imported) events before stopping at \(event.title). \(error.localizedDescription) Retry to continue; saved events will not be duplicated.") }
        report.imported += 1; ids.insert(event.id)
        if let externalUid = event.externalUid { externalIds.insert(externalUid) }
    }
    return report
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
