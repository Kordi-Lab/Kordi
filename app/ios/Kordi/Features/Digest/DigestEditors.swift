import SwiftUI

struct DigestTaskEditor: View {
    let item: RollingDigestItem
    let sources: [RollingDigestSource]
    let accountId: String
    let save: (DigestTaskInput) async throws -> Void
    @State private var title: String
    @State private var owner: String
    @State private var hasDue: Bool
    @State private var due: Date
    @State private var error: String?
    @State private var busy = false
    init(item: RollingDigestItem, sources: [RollingDigestSource], accountId: String, save: @escaping (DigestTaskInput) async throws -> Void) {
        self.item = item; self.sources = sources; self.accountId = accountId; self.save = save
        _title = State(initialValue: item.title); _owner = State(initialValue: item.ownerAccountId ?? "")
        _hasDue = State(initialValue: DigestDate.parse(item.dueAt) != nil); _due = State(initialValue: DigestDate.parse(item.dueAt) ?? Date())
    }
    var body: some View {
        Form {
            if let source = sources.first(where: { item.sourceIds.contains($0.id) }) { Section("Source") { Text(source.text); Text("@\(source.senderName)").font(.caption).foregroundStyle(.secondary) } }
            Section {
                TextField("Task title", text: $title)
                Picker("Owner", selection: $owner) {
                    Text("Unassigned").tag("")
                    Text("You").tag(accountId)
                    ForEach(Dictionary(grouping: sources.filter { item.sourceIds.contains($0.id) }, by: \.senderAccountId).values.compactMap(\.first).filter { $0.senderAccountId != accountId }.sorted { $0.senderName < $1.senderName }) { source in Text(source.senderAccountId == accountId ? "You" : source.senderName).tag(source.senderAccountId) }
                }
                Toggle("Set a due date", isOn: $hasDue)
                if hasDue { DatePicker("Due", selection: $due) }
            } footer: { Text("No task is created until you confirm.") }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Button("Create task") { busy = true; Task { defer { busy = false }; do { try await save(DigestTaskInput(title: title.trimmingCharacters(in: .whitespacesAndNewlines), ownerAccountId: owner.isEmpty ? nil : owner, dueAt: hasDue ? ISO8601DateFormatter().string(from: due) : nil)) } catch { self.error = error.localizedDescription } } }.disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }.navigationTitle("Review task").navigationBarTitleDisplayMode(.inline)
    }
}

struct DigestEventEditor: View {
    let event: DigestCalendarEvent
    let save: (DigestCalendarEvent) async throws -> Void
    let remove: () async throws -> Void
    @State private var title: String
    @State private var hasStart: Bool
    @State private var start: Date
    @State private var hasEnd: Bool
    @State private var end: Date
    @State private var reminder: Int
    @State private var error: String?
    @State private var busy = false
    init(event: DigestCalendarEvent, save: @escaping (DigestCalendarEvent) async throws -> Void, remove: @escaping () async throws -> Void) {
        self.event = event; self.save = save; self.remove = remove
        let start = Self.date(event.startAt, allDay: event.allDay), end = Self.date(event.endAt, allDay: event.allDay)
        _title = State(initialValue: event.title); _hasStart = State(initialValue: start != nil); _start = State(initialValue: start ?? Date())
        _hasEnd = State(initialValue: end != nil); _end = State(initialValue: end ?? (start ?? Date()).addingTimeInterval(1800))
        _reminder = State(initialValue: start.flatMap { start in DigestDate.parse(event.reminderAt).map { max(0, Int(start.timeIntervalSince($0) / 60)) } } ?? -1)
    }
    private static func date(_ value: String?, allDay: Bool) -> Date? {
        guard let value else { return nil }
        if !allDay { return DigestDate.parse(value) }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: String(value.prefix(10)))
    }
    var body: some View {
        Form {
            Section {
                TextField("Event title", text: $title)
                if !hasStart { Toggle("Choose a date and time", isOn: $hasStart) }
                if hasStart { DatePicker(event.allDay ? "Start date" : "Starts", selection: $start, displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute]) }
                Toggle("Set an end", isOn: $hasEnd)
                if hasEnd { DatePicker(event.allDay ? "End date (exclusive)" : "Ends", selection: $end, displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute]) }
                if !event.allDay { Picker("Remind me", selection: $reminder) { Text("No reminder").tag(-1); Text("At start").tag(0); Text("5 minutes before").tag(5); Text("15 minutes before").tag(15); Text("1 hour before").tag(60) } }
            } footer: { Text("\(TimeZone.current.identifier) · Personal calendar. No invitations are sent.") }
            if !event.description.isEmpty { Section("Context") { Text(event.description).textSelection(.enabled) } }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Button(event.revision == 0 ? "Add to calendar" : "Save event") { Task { await submit() } }.disabled(busy || !hasStart || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if event.revision > 0 { Button("Remove event", role: .destructive) { Task { busy = true; defer { busy = false }; do { try await remove() } catch { self.error = error.localizedDescription } } }.disabled(busy) }
        }.navigationTitle(event.revision == 0 ? "Review calendar event" : "Edit event").navigationBarTitleDisplayMode(.inline)
    }
    private func submit() async {
        guard hasStart else { error = "Choose the event date and time."; return }
        if hasEnd && end <= start { error = "End must follow start."; return }
        let reminderDate = reminder >= 0 && !event.allDay ? start.addingTimeInterval(-Double(reminder) * 60) : nil
        if let reminderDate, reminderDate < Date() { error = "That reminder time has passed. Choose No reminder or a later date."; return }
        var updated = event; updated.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let formatter = ISO8601DateFormatter()
        updated.startAt = event.allDay ? DigestDate.key(start) + "T00:00:00Z" : formatter.string(from: start)
        updated.endAt = hasEnd ? event.allDay ? DigestDate.key(end) + "T00:00:00Z" : formatter.string(from: end) : nil
        updated.reminderAt = reminderDate.map(formatter.string(from:))
        busy = true; defer { busy = false }
        do { try await save(updated) } catch { self.error = error.localizedDescription }
    }
}
