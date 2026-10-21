import SwiftUI

// MARK: - Code (room)

/// A four-digit keypad. Everyone at the event enters the same code.
struct CommonGroundCodeView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @Binding var path: [CommonGroundRoute]
    @State private var code = ""
    @State private var joining = false
    @State private var error: String?
    /// The full code while the share sheet asks which profile to share.
    @State private var asking: String?

    private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "delete"]

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 2) {
                Text("Pair code")
                    .font(.system(size: 24, weight: .bold))
                Text("Same code, same room")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 72)
            HStack(spacing: 22) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(index < code.count ? Color.primary : Color(uiColor: .tertiarySystemFill))
                        .frame(width: 13, height: 13)
                }
            }
            .padding(.top, 32)
            Text(error ?? " ")
                .font(.subheadline)
                .foregroundStyle(.red)
                .padding(.top, 16)
                .accessibilityHidden(error == nil)
            Spacer()
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(keys, id: \.self) { key in
                    keyView(key)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .background {
            SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea()
        }
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) { SessionDetailBackButton { dismiss() } }
        .onAppear {
            code = ""
            joining = false
        }
        .sheet(isPresented: Binding(get: { asking != nil }, set: { if !$0 { cancelAsking() } })) {
            if let entered = asking {
                CommonGroundShareProfileSheet(code: entered) { request in
                    asking = nil
                    join(entered, request: request)
                }
                .environmentObject(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
        }
    }

    private func cancelAsking() {
        guard asking != nil else { return }
        asking = nil
        code = ""
        joining = false
    }

    @ViewBuilder
    private func keyView(_ key: String) -> some View {
        if key.isEmpty {
            Color.clear.frame(height: 62)
        } else {
            Button {
                press(key)
            } label: {
                Group {
                    if key == "delete" {
                        Image(systemName: "delete.left").font(.system(size: 20, weight: .medium))
                    } else {
                        Text(key).font(.system(size: 26, weight: .medium))
                    }
                }
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: 62)
                .sessionGlass(in: RoundedRectangle(cornerRadius: SessionDetailMetrics.actionCornerRadius, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(joining)
            .accessibilityLabel(key == "delete" ? "Delete" : key)
        }
    }

    private func press(_ key: String) {
        error = nil
        if key == "delete" {
            if !code.isEmpty { code.removeLast() }
            return
        }
        guard code.count < 4 else { return }
        code.append(key)
        guard code.count == 4 else { return }
        joining = true
        if model.asksWhichProfile {
            asking = code
        } else {
            join(code, request: model.joinRequest(profileId: model.shareChoices.first?.profileId))
        }
    }

    private func join(_ entered: String, request: CommonGroundJoinRequest) {
        Task {
            if await model.joinRoom(entered, request: request) {
                path.removeLast()
                path.append(.lobby(entered))
            } else {
                // The keypad shows the error inline instead of the toast.
                error = model.notice
                model.notice = nil
                code = ""
                joining = false
            }
        }
    }
}

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
