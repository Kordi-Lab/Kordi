import SwiftUI

/// A compact visual card picker, shared by the lobby and room results.
struct CommonGroundSharingRow: View {
    @EnvironmentObject private var model: CommonGroundModel
    let code: String
    @State private var choosing = false

    private var selected: CommonGroundProfileSummary? {
        model.profile(model.sharedProfileID(inRoom: code))
    }
    private var canChange: Bool { !model.isClosed(code) && model.asksWhichProfile }

    var body: some View {
        if let selected {
            Group {
                if canChange {
                    Button { model.notice = nil; choosing = true } label: { label(selected) }
                        .buttonStyle(.plain)
                        .disabled(model.busy == "switch")
                        .accessibilityLabel("Change shared card")
                        .accessibilityValue(selected.title)
                        .accessibilityIdentifier("grounding-room-card-picker")
                } else {
                    label(selected)
                        .accessibilityElement(children: .combine)
                }
            }
            .sheet(isPresented: $choosing) { picker }
        } else if let line = model.sharingLine(inRoom: code) {
            Text(line).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private func label(_ profile: CommonGroundProfileSummary) -> some View {
        HStack(spacing: 10) {
            CommonGroundSharedCardThumbnail(profile: profile, width: 48)
            VStack(alignment: .leading, spacing: 1) {
                Text("Sharing").font(.caption).foregroundStyle(.secondary)
                Text(profile.title).font(.subheadline.weight(.semibold)).lineLimit(1)
            }
            if canChange {
                if model.busy == "switch" {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
    }

    private var picker: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(model.shareChoices) { profile in
                        Button {
                            guard profile.profileId != selected?.profileId else {
                                choosing = false
                                return
                            }
                            Task {
                                if await model.switchRoomProfile(code, to: profile.profileId) {
                                    choosing = false
                                }
                            }
                        } label: {
                            HStack(spacing: 14) {
                                CommonGroundSharedCardThumbnail(profile: profile, width: 72)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(profile.title).font(.headline)
                                    if let focus = profile.focusLine {
                                        Text(focus).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                if profile.profileId == selected?.profileId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.tint)
                                }
                            }
                            .foregroundStyle(.primary)
                            .padding(12)
                            .frame(minHeight: 72)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                            .contentShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy == "switch")
                        .accessibilityAddTraits(profile.profileId == selected?.profileId ? .isSelected : [])
                    }
                    if let notice = model.notice {
                        Text(notice).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .padding(16)
            }
            .navigationTitle("Share a card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { choosing = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// The card's actual pattern, color and icon at thumbnail size.
private struct CommonGroundSharedCardThumbnail: View {
    let profile: CommonGroundProfileSummary
    let width: CGFloat
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            CommonGroundCardSurface(design: profile.cardDesign)
                .frame(width: 338, height: 213)
                .scaleEffect(width / 338)
                .frame(width: width, height: width * ProfileCardView.aspect)
            Image(systemName: profile.glyphSymbol)
                .font(.system(size: width * 0.27, weight: .medium))
                .foregroundStyle(profile.cardDesign.palette(scheme).accent)
        }
        .frame(width: width, height: width * ProfileCardView.aspect)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityHidden(true)
    }
}
