import SwiftUI

/// Looking for: the person's requests, newest first, and Add.
struct CommonGroundNearbyNeedsSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.kordiChatTheme) private var chatTheme
    /// Opens the request sheet: a request to edit, or nil for a new one.
    let onEdit: (CommonGroundNearbyNeed?) -> Void

    var body: some View {
        let needs = model.nearby.needs
        CommonGroundSection(title: "Looking for") {
            ForEach(needs) { need in
                Button { onEdit(need) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(need.text).font(.body).foregroundStyle(.primary).lineLimit(2)
                            Text(CommonGroundNearbyWindow.subtitle(need, now: .now))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .opacity(need.isEnded ? 0.45 : 1)
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SessionRowButtonStyle())
                SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
            }
            Button { onEdit(nil) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus").font(.body.weight(.semibold))
                    Text("Add")
                }
                .font(.body)
                .foregroundStyle(chatTheme.accent)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(SessionRowButtonStyle())
            .disabled(needs.count >= 10)
            .opacity(needs.count >= 10 ? 0.45 : 1)
        }
    }
}

/// Alerts: requests, good matches and how many a day.
struct CommonGroundNearbyAlertsSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.kordiChatTheme) private var chatTheme

    var body: some View {
        let alerts = model.nearby.settings?.alerts ?? CommonGroundNearbyAlerts()
        CommonGroundSection(title: "Alerts") {
            toggle("Requests", subtitle: nil, isOn: alerts.requests) { on in
                Task { await model.setNearbyAlerts(requests: on) }
            }
            SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
            toggle("Good matches", subtitle: "\(alerts.matchMinScore)% and up", isOn: alerts.matches) { on in
                Task { await model.setNearbyAlerts(matches: on) }
            }
            SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
            Menu {
                Picker("At most", selection: Binding(get: { alerts.maxPerDay }, set: { count in
                    Task { await model.setNearbyAlerts(maxPerDay: count) }
                })) {
                    ForEach(CommonGroundNearbyBand.perDay, id: \.self) { Text(CommonGroundNearbyBand.perDayLabel($0)).tag($0) }
                }
            } label: {
                HStack(spacing: 6) {
                    Text("At most").font(.body).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    Text(CommonGroundNearbyBand.perDayLabel(alerts.maxPerDay)).font(.body).foregroundStyle(.secondary)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight)
                .contentShape(Rectangle())
            }
        }
    }

    private func toggle(_ title: String, subtitle: String?, isOn: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { isOn }, set: set)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                if let subtitle {
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .tint(chatTheme.accent)
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 8)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
    }
}
