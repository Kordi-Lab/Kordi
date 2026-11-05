import SwiftUI

/// Settings › Usage: today's limits for each organization the account is in.
struct UsageSettingsView: View {
    @StateObject private var model: UsageSettingsModel

    init(model: @autoclosure @escaping () -> UsageSettingsModel) {
        _model = StateObject(wrappedValue: model())
    }

    init(appModel: AppModel) {
        self.init(model: UsageSettingsModel(service: appModel.makeUsageService()) { [weak appModel] organizations in
            appModel?.updateOrganizations(organizations)
        })
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

            ForEach(Array(model.sections.enumerated()), id: \.element.id) { index, section in
                if index > 0 { SettingsDivider() }
                organizationSection(section)
            }
        }
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
    }

    @ViewBuilder
    private func organizationSection(_ section: UsageSettingsModel.Section) -> some View {
        SettingsSectionTitle(section.organization.name)
        if let usage = section.usage {
            if UsagePresentation.isManager(role: usage.role ?? section.organization.role),
               let notice = UsagePresentation.noticeLine(usage.notices) {
                SettingsCaption(notice)
            }
            if usage.snapshots.isEmpty {
                SettingsCaption("No limits.")
            } else {
                ForEach(usage.snapshots, id: \.limitId) { snapshot in
                    UsageSnapshotRow(snapshot: snapshot)
                }
            }
        } else {
            SettingsCaption("Could not load usage.")
        }
    }
}

/// Label, a thin bar filled to the used share, the value, and when it resets.
struct UsageSnapshotRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let snapshot: CloudUsageSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                Text(UsagePresentation.label(limitId: snapshot.limitId))
                    .font(SettingsFont.rowTitle)
                    .frame(minWidth: 96, alignment: .leading)
                UsageBar(fraction: Double(snapshot.usedPercent) / 100, tint: snapshot.isReached ? .orange : chatTheme.accent)
                Text(UsagePresentation.value(snapshot))
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
            }
            Text(UsagePresentation.status(snapshot))
                .font(SettingsFont.subtitle)
                .foregroundStyle(snapshot.isReached ? Color.orange : Color.secondary)
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
