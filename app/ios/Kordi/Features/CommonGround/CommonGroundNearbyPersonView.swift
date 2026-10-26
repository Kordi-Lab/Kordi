import SwiftUI

/// Someone seen through Nearby: the match badge, their shared card's name
/// and the distance band, Add or Message and Meet, the checks for your
/// requests, then Shared and Trade. Waits while the match is being found;
/// leaves when the person is no longer visible.
struct CommonGroundNearbyPersonView: View {
    private enum Tab: String, CaseIterable, Identifiable {
        case shared = "Shared"
        case trade = "Trade"
        case card = "Card"
        var id: Self { self }
    }

    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.kordiChatTheme) private var chatTheme
    let personID: String
    @State private var tab = Tab.shared

    var body: some View {
        let detail = model.nearby.persons[personID]
        let entry = detail?.entry ?? model.nearby.people?.people.first { $0.id == personID }
        CommonGroundPage {
            if let entry {
                hero(entry)
                content(entry, detail: detail)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            guard await model.loadNearbyPerson(personID) else { return dismiss() }
            if !(await model.waitForNearbyPerson(personID)) { dismiss() }
        }
    }

    private func hero(_ entry: CommonGroundNearbyEntry) -> some View {
        VStack(spacing: 0) {
            CommonGroundMatchBadge(me: model.me, person: entry.person, score: entry.score)
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            VStack(spacing: 4) {
                Text(entry.person.displayName)
                    .font(.system(size: 24, weight: .bold))
                    .multilineTextAlignment(.center)
                HStack(spacing: 8) {
                    if let profile = entry.person.profile {
                        HStack(spacing: 6) {
                            CommonGroundCardSwatch(design: profile.cardDesign, width: 14, height: 10, cornerRadius: 3)
                            Text(profile.title).lineLimit(1)
                        }
                        .font(.footnote.weight(.medium))
                        .padding(.leading, 7)
                        .padding(.trailing, 9)
                        .frame(height: 24)
                        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                    }
                    Text(entry.distance.label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 10)
            .accessibilityElement(children: .combine)
            CommonGroundPersonActions(person: entry.person)
                .padding(.top, 16)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private func content(_ entry: CommonGroundNearbyEntry, detail: CommonGroundNearbyPersonDetail?) -> some View {
        VStack(spacing: 16) {
            if let requests = detail?.requests, !requests.isEmpty {
                CommonGroundSection(title: "Your requests") {
                    ForEach(Array(requests.enumerated()), id: \.element.id) { index, request in
                        if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                        requestBlock(request)
                    }
                }
            }
            if entry.score != nil, let detail {
                Picker("Match content", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                match(detail, name: entry.person.displayName)
            } else if entry.isMatching {
                CommonGroundSection {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Finding overlap").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                }
            } else if detail != nil {
                CommonGroundSection { row("No match yet", nil) }
            }
        }
    }

    private func requestBlock(_ request: CommonGroundNearbyRequestChecks) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(request.text).font(.body.weight(.semibold))
            ForEach(request.checks, id: \.condition) { check in
                HStack(alignment: .top, spacing: 10) {
                    ZStack {
                        if check.met {
                            Circle().fill(chatTheme.accent.opacity(0.14))
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(chatTheme.accent)
                        } else {
                            Circle()
                                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [2.5, 2.5]))
                                .foregroundStyle(Color(uiColor: .tertiaryLabel))
                        }
                    }
                    .frame(width: 22, height: 22)
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(check.label.isEmpty ? request.text : check.label)
                            .font(.subheadline)
                            .foregroundStyle(check.met ? .primary : .secondary)
                        Text(check.evidenceLine)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func match(_ detail: CommonGroundNearbyPersonDetail, name: String) -> some View {
        switch tab {
        case .card:
            CommonGroundSharedCardDetails(person: detail.entry.person, topics: detail.card)
        case .shared:
            CommonGroundSection {
                if detail.shared.isEmpty { row("No clear overlap yet", nil) }
                ForEach(Array(detail.shared.enumerated()), id: \.offset) { index, reason in
                    if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                    row(reason.topic, reason.why, style: commonGroundStyle(for: reason.topic))
                }
            }
        case .trade:
            VStack(spacing: 16) {
                if detail.youBring.isEmpty && detail.theyBring.isEmpty {
                    CommonGroundSection { row("No clear trade yet", nil) }
                }
                if !detail.youBring.isEmpty { trades("You bring", detail.youBring) }
                if !detail.theyBring.isEmpty { trades("\(name) brings", detail.theyBring) }
            }
        }
        if tab != .card, let next = detail.nextStep, !next.isEmpty {
            CommonGroundSection(title: "Next step") { row(next, nil) }
        }
    }

    private func trades(_ title: String, _ items: [CommonGroundTrade]) -> some View {
        CommonGroundSection(title: title) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                row(item.topic, item.why.isEmpty ? "For \(item.target)" : item.why, style: commonGroundStyle(for: item.topic))
            }
        }
    }

    private func row(_ title: String, _ subtitle: String?, style: (symbol: String, color: Color)? = nil) -> some View {
        HStack(spacing: 12) {
            if let style { SessionSettingsIconTile(systemImage: style.symbol, color: style.color) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(.secondary) }
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
    }
}
