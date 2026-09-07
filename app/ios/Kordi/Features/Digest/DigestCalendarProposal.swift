import SwiftUI

struct DigestRepeatEditor: View {
    @Binding var rule: DigestRecurrence?
    let timezone: String
    var body: some View {
        Section("Repeat") {
            Picker("Frequency", selection: Binding(get: { rule?.frequency ?? "" }, set: { value in
                rule = value.isEmpty ? nil : DigestRecurrence(frequency: value, timezone: timezone, count: value == "yearly" ? 5 : 12)
            })) {
                Text("Does not repeat").tag("")
                Text("Daily").tag("daily"); Text("Weekly").tag("weekly")
                Text("Monthly").tag("monthly"); Text("Yearly").tag("yearly")
            }
            if let value = rule {
                Stepper("Every \(value.interval)", value: Binding(get: { rule?.interval ?? 1 }, set: { rule?.interval = $0 }), in: 1...99)
                TextField("Meeting timezone", text: Binding(get: { rule?.timezone ?? timezone }, set: { rule?.timezone = $0 })).textInputAutocapitalization(.never).autocorrectionDisabled()
                if value.frequency == "weekly" {
                    ForEach(Array(zip(1...7, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])), id: \.0) { day, name in
                        Toggle(name, isOn: Binding(get: { rule?.weekdays.contains(day) == true }, set: { enabled in
                            if enabled { rule?.weekdays.append(day) } else { rule?.weekdays.removeAll { $0 == day } }
                        }))
                    }
                }
                Picker("Ends", selection: Binding(get: { rule?.until != nil }, set: { byDate in
                    rule?.until = byDate ? "" : nil; rule?.count = byDate ? nil : 12
                })) { Text("After occurrences").tag(false); Text("On a date").tag(true) }
                if value.until != nil {
                    TextField("Last date (YYYY-MM-DD, inclusive)", text: Binding(get: { rule?.until ?? "" }, set: { rule?.until = $0 })).textInputAutocapitalization(.never).autocorrectionDisabled()
                } else {
                    Stepper("\(value.count ?? 12) occurrences", value: Binding(get: { rule?.count ?? 12 }, set: { rule?.count = $0 }), in: 1...250)
                }
            }
        }
    }
}

@Observable
@MainActor
final class DigestSeriesPreview {
    private(set) var accountId: String?
    private(set) var request: DigestCalendarEvent?
    private(set) var events: [DigestCalendarEvent] = []
    private(set) var error: String?

    func isReady(for event: DigestCalendarEvent?, accountId: String) -> Bool {
        self.accountId == accountId && event != nil && request == event && !events.isEmpty && error == nil
    }

    func update(_ event: DigestCalendarEvent?, accountId: String, fetch: (DigestCalendarEvent) async throws -> [DigestCalendarEvent]) async {
        guard !Task.isCancelled else { return }
        self.accountId = accountId; request = event; events = []; error = nil
        guard let event else { return }
        do {
            try await Task.sleep(for: .milliseconds(200))
            let dates = try await fetch(event)
            try Task.checkCancellation()
            guard request == event, self.accountId == accountId else { return }
            guard !dates.isEmpty else { throw DigestCalendarError(message: "No dates match this rule.") }
            events = dates
        } catch {
            guard !Task.isCancelled, request == event, self.accountId == accountId else { return }
            self.error = error.localizedDescription
        }
    }
}

extension RollingDigestItem {
    func calendarProposalAvailable(events: [DigestCalendarEvent]) -> Bool {
        calendarAction != "delete" || events.contains(where: calendarCancellationTargets)
    }
    func calendarCancellationTargets(_ event: DigestCalendarEvent) -> Bool {
        calendarAction == "delete" && event.revision > 0 && (calendarScope == "series" ? existingSeriesId != nil && event.seriesId == existingSeriesId : event.id == existingEventId)
    }
    func calendarReviewLabel(events: [DigestCalendarEvent]) -> String {
        if calendarAction == "delete" { return "Review cancellation" }
        if calendarAction == "update" { return "Review change" }
        return events.contains { $0.id == "digest-\(id)" || $0.seriesId == "digest-\(id)" } ? "View event" : "Review & add"
    }

    func calendarReviewEvent(events: [DigestCalendarEvent], sources: [RollingDigestSource], timezone: String?) throws -> DigestCalendarEvent {
        if calendarAction == "delete" && calendarScope == "series" {
            guard let first = calendarReviewSeries(events: events)?.first else { throw DigestCalendarError(message: "This series changed. Refresh before reviewing its cancellation.") }
            return first
        }
        if calendarAction == "update" || calendarAction == "delete" {
            guard var saved = events.first(where: { $0.id == existingEventId }), saved.revision == existingEventRevision else {
                throw DigestCalendarError(message: "This event changed. Refresh and review the latest suggestion.")
            }
            if calendarAction == "delete" { return saved }
            let nextStart = startAt ?? saved.startAt
            guard let oldDate = DigestDate.parse(saved.startAt), let newDate = DigestDate.parse(nextStart) else {
                throw DigestCalendarError(message: "Review the event date and time.")
            }
            let delta = newDate.timeIntervalSince(oldDate)
            let formatter = ISO8601DateFormatter()
            saved.title = title; saved.startAt = nextStart
            saved.endAt = endAt ?? DigestDate.parse(saved.endAt).map { formatter.string(from: $0.addingTimeInterval(delta)) }
            saved.reminderAt = DigestDate.parse(saved.reminderAt).map { formatter.string(from: $0.addingTimeInterval(delta)) }
            saved.timezone = self.timezone ?? saved.timezone
            for id in sourceIds where !saved.sourceIds.contains(id) { saved.sourceIds.append(id) }
            saved.sourceIds = Array(saved.sourceIds.suffix(20))
            return saved
        }
        return events.first { $0.id == "digest-\(id)" || $0.seriesId == "digest-\(id)" } ?? DigestCalendarEvent(
            id: "digest-\(id)", title: title, startAt: startAt ?? "", endAt: endAt,
            sourceIds: sourceIds, description: text,
            links: DigestRelatedLinks.sourceURLs(sourceIds, sources: sources).map(\.absoluteString),
            timezone: recurrence?.timezone ?? self.timezone ?? timezone, recurrence: recurrence)
    }

    func calendarReviewSeries(events: [DigestCalendarEvent]) -> [DigestCalendarEvent]? {
        guard calendarAction == "delete", calendarScope == "series", let existingSeriesId else { return nil }
        return events.filter { $0.seriesId == existingSeriesId }.sorted { $0.startAt < $1.startAt }
    }
}

struct DigestRelatedLinks: View {
    let urls: [URL]
    static func sourceURLs(_ ids: [String], sources: [RollingDigestSource]) -> [URL] {
        var urls: [URL] = []
        for source in sources where ids.contains(source.id) {
            for url in KordiMarkdownParser.externalURLs(in: source.text) where !urls.contains(url) { urls.append(url) }
        }
        return Array(urls.prefix(10))
    }
    static func eventURLs(_ event: DigestCalendarEvent, sources: [RollingDigestSource]) -> [URL] {
        if let links = event.links { return Array(links.compactMap(KordiMarkdownParser.safeExternalURL).prefix(10)) }
        return event.sourceIds.isEmpty ? KordiMarkdownParser.externalURLs(in: event.description) : sourceURLs(event.sourceIds, sources: sources)
    }
    var body: some View {
        ForEach(urls, id: \.absoluteString) { url in
            let host = url.host?.lowercased() ?? ""
            Link(destination: url) {
                HStack {
                    Image(systemName: "link")
                    Text(host + (url.path == "/" ? "" : url.path)).lineLimit(2)
                    Spacer(minLength: 4)
                    Text(host == "zoom.us" || host.hasSuffix(".zoom.us") ? "Open Zoom" : "Open link").fixedSize()
                }.font(.footnote).padding(.vertical, 8)
            }
        }
    }
}
