import Foundation

/// The status line under a contact's name: online, or when they were last seen.
enum ContactPresencePresentation {
    static func label(
        for presence: CloudPresenceAccount?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard presence?.status != .online else { return "online" }
        guard let value = presence?.lastSeenAt else {
            return "last seen recently"
        }

        let lastSeen = parseCloudDate(value)
        guard lastSeen != .distantPast else { return "last seen recently" }
        let time = formattedTime(lastSeen, calendar: calendar, locale: locale)
        if calendar.isDate(lastSeen, inSameDayAs: now) {
            let elapsed = now.timeIntervalSince(lastSeen)
            return elapsed >= -60 && elapsed < 60
                ? "last seen just now"
                : "last seen today at \(time)"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(lastSeen, inSameDayAs: yesterday) {
            return "last seen yesterday at \(time)"
        }
        return "last seen \(formattedDate(lastSeen, calendar: calendar, locale: locale)) at \(time)"
    }

    /// Contacts list variant: relative minutes and hours for the first six hours, then `label`.
    static func listLabel(
        for presence: CloudPresenceAccount,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard presence.status != .online else { return "online" }
        if let value = presence.lastSeenAt {
            let lastSeen = parseCloudDate(value)
            if lastSeen != .distantPast {
                let elapsed = now.timeIntervalSince(lastSeen)
                if elapsed < 60 { return "last seen just now" }
                if elapsed < 3600 { return "last seen \(counted(Int(elapsed / 60), "minute")) ago" }
                if elapsed < 6 * 3600 { return "last seen \(counted(Int(elapsed / 3600), "hour")) ago" }
            }
        }
        return label(for: presence, now: now, calendar: calendar, locale: locale)
    }

    private static func counted(_ count: Int, _ unit: String) -> String {
        "\(count) \(unit)\(count == 1 ? "" : "s")"
    }

    private static func formattedTime(_ date: Date, calendar: Calendar, locale: Locale) -> String {
        date.formatted(
            Date.FormatStyle(
                date: .omitted,
                time: .shortened,
                locale: locale,
                calendar: calendar,
                timeZone: calendar.timeZone
            )
        )
    }

    private static func formattedDate(_ date: Date, calendar: Calendar, locale: Locale) -> String {
        date.formatted(
            Date.FormatStyle(
                date: .omitted,
                time: .omitted,
                locale: locale,
                calendar: calendar,
                timeZone: calendar.timeZone
            )
            .month(.abbreviated)
            .day()
        )
    }
}
