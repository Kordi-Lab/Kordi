import SwiftUI

struct CommonGroundHome: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    var onClose: (() -> Void)? = nil
    @State private var asksSharing = false

    var body: some View {
        CommonGroundPage(showsBack: onClose != nil, onBack: onClose) {
            CommonGroundHero(title: "Common ground", status: model.me.displayName) {
                CommonGroundAvatar(person: model.me, size: 92)
            } actions: {
                CommonGroundActions(columns: 2) {
                    SessionProfileActionButton(title: "Pair code", symbol: "circle.grid.3x3", tint: commonGroundTint) {
                        if model.sharing { path.append(.code) } else { asksSharing = true }
                    }
                    SessionProfileActionButton(title: "Your card", symbol: "person.text.rectangle", tint: commonGroundTint) {
                        path.append(.card)
                    }
                }
            }

            VStack(spacing: 16) {
                CommonGroundRoomsSection(path: $path)
                VStack(spacing: 10) {
                    if model.profilesEnabled, !model.profiles.isEmpty {
                        CommonGroundProfileSwitcher().padding(.horizontal, -16)
                    }
                    cardSection
                }
                recentSection
            }
            .padding(.horizontal, 16)
        }
        .task { await model.loadHome() }
        .task(id: model.isBuilding) { await model.waitForBuild() }
        .alert("Turn on sharing?", isPresented: $asksSharing) {
            Button("Turn on") {
                Task {
                    await model.setSharing(true)
                    if model.sharing { path.append(.code) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Others in a room see your topics.")
        }
    }

    private var cardSection: some View {
        CommonGroundSection(title: "Your card") {
            if model.isBuilding {
                CommonGroundRow(title: "Building your card")
            } else if model.profilesEnabled, model.loaded, !model.hasCard {
                CommonGroundRow(title: model.buildTitle) { path.append(.build) }
            } else {
                Button { path.append(.card) } label: {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 12) {
                            Text(model.loaded ? "\(model.myTopics.count) topics shared" : "Loading")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        if !model.myTopics.isEmpty {
                            FlowLayout(spacing: 6) {
                                ForEach(model.myTopics.prefix(8), id: \.self) { CommonGroundTopicPill(topic: $0) }
                            }
                        }
                    }
                    .padding(SessionDetailMetrics.rowHorizontalInset)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SessionRowButtonStyle())
            }
        }
    }

    // MARK: Recent

    private var recentSection: some View {
        CommonGroundSection(title: "Recent") {
            if model.recent.isEmpty {
                CommonGroundRow(title: "No matches yet")
            } else {
                CommonGroundPeopleRows(
                    entries: model.recent.map { .init(person: $0.person, subtitle: $0.headline ?? "", score: $0.score) }
                ) { person in
                    model.view(person.accountId, through: model.recent.first { $0.person == person }?.profileId)
                    path.append(.match(person.accountId))
                }
            }
        }
    }
}
