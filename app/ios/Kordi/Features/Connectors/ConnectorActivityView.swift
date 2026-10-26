import SwiftUI

struct ConnectorActivityView: View {
    let definition: ConnectorDefinition
    let client: any ConnectorsClient

    @State private var entries: [ConnectorAuditEntry]?
    @State private var errorMessage: String?

    var body: some View {
        SettingsPage {
            if let errorMessage {
                SettingsErrorLabel(errorMessage)
            }
            if let entries {
                if entries.isEmpty {
                    SettingsCaption("No activity yet.")
                } else {
                    ForEach(entries) { entry in
                        if entry.id != entries.first?.id { Divider() }
                        ConnectorAuditRow(entry: entry)
                    }
                }
            } else {
                SettingsLoadingRow("Loading activity…")
            }
        }
        .navigationTitle("\(definition.name) activity")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            entries = try await client.auditLog(definition.providerId)
            errorMessage = nil
        } catch {
            entries = entries ?? []
            errorMessage = ConnectorsStore.message(error, fallback: "Could not load activity.")
        }
    }
}

private struct ConnectorAuditRow: View {
    let entry: ConnectorAuditEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(ConnectorAuditTime.label(entry.at))
                Text("·").accessibilityHidden(true)
                Text(entry.agentName)
                Spacer(minLength: 4)
                Text(entry.group == .act ? "Act" : "Read")
            }
            .font(SettingsFont.subtitle)
            .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(entry.tool)
                    .font(SettingsFont.subtitle.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(entry.outcome.label)
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(entry.outcome == .denied || entry.outcome == .blockedBackground || entry.outcome == .failed ? Color.red : Color.secondary)
            }
            Text(entry.summary)
                .font(SettingsFont.rowTitle)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}

enum ConnectorAuditTime {
    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let fallbackParser = ISO8601DateFormatter()

    /// Matches the desktop: "Just now", "N min ago", "N hr ago", then a date.
    static func label(_ value: String, now: Date = Date()) -> String {
        guard let date = parser.date(from: value) ?? fallbackParser.date(from: value) else { return "" }
        let elapsed = max(0, now.timeIntervalSince(date))
        if elapsed < 60 { return "Just now" }
        if elapsed < 3600 { return "\(max(1, Int(elapsed / 60))) min ago" }
        if elapsed < 86_400 { return "\(max(1, Int(elapsed / 3600))) hr ago" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
