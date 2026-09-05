import SwiftUI
import UniformTypeIdentifiers

struct DigestImportView: View {
    let existing: [DigestCalendarEvent]
    let save: ([DigestCalendarEvent]) async throws -> Void
    @State private var text = ""
    @State private var link = ""
    @State private var from = Date()
    @State private var to = Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()
    @State private var result: DigestImportResult?
    @State private var selected = Set<String>()
    @State private var filePicker = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            if let result {
                Section("Review import") {
                    ForEach(result.events) { event in
                        let duplicate = existing.contains { $0.id == event.id || $0.externalUid == event.externalUid }
                        Toggle(isOn: Binding(get: { selected.contains(event.id) }, set: { if $0 { selected.insert(event.id) } else { selected.remove(event.id) } })) {
                            VStack(alignment: .leading) { Text(event.title); Text(event.allDay ? String(event.startAt.prefix(10)) + " · All day" : DigestDate.parse(event.startAt)?.formatted() ?? event.startAt).font(.caption).foregroundStyle(.secondary); if duplicate { Text("Already imported").font(.caption) } }
                        }.disabled(duplicate)
                    }
                }
                if !result.warnings.isEmpty { Section("Import notes") { ForEach(result.warnings, id: \.self) { Text($0).font(.subheadline) } } }
                Section { Text("Source alarms are not activated automatically. Set reminders after reviewing an event.").font(.caption).foregroundStyle(.secondary) }
                Button("Import selected events") { Task { busy = true; defer { busy = false }; do { try await save(result.events.filter { selected.contains($0.id) }) } catch { self.error = error.localizedDescription } } }.disabled(busy || selected.isEmpty)
                Button("Back") { self.result = nil }
            } else {
                Section("Calendar text") {
                    TextEditor(text: $text).frame(minHeight: 160).font(.system(.caption, design: .monospaced)).accessibilityLabel("ICS calendar text")
                    PasteButton(payloadType: String.self) { text = $0.joined(separator: "\n") }
                    Button("Choose .ics file") { filePicker = true }
                }
                Section("Calendar link") {
                    TextField("HTTPS or webcal link", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Load calendar text") { Task { busy = true; defer { busy = false }; do { text = try await DigestICSImporter.fetchLink(link); link = "" } catch { self.error = error.localizedDescription } } }.disabled(link.isEmpty || busy)
                    Text("One-time import. The link is not stored.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Import range") { DatePicker("From", selection: $from, displayedComponents: .date); DatePicker("Before", selection: $to, displayedComponents: .date) }
                Section { Text("One-time import, up to one year. Floating times use this device's timezone. No invitations are sent.").font(.caption).foregroundStyle(.secondary) }
                Button(busy ? "Reading calendar…" : "Preview events") { Task { await parse() } }.disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }.navigationTitle(result == nil ? "Import ICS" : "Review import").navigationBarTitleDisplayMode(.inline)
            .fileImporter(isPresented: $filePicker, allowedContentTypes: [UTType(filenameExtension: "ics") ?? .plainText]) { result in
                do {
                    let url = try result.get(), granted = url.startAccessingSecurityScopedResource()
                    defer { if granted { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 1_000_000 else { throw DigestCalendarError(message: "Choose a file smaller than 1 MB.") }
                    text = try String(contentsOf: url, encoding: .utf8)
                } catch { self.error = error.localizedDescription }
            }
    }
    private func parse() async {
        busy = true; error = nil; defer { busy = false }
        let text = text, start = DigestDate.key(from), end = DigestDate.key(to)
        do {
            let parsed = try await Task.detached(priority: .userInitiated) { try DigestICSImporter.parse(text, from: start, to: end) }.value
            result = parsed
            selected = Set(parsed.events.filter { event in !existing.contains(where: { $0.id == event.id || $0.externalUid == event.externalUid }) }.map(\.id))
        } catch { self.error = error.localizedDescription }
    }
}

struct DigestConnectView: View {
    let existing: [DigestCalendarEvent]
    let save: ([DigestCalendarEvent]) async throws -> Void
    @State private var calendars: [DigestDeviceCalendar] = []
    @State private var selected = Set<String>()
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            Section {
                Text("Choose calendars already connected to this iPhone, including iCloud and Google. Calendar access is separate from notification permission.")
                if calendars.isEmpty { Button("Allow calendar access") { Task { busy = true; defer { busy = false }; do { calendars = try await DigestCalendarService.calendars() } catch { self.error = error.localizedDescription } } }.disabled(busy) }
                ForEach(calendars) { calendar in
                    Toggle(calendar.title, isOn: Binding(get: { selected.contains(calendar.id) }, set: { if $0 { selected.insert(calendar.id) } else { selected.remove(calendar.id) } }))
                }
            } footer: { Text("Selected titles, dates and notes become part of your private Kordi calendar and digest context. No invitations or provider changes are made.") }
            if !calendars.isEmpty { Button("Import selected calendars") { Task { busy = true; defer { busy = false }; do { let now = Date(); let events = try DigestCalendarService.events(in: selected, from: now, to: Calendar.current.date(byAdding: .year, value: 1, to: now) ?? now); try await save(events.filter { event in !existing.contains(where: { $0.externalUid == event.externalUid }) }) } catch { self.error = error.localizedDescription } } }.disabled(selected.isEmpty || busy) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }.navigationTitle("Connect calendars").navigationBarTitleDisplayMode(.inline)
    }
}
