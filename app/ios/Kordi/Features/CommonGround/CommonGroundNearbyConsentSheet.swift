import SwiftUI

/// "Turn on Nearby?": consent, the card to share and whether alerts may
/// come in the background. Location access is asked for after it closes.
struct CommonGroundNearbyConsentSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.colorScheme) private var scheme
    /// Called once Nearby is on, with the choice of background alerts.
    let onTurnedOn: (Bool) -> Void
    @State private var selected: String?
    @State private var background = true
    @State private var error: String?

    private var choices: [CommonGroundProfileSummary] { model.shareChoices }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CommonGroundSheetHeader(title: "Turn on Nearby?") { dismiss() }
                Text("People nearby who turn this on see your card and a rough distance. You see theirs.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if !choices.isEmpty { cards }
                CommonGroundSection {
                    Toggle(isOn: $background) {
                        Text("Alerts in the background").font(.body)
                    }
                    .tint(chatTheme.accent)
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                }
                .padding(.top, 18)
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 10)
                }
                Button("Turn on") { Task { await turnOn() } }
                    .buttonStyle(CommonGroundPrimaryButtonStyle())
                    .disabled(model.busy == "nearby")
                    .padding(.top, 18)
                Button("Not now") { dismiss() }
                    .font(.body)
                    .foregroundStyle(chatTheme.accent)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.top, 4)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Color(uiColor: .systemGroupedBackground))
        .onAppear {
            let preferred = model.nearbyProfileID
            selected = choices.contains { $0.profileId == preferred } ? preferred : choices.first?.profileId
        }
    }

    /// Share: one swatch per card with its glyph, the chosen card's name beside them.
    private var cards: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Share")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                ForEach(choices) { profile in
                    let isSelected = profile.profileId == selected
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) { selected = profile.profileId }
                    } label: {
                        CommonGroundCardSwatch(design: profile.cardDesign, width: 42, height: 28, cornerRadius: 7)
                            .overlay {
                                Image(systemName: profile.glyphSymbol)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(profile.cardDesign.palette(scheme).accent)
                            }
                            .padding(3)
                            .overlay {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(isSelected ? chatTheme.accent : .clear, lineWidth: 2)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(profile.title)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
                Text(model.profile(selected)?.title ?? "")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .padding(.leading, 4)
            }
        }
        .padding(.top, 18)
    }

    private func turnOn() async {
        error = nil
        if await model.turnOnNearby(profileId: selected, backgroundAlerts: background) {
            onTurnedOn(background)
            dismiss()
        } else {
            // The sheet covers the toast, so the error shows here.
            error = model.notice
            model.notice = nil
        }
    }
}
