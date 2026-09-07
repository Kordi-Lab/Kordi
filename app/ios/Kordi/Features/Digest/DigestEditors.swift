import SwiftUI

struct DigestEventEditor: View {
    @EnvironmentObject private var model: AppModel
    let event: DigestCalendarEvent
    let sources: [RollingDigestSource]
    let accountId: String
    let contacts: [CloudContact]
    let save: (DigestCalendarEvent) async throws -> Void
    let remove: () async throws -> Void
    let proposal: RollingDigestItem?
    let original: DigestCalendarEvent?
    @State private var title: String
    @State private var hasStart: Bool
    @State private var start: Date
    @State private var hasEnd: Bool
    @State private var end: Date
    @State private var reminder: Int
    @State private var error: String?
    @State private var busy = false
    @State private var recurrence: DigestRecurrence?
    @State private var previewedEvent: DigestCalendarEvent?
    @State private var previewEvents: [DigestCalendarEvent] = []
    init(event: DigestCalendarEvent, sources: [RollingDigestSource], accountId: String, contacts: [CloudContact], proposal: RollingDigestItem? = nil, original: DigestCalendarEvent? = nil, save: @escaping (DigestCalendarEvent) async throws -> Void, remove: @escaping () async throws -> Void) {
        self.event = event; self.sources = sources; self.accountId = accountId; self.contacts = contacts; self.save = save; self.remove = remove
        self.proposal = proposal; self.original = original
        var rule = event.recurrence
        let defaultCount = rule?.frequency == "yearly" ? 5 : 12
        if rule != nil && rule?.count == nil && rule?.until == nil { rule?.count = defaultCount }
        _recurrence = State(initialValue: rule)
        let start = Self.date(event.startAt, allDay: event.allDay), end = Self.date(event.endAt, allDay: event.allDay)
        _title = State(initialValue: event.title); _hasStart = State(initialValue: start != nil); _start = State(initialValue: start ?? Date())
        _hasEnd = State(initialValue: end != nil); _end = State(initialValue: end ?? (start ?? Date()).addingTimeInterval(1800))
        _reminder = State(initialValue: start.flatMap { start in DigestDate.parse(event.reminderAt).map { max(0, Int(start.timeIntervalSince($0) / 60)) } } ?? (event.revision == 0 && !event.allDay ? 10 : -1))
    }
    private static func date(_ value: String?, allDay: Bool) -> Date? {
        guard let value else { return nil }
        if !allDay { return DigestDate.parse(value) }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: String(value.prefix(10)))
    }
    var body: some View {
        Form {
            if proposal?.calendarAction == "delete" {
                Section("Review cancellation") {
                    Text(event.title).font(.headline)
                    Text(event.allDay ? String(event.startAt.prefix(10)) : DigestDate.parse(event.startAt)?.formatted(date: .abbreviated, time: .shortened) ?? event.startAt)
                    Text(proposal?.text ?? "")
                    Text("Only this event will be removed from your personal Kordi calendar. Source calendars and invitations stay unchanged.")
                    Button("Confirm removal", role: .destructive) { Task { await removeReviewedEvent() } }.disabled(busy)
                }
            } else {
            if let original {
                Section("Currently scheduled") {
                    Text(original.title)
                    Text(original.allDay ? String(original.startAt.prefix(10)) : DigestDate.parse(original.startAt)?.formatted(date: .abbreviated, time: .shortened) ?? original.startAt)
                }
            }
            Section {
                TextField("Event title", text: $title)
                if !hasStart { Toggle("Choose a date and time", isOn: $hasStart) }
                if hasStart { DatePicker(event.allDay ? "Start date" : "Starts", selection: $start, displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute]) }
                Toggle("Set an end", isOn: $hasEnd)
                if hasEnd { DatePicker(event.allDay ? "End date (exclusive)" : "Ends", selection: $end, displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute]) }
                if !event.allDay { Picker("Remind me", selection: $reminder) { Text("No reminder").tag(-1); Text("At start").tag(0); Text("5 minutes before").tag(5); Text("10 minutes before").tag(10); Text("15 minutes before").tag(15); Text("1 hour before").tag(60) } }
            } footer: {
                Text("Shown in \(TimeZone.current.identifier) · Personal calendar. No invitations are sent.")
                if let timezone = event.timezone { Text("Event timezone: \(timezone)") }
            }
            }
            if event.revision == 0 && proposal?.calendarAction != "delete" {
                DigestRepeatEditor(rule: $recurrence, timezone: event.timezone ?? TimeZone.current.identifier)
                if recurrence != nil {
                    Button("Preview dates") { Task { await previewSeries() } }.disabled(busy || !hasStart)
                    if !previewEvents.isEmpty {
                        Section("\(previewEvents.count) occurrences to review") {
                            Text("Changed details require a new preview.").font(.caption).foregroundStyle(.secondary)
                            ForEach(previewEvents) { occurrence in
                                VStack(alignment: .leading) {
                                    Text(event.allDay ? String(occurrence.startAt.prefix(10)) : DigestDate.parse(occurrence.startAt)?.formatted(date: .abbreviated, time: .shortened) ?? occurrence.startAt)
                                    if !event.allDay, let zone = occurrence.timezone, zone != TimeZone.current.identifier {
                                        Text(DigestDate.label(occurrence.startAt, timezone: zone)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if event.seriesId != nil { Section { Text("Part of a repeating series. Editing or removing here affects only this occurrence.").font(.caption).foregroundStyle(.secondary) } }
            let urls = DigestRelatedLinks.eventURLs(event, sources: sources)
            if !urls.isEmpty { Section("Related links") { DigestRelatedLinks(urls: urls) } }
            if !event.sourceIds.isEmpty {
                Section("Related people") { DigestPeopleView(sourceIds: event.sourceIds, ownerAccountId: nil, sources: sources, accountId: accountId, contacts: contacts) }
                DigestSourceMessages(sourceIds: event.sourceIds, sources: sources)
            }
            if !event.description.isEmpty { Section("Context") { Text(event.description).textSelection(.enabled) } }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            if proposal?.calendarAction != "delete" {
                Button(recurrence != nil && event.revision == 0 ? "Confirm series" : proposal?.calendarAction == "update" ? "Confirm change" : event.revision == 0 ? "Add to calendar" : "Save event") { Task { await submit() } }.disabled(busy || !hasStart || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if event.revision > 0 { Button("Remove event", role: .destructive) { Task { await removeReviewedEvent() } }.disabled(busy) }
            }
        }.navigationTitle(event.revision == 0 ? "Review calendar event" : "Edit event").navigationBarTitleDisplayMode(.inline)
    }
    private func removeReviewedEvent() async {
        busy = true; defer { busy = false }
        do { try await remove() } catch { self.error = error.localizedDescription }
    }
    private func reviewedEvent() throws -> DigestCalendarEvent {
        guard hasStart else { throw DigestCalendarError(message: "Choose the event date and time.") }
        if hasEnd && end <= start { throw DigestCalendarError(message: "End must follow start.") }
        let reminderDate = reminder >= 0 && !event.allDay ? start.addingTimeInterval(-Double(reminder) * 60) : nil
        if let reminderDate, reminderDate < Date() { throw DigestCalendarError(message: "That reminder time has passed. Choose No reminder or a later date.") }
        var updated = event; updated.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let formatter = ISO8601DateFormatter()
        updated.startAt = event.allDay ? DigestDate.key(start) + "T00:00:00Z" : formatter.string(from: start)
        updated.endAt = hasEnd ? event.allDay ? DigestDate.key(end) + "T00:00:00Z" : formatter.string(from: end) : nil
        updated.reminderAt = reminderDate.map(formatter.string(from:))
        updated.recurrence = recurrence; updated.timezone = recurrence?.timezone ?? event.timezone
        updated.confirmSingleOccurrence = recurrence == nil && event.revision == 0
        return updated
    }
    private func previewSeries() async {
        busy = true; defer { busy = false }
        do {
            let updated = try reviewedEvent()
            previewEvents = try await model.previewDigestCalendarSeries(updated)
            previewedEvent = updated; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func submit() async {
        busy = true; defer { busy = false }
        do {
            let updated = try reviewedEvent()
            if recurrence != nil && event.revision == 0 && previewedEvent != updated { throw DigestCalendarError(message: "Preview the current dates before confirming the series.") }
            try await save(updated)
        } catch { self.error = error.localizedDescription }
    }
}


struct DigestPeopleView: View {
    let sourceIds: [String]
    let ownerAccountId: String?
    let sources: [RollingDigestSource]
    let accountId: String
    let contacts: [CloudContact]
    var onSource: ((RollingDigestSource) -> Void)? = nil

    var body: some View {
        let authors = Dictionary(grouping: sources.filter { sourceIds.contains($0.id) }, by: { "\($0.senderAccountId):\($0.isAgent == true ? $0.agentId ?? $0.senderName : "human")" }).values.compactMap(\.first).sorted { $0.senderName < $1.senderName }
        ScrollView(.horizontal) {
            HStack(spacing: 14) {
                if let owner = ownerAccountId, !authors.contains(where: { $0.isAgent != true && $0.senderAccountId == owner }) {
                    person(id: owner, name: owner == accountId ? "You" : sources.first(where: { $0.senderAccountId == owner })?.senderName ?? "Contact", agent: false)
                }
                ForEach(authors) { source in
                    let name = source.isAgent != true && source.senderAccountId == accountId ? "You" : source.senderName
                    let ownerName = source.isAgent == true ? (source.senderAccountId == accountId ? "You" : source.agentOwnerName ?? "Unknown owner") : nil
                    if let onSource {
                        Button { onSource(source) } label: { person(id: source.senderAccountId, name: name, agent: source.isAgent == true, agentId: source.agentId, ownerName: ownerName, avatarURL: source.agentAvatarUrl) }.buttonStyle(.plain)
                    } else {
                        person(id: source.senderAccountId, name: name, agent: source.isAgent == true, agentId: source.agentId, ownerName: ownerName, avatarURL: source.agentAvatarUrl)
                    }
                }
            }
        }.scrollIndicators(.hidden)
    }
    private func person(id: String, name: String, agent: Bool, agentId: String? = nil, ownerName: String? = nil, avatarURL: String? = nil) -> some View {
        HStack(spacing: 8) {
            IdentityAvatar(name: name, imageSource: (agent ? avatarURL : contacts.first(where: { $0.accountId == id })?.avatarUrl) ?? CanonicalAvatarSystem.previewURL(style: agent ? CanonicalAvatarSystem.agentStyle : CanonicalAvatarSystem.humanStyle, seed: agentId ?? id)?.absoluteString, kind: agent ? .agent : .person, size: 24, seed: agentId ?? id)
            VStack(alignment: .leading, spacing: 2) {
                Text("@\(name)").font(.caption).foregroundStyle(.tint)
                if let ownerName { Text("Owner · \(ownerName)").font(.caption2).foregroundStyle(.secondary) }
            }
        }
    }
}

private struct DigestSourceMessages: View {
    let sourceIds: [String]
    let sources: [RollingDigestSource]
    var body: some View {
        let related = sources.filter { sourceIds.contains($0.id) }
        if !related.isEmpty {
            Section("Source messages") {
                ForEach(related) { source in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("@\(source.senderName) · \(source.sessionTitle)").font(.caption).foregroundStyle(.secondary)
                        MarkdownMessageContent(text: source.text).textSelection(.enabled)
                    }
                }
            }
        }
    }
}
