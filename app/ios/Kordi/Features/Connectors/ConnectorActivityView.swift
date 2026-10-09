import SwiftUI

struct ConnectorActivityView: View {
    let definition: ConnectorDefinition
    let client: any ConnectorsClient

    @State private var entries: [ConnectorAuditEntry]?
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                }
                if let entries {
                    if entries.isEmpty {
                        Text("No activity yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(entries) { ConnectorAuditRow(entry: $0) }
                    }
                } else {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading activity…").foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } footer: {
                Text("Every read and act call your agents made, newest first.")
            }
        }
        .listStyle(.insetGrouped)
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
                ConnectorCapsule(text: entry.group == .act ? "Act" : "Read", tint: entry.group == .act ? .orange : nil)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(entry.tool)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(entry.outcome.label)
                    .font(.caption)
                    .foregroundStyle(entry.outcome == .denied || entry.outcome == .blockedBackground || entry.outcome == .failed ? Color.red : Color.secondary)
            }
            Text(entry.summary)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 3)
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
