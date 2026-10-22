import SwiftUI

// MARK: - Lobby

/// Members as they arrive; Find common ground once two others are here.
struct CommonGroundLobbyView: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    @Binding var path: [CommonGroundRoute]

    private var room: CommonGroundRoom? { model.rooms[code] }
    private var members: [CommonGroundPerson] { room?.members ?? [] }

    var body: some View {
        CommonGroundPage(onBack: { path = [] }) {
            CommonGroundHero(title: room?.title ?? "Room \(code)", status: status) {
                CommonGroundStack(people: [model.me] + members, size: 92)
            } actions: {
                CommonGroundActions(columns: 2) {
                    ShareLink(item: code) {
                        SessionProfileActionLabel(title: "Share code", symbol: "square.and.arrow.up", tint: commonGroundTint, isSelected: false)
                    }
                    .buttonStyle(.plain)
                    SessionProfileActionButton(title: "Leave", symbol: "rectangle.portrait.and.arrow.right", tint: commonGroundTint) {
                        Task {
                            await model.leaveRoom(code)
                            path = []
                        }
                    }
                }
            }
            VStack(spacing: 16) {
                CommonGroundSharingRow(code: code)
                CommonGroundSection {
                    CommonGroundPeopleRows(
                        entries: [.init(person: model.me, subtitle: "You", selectable: false)]
                            + members.map { .init(person: $0, subtitle: "", selectable: $0.hasCard != false) }
                    ) { person in
                        model.view(person.accountId, through: model.sharedProfileID(inRoom: code))
                        path.append(.person(person.accountId, paired: false))
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Find common ground") {
                Task {
                    if await model.loadResults(code) {
                        path.removeLast()
                        path.append(.results(code))
                    }
                }
            }
            .buttonStyle(CommonGroundPrimaryButtonStyle())
            .disabled(members.count < 2 || model.busy == "find")
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .task {
            while !Task.isCancelled {
                guard await model.refreshRoom(code) else {
                    path = []
                    return
                }
                try? await Task.sleep(for: CommonGroundModel.lobbyPollInterval)
            }
        }
    }

    private var status: String {
        if members.isEmpty { return "Waiting for others" }
        return "\(members.count + 1) people"
    }
}
