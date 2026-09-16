import EventKit
import SwiftUI

/// The quiet status line under "Your calendars". Sync needs no user action; this only reports it.
struct DigestCalendarSyncLine: View {
    @ObservedObject var sync: DigestCalendarSyncCoordinator
    let retry: () -> Void
    @State private var now = Date()
    private let clock = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    static func label(for status: DigestCalendarSyncCoordinator.Status, now: Date = Date()) -> String {
        let count = status.calendars.count
        let calendars = count == 0 ? "calendars" : "\(count) \(count == 1 ? "calendar" : "calendars")"
        switch status.phase {
        case .idle: return "Preparing calendar sync…"
        case .syncing: return "Syncing \(calendars)…"
        case .synced:
            let when = status.lastSyncedAt.map { synced -> String in
                let seconds = max(0, Int(now.timeIntervalSince(synced).rounded()))
                if seconds < 60 { return "just now" }
                if seconds < 3600 { return "\(seconds / 60) min ago" }
                return synced.formatted(date: .omitted, time: .shortened)
            } ?? "just now"
            return count == 0 ? "Synced · \(when)" : "Synced · \(calendars) · \(when)"
        case .permission: return "Calendar access is off."
        case .error: return "Calendar sync paused: \(status.error ?? "Try again.")"
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            if sync.status.phase == .synced || sync.status.phase == .syncing {
                Circle().fill(Color(red: 0.44, green: 0.57, blue: 0.51)).frame(width: 5, height: 5).accessibilityHidden(true)
            }
            Text(Self.label(for: sync.status, now: now))
            if sync.status.phase == .permission {
                if let url = URL(string: UIApplication.openSettingsURLString) { Link("Open Settings", destination: url) }
            } else if sync.status.phase == .error {
                Button("Retry", action: retry)
            }
        }
        .font(.caption)
        .foregroundStyle(sync.status.phase == .permission || sync.status.phase == .error ? Color.orange : Color.secondary)
        .onReceive(clock) { now = $0 }
        .accessibilityElement(children: .combine)
    }
}

/// Optional exclusions and the outbound target. Nothing here is required for sync to run.
struct DigestCalendarSettingsView: View {
    @ObservedObject var sync: DigestCalendarSyncCoordinator
    @State var preferences: DigestCalendarSyncPreferences
    let save: (DigestCalendarSyncPreferences) -> Void

    var body: some View {
        Form {
            Section {
                if sync.status.calendars.isEmpty {
                    Text("No device calendars were found yet. They appear here after the first sync.").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(sync.status.calendars) { calendar in
                    Toggle(calendar.title, isOn: Binding(
                        get: { !preferences.excludedCalendarIds.contains(calendar.id) },
                        set: { included in
                            if included { preferences.excludedCalendarIds.removeAll { $0 == calendar.id } }
                            else if !preferences.excludedCalendarIds.contains(calendar.id) { preferences.excludedCalendarIds.append(calendar.id) }
                            save(preferences)
                        }
                    ))
                }
            } header: { Text("Calendars on this iPhone") } footer: {
                Text("Every calendar stays in sync with your private Kordi calendar automatically. Turning one off removes its events from Kordi; the source calendar is never changed.")
            }
            Section {
                Toggle("Add events created in Kordi to my calendar", isOn: Binding(get: { preferences.outbound }, set: { preferences.outbound = $0; save(preferences) }))
                if preferences.outbound {
                    Picker("Add them to", selection: Binding(get: { preferences.targetCalendarId ?? "" }, set: { preferences.targetCalendarId = $0.isEmpty ? nil : $0; save(preferences) })) {
                        Text("Default calendar").tag("")
                        ForEach(sync.status.calendars.filter(\.allowsModifications)) { calendar in Text(calendar.title).tag(calendar.id) }
                    }
                }
            } footer: { Text("No invitations are sent.") }
        }
        .navigationTitle("Calendar settings").navigationBarTitleDisplayMode(.inline)
    }
}
