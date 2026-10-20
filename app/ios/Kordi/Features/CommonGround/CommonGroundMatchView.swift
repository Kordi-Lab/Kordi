import SwiftUI

private enum CommonGroundMatchTab: String, CaseIterable, Identifiable {
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
            CommonGroundWaitPage(steps: ["Reading cards", "Finding overlap"]) {
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

private struct CommonGroundMatchContent: View {
    @EnvironmentObject private var model: CommonGroundModel
    let match: CommonGroundMatch
    @State private var tab = CommonGroundMatchTab.shared

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
                if let next = match.nextStep, !next.isEmpty {
                    CommonGroundSection(title: "Next step") { row(next, nil) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }
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
                if let topics = card?.card {
                    ForEach(CommonGroundTopics.sections.indices, id: \.self) { index in
                        let section = CommonGroundTopics.sections[index]
                        let items = topics[keyPath: section.key]
                        if !items.isEmpty {
                            CommonGroundSection(title: section.title) { CommonGroundTagCloud(topics: items) }
                        }
                    }
                }
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
