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
                Text("The first time is shown in your device timezone. Repeats keep the meeting timezone's clock time across daylight-saving changes. Review up to 250 dates within five years.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

extension RollingDigestItem {
    func calendarReviewLabel(events: [DigestCalendarEvent]) -> String {
        if calendarAction == "delete" { return "Review cancellation" }
        if calendarAction == "update" { return "Review change" }
        return events.contains { $0.id == "digest-\(id)" || $0.seriesId == "digest-\(id)" } ? "View event" : "Review & add"
    }

    func calendarReviewEvent(events: [DigestCalendarEvent], sources: [RollingDigestSource], timezone: String?) throws -> DigestCalendarEvent {
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
