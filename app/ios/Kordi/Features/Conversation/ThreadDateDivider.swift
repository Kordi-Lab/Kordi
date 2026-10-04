import SwiftUI

enum ThreadDateFormatter {
    static func label(for date: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        date.formatted(Date.FormatStyle(date: .long, time: .omitted, locale: locale,
                                       calendar: calendar, timeZone: calendar.timeZone))
    }
}

struct ThreadDateDivider: View {
    let date: Date
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone
    @Environment(\.locale) private var locale

    private var label: String {
        var viewerCalendar = calendar
        viewerCalendar.timeZone = timeZone
        return ThreadDateFormatter.label(for: date, calendar: viewerCalendar, locale: locale)
    }

    var body: some View {
        HStack(spacing: 12) {
            line
            Text(label).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
            line
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("thread-date-divider")
    }

    private var line: some View {
        Rectangle().fill(.secondary.opacity(0.2)).frame(height: 1).accessibilityHidden(true)
    }
}
