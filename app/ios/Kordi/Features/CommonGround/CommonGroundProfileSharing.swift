import SwiftUI

// Which profile a room sees: asked on join when there is a choice, shown in
// the lobby and results header with a way to change it.

/// What the keypad asks before joining: the profile to share and, for the
/// first person in, the room's name.
struct CommonGroundShareProfileSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let code: String
    let join: (CommonGroundJoinRequest) -> Void
    @State private var selected: String?
    @State private var roomName = ""

    var body: some View {
        VStack(spacing: 0) {
            Text("Share which profile?")
                .font(.headline)
                .padding(.top, 22)
            SettingsPage {
                ForEach(Array(model.shareChoices.enumerated()), id: \.element.id) { index, profile in
                    if index > 0 { Divider() }
                    row(profile)
                }
                if model.rooms[code] == nil {
                    SettingsDivider()
                    SettingsSectionTitle("Room name")
                    TextField("Optional", text: $roomName)
                        .font(.subheadline)
                        .frame(minHeight: SettingsMetrics.rowMinHeight)
                }
            }
            Button("Join") {
                join(model.joinRequest(profileId: selected, roomName: roomName))
                dismiss()
            }
            .buttonStyle(CommonGroundPrimaryButtonStyle())
            .disabled(selected == nil)
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear {
            selected = CommonGroundProfileChoice.preselected(
                roomKind: model.suggestedKind(ofRoom: code),
                current: model.currentProfileID,
                in: model.shareChoices
            )
        }
    }

    private func row(_ profile: CommonGroundProfileSummary) -> some View {
        Button { selected = profile.profileId } label: {
            SettingsRow {
                VStack(alignment: .leading, spacing: 2) {
                    Text(profile.title).font(.subheadline)
                    if let focus = profile.focusLine {
                        Text(focus).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            } trailing: {
                if selected == profile.profileId {
                    Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(commonGroundTint)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected == profile.profileId ? .isSelected : [])
    }
}

/// "Sharing: Work" with Change, in a room's lobby and results header.
/// Hidden before profiles; Change only while the room is open and there is
/// another profile with a card.
struct CommonGroundSharingRow: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String

    var body: some View {
        if let line = model.sharingLine(inRoom: code) {
            CommonGroundSection {
                HStack(spacing: 12) {
                    Text(line).font(.body)
                    Spacer(minLength: 8)
                    if !model.isClosed(code), model.asksWhichProfile {
                        Menu {
                            ForEach(model.shareChoices) { profile in
                                Button {
                                    Task { await model.switchRoomProfile(code, to: profile.profileId) }
                                } label: {
                                    if profile.profileId == model.sharedProfileID(inRoom: code) {
                                        Label(profile.title, systemImage: "checkmark")
                                    } else {
                                        Text(profile.title)
                                    }
                                }
                            }
                        } label: {
                            Text("Change").font(.subheadline.weight(.medium))
                        }
                        .disabled(model.busy == "switch")
                    }
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(minHeight: SessionDetailMetrics.rowMinHeight)
            }
        }
    }
}
