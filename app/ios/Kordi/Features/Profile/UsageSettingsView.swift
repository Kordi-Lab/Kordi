import SwiftUI

/// Settings › Usage: today's limits for each organization the account is in.
struct UsageSettingsView: View {
    @StateObject private var model: UsageSettingsModel

    init(service: any UsageService) {
        _model = StateObject(wrappedValue: UsageSettingsModel(service: service))
    }

    init(appModel: AppModel) {
        self.init(service: appModel.makeUsageService())
    }

    var body: some View {
        SettingsPage {
            if let error = model.errorMessage, !model.hasLoaded {
                SettingsErrorLabel(error)
                Button("Try again") { Task { await model.load() } }
                    .font(SettingsFont.action)
                    .frame(minHeight: SettingsMetrics.textRowMinHeight)
                    .disabled(model.isLoading)
            } else if !model.hasLoaded {
                SettingsLoadingRow("Loading usage…")
            }

            ForEach(Array(model.organizations.enumerated()), id: \.element.id) { index, organization in
                if index > 0 { SettingsDivider() }
                SettingsSectionTitle(organization.name)
                if organization.snapshots.isEmpty {
                    SettingsCaption("No limits.")
                } else {
                    ForEach(organization.snapshots, id: \.limitId) { snapshot in
                        UsageSnapshotRow(snapshot: snapshot, role: organization.role)
                    }
                }
            }
        }
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
    }
}

/// Label, a thin bar filled to the used share, the value, and when it resets.
struct UsageSnapshotRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let snapshot: CloudUsageSnapshot
    let role: String?

    var body: some View {
        let level = UsagePresentation.level(snapshot)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                Text(UsagePresentation.label(limitId: snapshot.limitId))
                    .font(SettingsFont.rowTitle)
                    .lineLimit(1)
                    .fixedSize()
                UsageBar(
                    fraction: Double(snapshot.usedPercent) / 100,
                    tint: UsagePresentation.tint(level, accent: chatTheme.accent)
                )
                Text(UsagePresentation.value(snapshot))
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
            }
            Text(UsagePresentation.status(snapshot, role: role))
                .font(SettingsFont.subtitle)
                .foregroundStyle(snapshot.isReached ? Color.red : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 8)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .accessibilityElement(children: .combine)
    }
}

private struct UsageBar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(uiColor: .systemFill))
                Capsule()
                    .fill(tint)
                    .frame(width: proxy.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}
