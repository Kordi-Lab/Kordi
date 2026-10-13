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
