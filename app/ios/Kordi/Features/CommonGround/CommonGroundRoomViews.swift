import SwiftUI

// MARK: - Lobby

/// Members as they arrive; Find common ground once two others are here.
struct CommonGroundLobbyView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    @Binding var path: [CommonGroundRoute]

    private var room: CommonGroundRoom? { model.rooms[code] }
    private var members: [CommonGroundPerson] { room?.members ?? [] }

    var body: some View {
        CommonGroundPage(onBack: { path = [] }) {
            CommonGroundRoomHeader(title: room?.title ?? "Room", status: status,
                                   code: code, people: [model.me] + members) {
                Task {
                    await model.leaveRoom(code)
                    path = []
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

/// Keeps the invitation code visible after entering a room, with compact
/// copy, share and leave controls instead of a second row of large tiles.
struct CommonGroundRoomHeader: View {
    let title: String
    let status: String
    let code: String
    let people: [CommonGroundPerson]
    var closed = false
    let leave: () -> Void
    @State private var copied = false

    var body: some View {
        CommonGroundHero(title: title, status: status) {
            CommonGroundStack(people: people, size: 64)
        } actions: {
            VStack(spacing: 10) {
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                } label: {
                    HStack(spacing: 10) {
                        Text(copied ? "Copied" : "Room code")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(code)
                            .font(.title2.monospaced().weight(.semibold))
                            .foregroundStyle(.primary)
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.subheadline)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy room code")
                .accessibilityValue(code.map(String.init).joined(separator: " "))
                .accessibilityIdentifier("grounding-room-code")
                .sensoryFeedback(.success, trigger: copied)
                .task(id: copied) {
                    guard copied else { return }
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled else { return }
                    copied = false
                }
                if !closed {
                    HStack(spacing: 20) {
                        ShareLink(item: code) {
                            Label("Share code", systemImage: "square.and.arrow.up")
                                .frame(minHeight: 44)
                        }
                        Button(action: leave) {
                            Label("Leave", systemImage: "rectangle.portrait.and.arrow.right")
                                .frame(minHeight: 44)
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
