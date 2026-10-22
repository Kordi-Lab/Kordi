import SwiftUI

// Which profile a room sees, shown in the lobby and results header with a
// way to change it. Home's join sheet asks which card to share.

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
