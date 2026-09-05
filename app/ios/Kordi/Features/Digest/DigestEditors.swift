import SwiftUI

struct DigestTaskEditor: View {
    let item: RollingDigestItem
    let sources: [RollingDigestSource]
    let accountId: String
    let contacts: [CloudContact]
    let save: (DigestTaskInput) async throws -> Void
    @State private var title: String
    @State private var owner: String
    @State private var hasDue: Bool
    @State private var due: Date
    @State private var error: String?
    @State private var busy = false
    init(item: RollingDigestItem, sources: [RollingDigestSource], accountId: String, contacts: [CloudContact], save: @escaping (DigestTaskInput) async throws -> Void) {
        self.item = item; self.sources = sources; self.accountId = accountId; self.contacts = contacts; self.save = save
        _title = State(initialValue: item.title); _owner = State(initialValue: item.ownerAccountId ?? "")
        _hasDue = State(initialValue: DigestDate.parse(item.dueAt) != nil); _due = State(initialValue: DigestDate.parse(item.dueAt) ?? Date())
    }
    var body: some View {
        Form {
            Section("Related people") { DigestPeopleView(sourceIds: item.sourceIds, ownerAccountId: item.ownerAccountId, sources: sources, accountId: accountId, contacts: contacts) }
            DigestSourceMessages(sourceIds: item.sourceIds, sources: sources)
            Section {
                TextField("Task title", text: $title)
                Picker("Owner", selection: $owner) {
                    Text("Unassigned").tag("")
                    Text("You").tag(accountId)
                    ForEach(Dictionary(grouping: sources.filter { $0.isAgent != true && item.sourceIds.contains($0.id) }, by: \.senderAccountId).values.compactMap(\.first).filter { $0.senderAccountId != accountId }.sorted { $0.senderName < $1.senderName }) { source in Text(source.senderAccountId == accountId ? "You" : source.senderName).tag(source.senderAccountId) }
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
    let sources: [RollingDigestSource]
    let accountId: String
    let contacts: [CloudContact]
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
    init(event: DigestCalendarEvent, sources: [RollingDigestSource], accountId: String, contacts: [CloudContact], save: @escaping (DigestCalendarEvent) async throws -> Void, remove: @escaping () async throws -> Void) {
        self.event = event; self.sources = sources; self.accountId = accountId; self.contacts = contacts; self.save = save; self.remove = remove
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
            Section {
                TextField("Event title", text: $title)
                if !hasStart { Toggle("Choose a date and time", isOn: $hasStart) }
                if hasStart { DatePicker(event.allDay ? "Start date" : "Starts", selection: $start, displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute]) }
                Toggle("Set an end", isOn: $hasEnd)
                if hasEnd { DatePicker(event.allDay ? "End date (exclusive)" : "Ends", selection: $end, displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute]) }
                if !event.allDay { Picker("Remind me", selection: $reminder) { Text("No reminder").tag(-1); Text("At start").tag(0); Text("5 minutes before").tag(5); Text("10 minutes before").tag(10); Text("15 minutes before").tag(15); Text("1 hour before").tag(60) } }
            } footer: { Text("\(TimeZone.current.identifier) · Personal calendar. No invitations are sent.") }
            if !event.sourceIds.isEmpty {
                Section("Related people") { DigestPeopleView(sourceIds: event.sourceIds, ownerAccountId: nil, sources: sources, accountId: accountId, contacts: contacts) }
                DigestSourceMessages(sourceIds: event.sourceIds, sources: sources)
            }
            if !event.description.isEmpty { Section("Context") { Text(event.description).textSelection(.enabled) } }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Button(event.revision == 0 ? "Add to calendar" : "Save event") { Task { await submit() } }.disabled(busy || !hasStart || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if event.revision > 0 { Button("Remove event", role: .destructive) { Task { busy = true; defer { busy = false }; do { try await remove() } catch { self.error = error.localizedDescription } } }.disabled(busy) }
        }.navigationTitle(event.revision == 0 ? "Review calendar event" : "Edit event").navigationBarTitleDisplayMode(.inline)
    }
    private func submit() async {
        guard hasStart else { error = "Choose the event date and time."; return }
        if hasEnd && end < start { error = "End cannot be before start."; return }
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


struct DigestPeopleView: View {
    let sourceIds: [String]
    let ownerAccountId: String?
    let sources: [RollingDigestSource]
    let accountId: String
    let contacts: [CloudContact]
    var onSource: ((RollingDigestSource) -> Void)? = nil

    var body: some View {
        let authors = Dictionary(grouping: sources.filter { sourceIds.contains($0.id) }, by: { "\($0.senderAccountId):\($0.isAgent == true ? $0.senderName : "human")" }).values.compactMap(\.first).sorted { $0.senderName < $1.senderName }
        ScrollView(.horizontal) {
            HStack(spacing: 14) {
                if let owner = ownerAccountId, !authors.contains(where: { $0.isAgent != true && $0.senderAccountId == owner }) {
                    person(id: owner, name: owner == accountId ? "You" : sources.first(where: { $0.senderAccountId == owner })?.senderName ?? "Contact", agent: false)
                }
                ForEach(authors) { source in
                    let name = source.isAgent != true && source.senderAccountId == accountId ? "You" : source.senderName
                    if let onSource {
                        Button { onSource(source) } label: { person(id: source.senderAccountId, name: name, agent: source.isAgent == true) }.buttonStyle(.plain)
                    } else {
                        person(id: source.senderAccountId, name: name, agent: source.isAgent == true)
                    }
                }
            }
        }.scrollIndicators(.hidden)
    }
    private func person(id: String, name: String, agent: Bool) -> some View {
        HStack(spacing: 8) {
            IdentityAvatar(name: name, imageSource: (agent ? nil : contacts.first(where: { $0.accountId == id })?.avatarUrl) ?? CanonicalAvatarSystem.previewURL(style: agent ? CanonicalAvatarSystem.agentStyle : CanonicalAvatarSystem.humanStyle, seed: id)?.absoluteString, kind: agent ? .agent : .person, size: 24, seed: id)
            Text("@\(name)").font(.caption).foregroundStyle(.tint)
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
                        Text(source.text).textSelection(.enabled)
                    }
                }
            }
        }
    }
}
