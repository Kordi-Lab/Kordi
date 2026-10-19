import EventKit
import SwiftUI
import UIKit

#if DEBUG
/// One on-device data source the tester can opt into for their card.
/// Modeled on PermissionsKit's API (status, request, open Settings) but kept
/// in-house: two EventKit calls do not justify a dependency.
enum CommonGroundDeviceSource: String, CaseIterable, Identifiable {
    case calendar
    case reminders

    var id: String { rawValue }

    var title: String {
        switch self {
        case .calendar: "Calendar"
        case .reminders: "Reminders"
        }
    }

    /// What is read, shown before iOS asks.
    var reads: String {
        switch self {
        case .calendar: "Event titles from the last 6 months"
        case .reminders: "Reminder titles"
        }
    }

    var symbol: String {
        switch self {
        case .calendar: "calendar"
        case .reminders: "checklist"
        }
    }

    var color: Color {
        switch self {
        case .calendar: KordiTheme.brandPink
        case .reminders: KordiTheme.brandAmber
        }
    }

    var entity: EKEntityType {
        switch self {
        case .calendar: .event
        case .reminders: .reminder
        }
    }
}

enum CommonGroundAccessStatus: Equatable {
    case notDetermined
    case authorized
    case denied
}

@MainActor
final class CommonGroundDeviceAccess: ObservableObject {
    @Published private(set) var status: [CommonGroundDeviceSource: CommonGroundAccessStatus] = [:]
    /// Titles and dates read so far, per source. No attendees, places, or notes.
    @Published private(set) var items: [CommonGroundDeviceSource: [CommonGroundDeviceItem]] = [:]

    private let store = EKEventStore()
    private static let maxTitles = 300

    init() {
        refresh()
    }

    func refresh() {
        for source in CommonGroundDeviceSource.allCases {
            status[source] = Self.status(for: source.entity)
        }
    }

    /// Asks iOS for access when undecided, then reads titles if allowed.
    func request(_ source: CommonGroundDeviceSource) async {
        do {
            switch source {
            case .calendar: _ = try await store.requestFullAccessToEvents()
            case .reminders: _ = try await store.requestFullAccessToReminders()
            }
        } catch {
            // A failed request leaves the status as iOS reports it.
        }
        refresh()
        if status[source] == .authorized {
            await read(source)
        }
    }

    func read(_ source: CommonGroundDeviceSource) async {
        guard status[source] == .authorized else { return }
        let found: [(title: String, date: Date?)]
        switch source {
        case .calendar: found = readEvents()
        case .reminders: found = await readReminders()
        }
        items[source] = Self.clean(found)
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func readEvents() -> [(title: String, date: Date?)] {
        let calendar = Calendar.current
        let now = Date()
        guard let start = calendar.date(byAdding: .month, value: -6, to: now),
              let end = calendar.date(byAdding: .month, value: 2, to: now) else { return [] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate)
            .filter { !$0.isAllDay || $0.calendar.type != .birthday }
            .compactMap { event in event.title.map { ($0, event.startDate) } }
    }

    private func readReminders() async -> [(title: String, date: Date?)] {
        let predicate = store.predicateForReminders(in: nil)
        let store = self.store
        return await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                let found = (reminders ?? []).compactMap { reminder -> (title: String, date: Date?)? in
                    guard let title = reminder.title else { return nil }
                    let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
                    return (title, due ?? reminder.completionDate ?? reminder.creationDate)
                }
                continuation.resume(returning: found)
            }
        }
    }

    /// Deduplicates case-insensitively, keeping the latest date so a weekly
    /// meeting counts once, and drops titles that say nothing about work.
    private static func clean(_ found: [(title: String, date: Date?)]) -> [CommonGroundDeviceItem] {
        var order: [String] = []
        var display: [String: String] = [:]
        var latest: [String: Date] = [:]
        for (raw, date) in found {
            let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = title.lowercased()
            guard title.count >= 4 else { continue }
            if display[key] == nil {
                guard order.count < maxTitles else { continue }
                order.append(key)
                display[key] = title
            }
            if let date, latest[key].map({ date > $0 }) ?? true { latest[key] = date }
        }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return order.map { key in
            CommonGroundDeviceItem(title: display[key] ?? key, date: latest[key].map(formatter.string(from:)))
        }
    }

    private static func status(for entity: EKEntityType) -> CommonGroundAccessStatus {
        switch EKEventStore.authorizationStatus(for: entity) {
        case .fullAccess: .authorized
        case .notDetermined: .notDetermined
        default: .denied
        }
    }
}
#endif
