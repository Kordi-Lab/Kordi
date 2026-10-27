import SwiftUI

private enum CommonGroundMatchTab: String, CaseIterable, Identifiable {
    case card = "Card"
    case shared = "Shared"
    case trade = "Trade"
    var id: Self { self }
}

/// What you share with one person. Waits while the server is matching.
struct CommonGroundMatchView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let personID: String

    var body: some View {
        if let match = model.matches[personID], match.isReady {
            CommonGroundMatchContent(match: match)
        } else if let match = model.matches[personID], !match.isMatching {
            CommonGroundPage {
                CommonGroundHero(title: match.person.displayName, status: "No match yet") {
                    CommonGroundMatchBadge(me: model.me, person: match.person, score: nil)
                } actions: {
                    CommonGroundPersonActions(person: match.person)
                }
                Button("Try again") { Task { await model.loadMatch(personID) } }
                    .buttonStyle(CommonGroundPrimaryButtonStyle())
                    .padding(.horizontal, 20)
            }
        } else {
            CommonGroundPage {
                CommonGroundMatchingAnimation(
                    yours: model.profile(model.viewerProfiles[personID] ?? model.currentProfileID)?.cardDesign ?? .work,
                    theirs: model.person(personID)?.profile?.cardDesign ?? .custom)
                    .padding(.top, 64)
                Text("Finding common ground").font(.title2.weight(.semibold))
                Text("Comparing your shared cards")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            .task {
                if model.matches[personID] == nil { await model.loadMatch(personID) }
                if model.matches[personID] == nil {
                    dismiss()
                    return
                }
                await model.waitForMatch(personID)
            }
        }
    }
}

/// Two shared cards moving toward each other only while the real match is
/// pending. Reduce Motion keeps the same visual without movement.
struct CommonGroundMatchingAnimation: View {
    let yours: CommonGroundCardDesign
    let theirs: CommonGroundCardDesign
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var together = false

    var body: some View {
        HStack(spacing: 18) {
            CommonGroundCardSwatch(design: yours, width: 100, height: 63, cornerRadius: 8)
                .rotationEffect(.degrees(reduceMotion ? 0 : together ? -3 : -9))
                .offset(x: reduceMotion ? 0 : together ? 8 : -8)
            CommonGroundCardSwatch(design: theirs, width: 100, height: 63, cornerRadius: 8)
                .rotationEffect(.degrees(reduceMotion ? 0 : together ? 3 : 9))
                .offset(x: reduceMotion ? 0 : together ? -8 : 8)
        }
        .frame(height: 120)
        .animation(reduceMotion ? nil : .easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: together)
        .onAppear { together = true }
        .onDisappear { together = false }
        .accessibilityHidden(true)
    }
}

private struct CommonGroundMatchContent: View {
    @EnvironmentObject private var model: CommonGroundModel
    let match: CommonGroundMatch
    @State private var tab = CommonGroundMatchTab.card
    @State private var loadingCard = false

    var body: some View {
        let person = match.person
        CommonGroundPage {
            CommonGroundHero(title: person.displayName, status: match.headline ?? "") {
                CommonGroundMatchBadge(me: model.me, person: person, score: match.score)
            } actions: {
                CommonGroundPersonActions(person: person)
            }

            VStack(spacing: 16) {
                Picker("Match content", selection: $tab) {
                    ForEach(CommonGroundMatchTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                switch tab {
                case .card:
                    if let card = model.people[person.accountId] {
                        CommonGroundSharedCardDetails(person: card.person, topics: card.card)
                    } else if loadingCard {
                        ProgressView("Loading card").padding(16)
                    } else {
                        CommonGroundSection {
                            VStack(spacing: 12) {
                                Text("Card details are not available yet.").foregroundStyle(.secondary)
                                Button("Reload card") { Task { await loadCard() } }
                            }
                            .padding(16)
                        }
                    }
                case .shared:
                    CommonGroundSection {
                        if match.shared.isEmpty {
                            row("No clear overlap yet", nil)
                        }
                        ForEach(Array(match.shared.enumerated()), id: \.offset) { index, reason in
                            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                            row(reason.topic, reason.why, style: commonGroundStyle(for: reason.topic))
                        }
                    }
                case .trade:
                    VStack(spacing: 16) {
                        if match.youBring.isEmpty && match.theyBring.isEmpty {
                            CommonGroundSection { row("No clear trade yet", nil) }
                        }
                        if !match.youBring.isEmpty {
                            tradeSection("You bring", match.youBring)
                        }
                        if !match.theyBring.isEmpty {
                            tradeSection("\(person.displayName) brings", match.theyBring)
                        }
                    }
                }
                if tab != .card, let next = match.nextStep, !next.isEmpty {
                    CommonGroundSection(title: "Next step") { row(next, nil) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }
        .task(id: tab) {
            if tab == .card, model.people[person.accountId] == nil {
                await loadCard()
            }
        }
    }

    private func loadCard() async {
        loadingCard = true
        defer { loadingCard = false }
        await model.loadPerson(match.person.accountId)
    }

    private func tradeSection(_ title: String, _ items: [CommonGroundTrade]) -> some View {
        CommonGroundSection(title: title) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                row(item.topic, item.why.isEmpty ? "For \(item.target)" : item.why, style: commonGroundStyle(for: item.topic))
            }
        }
    }

    private func row(_ title: String, _ subtitle: String?, style: (symbol: String, color: Color)? = nil) -> some View {
        HStack(spacing: 12) {
            if let style {
                SessionSettingsIconTile(systemImage: style.symbol, color: style.color)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                if let subtitle {
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
    }
}

/// Someone's card, read-only, after pairing or from a room. Leads to the match.
struct CommonGroundPersonView: View {
    @EnvironmentObject private var model: CommonGroundModel
    let personID: String
    let paired: Bool
    @Binding var path: [CommonGroundRoute]

    var body: some View {
        let card = model.people[personID]
        let person = card?.person ?? model.person(personID) ?? CommonGroundPerson(accountId: personID, name: "")
        CommonGroundPage {
            CommonGroundHero(title: person.displayName, status: paired ? "Paired" : "") {
                CommonGroundAvatar(person: person, size: 92)
            } actions: {
                CommonGroundPersonActions(person: person)
            }
            VStack(spacing: 16) {
                CommonGroundSharedCardDetails(person: person, topics: card?.card)
                Button("Find common ground") { path.append(.match(personID)) }
                    .buttonStyle(CommonGroundPrimaryButtonStyle())
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
            }
            .padding(.horizontal, 16)
        }
        .task { if card == nil { await model.loadPerson(personID) } }
    }
}

/// Only information in the person's shared card, preserving its visual
/// identity and showing every shared topic rather than just match reasons.
struct CommonGroundSharedCardDetails: View {
    let person: CommonGroundPerson
    let topics: CommonGroundTopics?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let profile = person.profile {
                GeometryReader { geometry in
                    ProfileCardView(design: profile.cardDesign, icon: profile.cardIcon,
                                    kindDesign: profile.kindDesign, name: profile.title,
                                    bottom: .topics(topics?.interests ?? []), width: geometry.size.width)
                }
                .aspectRatio(1 / ProfileCardView.aspect, contentMode: .fit)
                if let focus = profile.focus?.trimmingCharacters(in: .whitespacesAndNewlines), !focus.isEmpty {
                    Text(focus).font(.body).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let topics {
                ForEach(CommonGroundTopics.sections.indices, id: \.self) { index in
                    let section = CommonGroundTopics.sections[index]
                    let items = topics[keyPath: section.key]
                    if !items.isEmpty {
                        CommonGroundSection(title: section.title) { CommonGroundTagCloud(topics: items) }
                    }
                }
                if CommonGroundTopics.sections.allSatisfy({ topics[keyPath: $0.key].isEmpty }) {
                    Text("No topics shared yet.").font(.subheadline).foregroundStyle(.secondary)
                }
            } else {
                Text("Card details are not available yet.").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}
