import SwiftUI

// The Nearby screen's parts: the Sharing chip, Meet for, People, Looking for
// and Alerts. Each reads the shared model; changes are written at once.

/// "Sharing Work" with the card's swatch; a menu when there is a choice.
struct CommonGroundNearbyCardChip: View {
    @EnvironmentObject private var model: CommonGroundModel

    var body: some View {
        let choices = model.shareChoices
        let selected = model.nearbyProfileID
        if choices.count > 1 {
            Menu {
                ForEach(choices) { profile in
                    Button {
                        Task { await model.setNearbyProfile(profile.profileId) }
                    } label: {
                        if profile.profileId == selected {
                            Label(profile.title, systemImage: "checkmark")
                        } else {
                            Text(profile.title)
                        }
                    }
                }
            } label: {
                label(selected, menu: true)
            }
            .disabled(model.busy != nil)
        } else {
            label(selected, menu: false)
        }
    }

    private func label(_ profileId: String?, menu: Bool) -> some View {
        HStack(spacing: 6) {
            CommonGroundCardSwatch(design: model.design(ofProfile: profileId), width: 14, height: 10, cornerRadius: 3)
            Text("Sharing \(model.profile(profileId)?.title ?? "Work")")
                .lineLimit(1)
            if menu {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .frame(height: 30)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        .contentShape(Capsule())
    }
}

/// Suggestions are choices, never consent. Only saved activities are selected.
enum CommonGroundNearbyActivities {
    static func suggestions(for profile: CommonGroundProfileSummary?) -> [String] {
        switch profile?.icon {
        case "camera": return ["Photo walk", "Sharing tips", "Creative project", "Coffee chat"]
        case "graduation": return ["Alumni meetup", "Mentoring", "Career chat", "Reconnecting"]
        case "leaf": return ["Activity partner", "Training together", "Sharing tips", "Encouragement"]
        default: break
        }
        switch profile?.kind {
        case "health": return ["Activity partner", "Training together", "Sharing tips", "Encouragement"]
        case "work": return ["Coffee chat", "Collaborating", "Advice", "Hiring"]
        case "daily": return ["Shared activity", "Exploring together", "Sharing tips", "Coffee chat"]
        default: return ["Shared activity", "Sharing ideas", "Advice", "Coffee chat"]
        }
    }

    static func options(for profile: CommonGroundProfileSummary?, selected: [String]) -> [String] {
        let suggested = suggestions(for: profile)
        return suggested + selected.filter { entry in
            !suggested.contains { $0.caseInsensitiveCompare(entry) == .orderedSame }
        }
    }
}

/// Activities saved for the card currently shared through Nearby.
struct CommonGroundNearbyOpenToSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.kordiChatTheme) private var chatTheme
    @State private var draft: String?
    @State private var draftProfileId: String?
    @FocusState private var typing: Bool

    var body: some View {
        let chosen = model.nearby.settings?.openTo ?? []
        let profileId = model.nearby.settings?.profileId
        let profile = model.profile(profileId)
        CommonGroundSection(title: "Meet for") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Choose activities you’d like to do with people you meet. Saved for this card.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                FlowLayout(spacing: 8) {
                    ForEach(CommonGroundNearbyActivities.options(for: profile, selected: chosen), id: \.self) { entry in
                        let on = chosen.contains { $0.caseInsensitiveCompare(entry) == .orderedSame }
                        Button {
                            Task { await model.toggleNearbyOpenTo(entry, profileId: profileId) }
                        } label: {
                            chip(entry, on: on)
                        }
                        .buttonStyle(.plain)
                        .disabled(profileId == nil || model.busy != nil || (!on && chosen.count >= 5))
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                    if draft != nil {
                        TextField("Activity", text: Binding(get: { draft ?? "" }, set: { draft = String($0.prefix(30)) }))
                            .font(.subheadline.weight(.medium))
                            .focused($typing)
                            .submitLabel(.done)
                            .onSubmit(commit)
                            .onAppear { typing = true }
                            .frame(width: 120)
                            .padding(.horizontal, 12)
                            .frame(height: commonGroundTagHeight)
                            .overlay(commonGroundTagShape.strokeBorder(chatTheme.accent.opacity(0.55), lineWidth: 1.5))
                    } else {
                        Button {
                            draftProfileId = profileId
                            draft = ""
                        } label: {
                            Label("Add activity", systemImage: "plus")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10)
                                .frame(height: commonGroundTagHeight)
                                .background(Color(uiColor: .tertiarySystemFill), in: commonGroundTagShape)
                        }
                        .buttonStyle(.plain)
                        .disabled(profileId == nil || model.busy != nil || chosen.count >= 5)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: typing) { _, focused in if !focused, draft != nil { commit() } }
        .onChange(of: profileId) { _, _ in
            draft = nil
            draftProfileId = nil
            typing = false
        }
    }

    private func chip(_ entry: String, on: Bool) -> some View {
        HStack(spacing: 6) {
            if on {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
            }
            Text(entry).lineLimit(1)
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(on ? chatTheme.accent : .primary)
        .padding(.horizontal, 12)
        .frame(height: commonGroundTagHeight)
        .background(on ? chatTheme.accent.opacity(0.14) : Color(uiColor: .tertiarySystemFill), in: commonGroundTagShape)
        .animation(.easeOut(duration: 0.2), value: on)
    }

    private func commit() {
        let text = draft ?? ""
        let profileId = draftProfileId
        draft = nil
        draftProfileId = nil
        Task { await model.addNearbyOpenTo(text, profileId: profileId) }
    }
}

/// People nearby with the Within and match filters.
struct CommonGroundNearbyPeopleSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.kordiChatTheme) private var chatTheme
    let status: CommonGroundNearbyStatus
    let onOpen: (String) -> Void
    let onSettings: () -> Void

    private var settings: CommonGroundNearbySettings? { model.nearby.settings }

    /// No fix can be sent: location access or precise location is off.
    private var locationOff: Bool { status == .denied || status == .imprecise }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("People")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if !locationOff, !model.nearby.noLocation, let settings {
                    filter(CommonGroundNearbyBand.rangePill(settings.range), values: CommonGroundNearbyBand.ranges,
                           selected: settings.range, label: CommonGroundNearbyBand.rangeLabel) { value in
                        Task { await model.setNearbyFilter(range: value) }
                    }
                    filter(CommonGroundNearbyBand.scorePill(settings.minScore), values: CommonGroundNearbyBand.scores,
                           selected: settings.minScore, label: CommonGroundNearbyBand.scoreLabel) { value in
                        Task { await model.setNearbyFilter(minScore: value) }
                    }
                }
            }
            .padding(.leading, SessionDetailMetrics.rowHorizontalInset)
            .frame(minHeight: 28)
            CommonGroundSection { rows }
        }
    }

    @ViewBuilder private var rows: some View {
        if locationOff {
            HStack(spacing: 12) {
                Text(status == .imprecise ? "Precise location is off" : "Location access is off").font(.body)
                Spacer(minLength: 8)
                Button("Settings", action: onSettings)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: 30)
                    .background(chatTheme.accent, in: Capsule())
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .frame(minHeight: SessionDetailMetrics.rowMinHeight)
        } else if model.nearby.noLocation || status == .stale {
            line("Update to see who is nearby")
            ForEach(model.nearby.people?.shown ?? []) { entry in
                SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 52)
                HStack(spacing: 12) {
                    CommonGroundAvatar(person: entry.person, size: 40)
                    Text(entry.person.labeledName).font(.headline)
                }
                .opacity(0.38)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
            }
        } else if let people = model.nearby.people {
            let shown = people.shown
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, entry in
                if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 52) }
                personRow(entry)
            }
            if people.matchingMore > 0 {
                if !shown.isEmpty { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 52) }
                HStack(spacing: 12) {
                    ProgressView().frame(width: 40)
                    Text("Matching \(people.matchingMore) more").font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            }
            if shown.isEmpty && people.matchingMore == 0 { line("No one nearby yet") }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight)
        }
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
    }

    private func personRow(_ entry: CommonGroundNearbyEntry) -> some View {
        Button { onOpen(entry.person.accountId) } label: {
            HStack(spacing: 12) {
                CommonGroundAvatar(person: entry.person, size: 40)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.person.labeledName).font(.headline).foregroundStyle(.primary)
                    Text(entry.detailLine).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                    if let headline = entry.headline, !headline.isEmpty {
                        Text(headline).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if !entry.requests.isEmpty {
                        FlowLayout(spacing: 6) {
                            ForEach(entry.requests) { CommonGroundNearbyMetTag(text: $0.text) }
                        }
                        .padding(.top, 5)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionRowButtonStyle())
    }

    private func filter(_ title: String, values: [Int], selected: Int, label: @escaping (Int) -> String,
                        pick: @escaping (Int) -> Void) -> some View {
        Menu {
            Picker(title, selection: Binding(get: { selected }, set: pick)) {
                ForEach(values, id: \.self) { Text(label($0)).tag($0) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(.primary)
            .padding(.leading, 11)
            .padding(.trailing, 10)
            .frame(height: 28)
            .background(Color(uiColor: .secondarySystemGroupedBackground).opacity(0.7), in: Capsule())
            .overlay(Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 0.5))
        }
    }
}

/// A request the person meets, under their name: a check and the request.
struct CommonGroundNearbyMetTag: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(chatTheme.accent)
            Text(text).lineLimit(1)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.primary)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(chatTheme.accent.opacity(0.13), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
