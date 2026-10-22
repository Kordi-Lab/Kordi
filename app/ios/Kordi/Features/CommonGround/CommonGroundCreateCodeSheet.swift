import SwiftUI

/// Create a code: a meetup name and the card to share, then the new
/// four-digit code, large, with Share this code.
struct CommonGroundCreateCodeSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    /// The card picked first: the shared one, or the card being turned over.
    let initialProfileID: String?
    @State private var name = ""
    @State private var selected: String?
    @State private var created: CommonGroundRoom?
    @State private var error: String?
    @FocusState private var nameFocused: Bool

    private var choices: [CommonGroundProfileSummary] { model.shareChoices }
    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (!model.profilesEnabled || selected != nil)
            && model.busy != "create"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CommonGroundSheetHeader(title: created == nil ? "Create a code" : "Your code") { dismiss() }
            if let created {
                done(created)
            } else {
                form
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .onAppear {
            let start = initialProfileID ?? model.currentProfileID
            selected = choices.contains { $0.profileId == start } ? start : choices.first?.profileId
            nameFocused = true
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("Meetup name", text: $name)
                .font(.body)
                .focused($nameFocused)
                .submitLabel(.done)
                .onSubmit { if canCreate { Task { await create() } } }
                .padding(.horizontal, 16)
                .frame(height: 52)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            if model.profilesEnabled, !choices.isEmpty {
                Text("Share")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 18)
                    .padding(.bottom, 8)
                HStack(spacing: 10) {
                    ForEach(choices) { profile in swatch(profile) }
                    Text(model.profile(selected)?.title ?? "")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .padding(.leading, 4)
                }
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red).padding(.top, 10)
            }
            Button("Create") { Task { await create() } }
                .buttonStyle(CommonGroundPrimaryButtonStyle())
                .disabled(!canCreate)
                .padding(.top, 18)
        }
    }

    private func swatch(_ profile: CommonGroundProfileSummary) -> some View {
        let design = model.design(of: profile)
        let isSelected = profile.profileId == selected
        return Button { selected = profile.profileId } label: {
            CardSwatchGlyph(design: design)
                .padding(3)
                .overlay {
                    if isSelected {
                        RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(commonGroundTint, lineWidth: 2)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(profile.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func done(_ room: CommonGroundRoom) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ForEach(Array(room.code.enumerated()), id: \.offset) { _, digit in
                    Text(String(digit))
                        .font(.system(size: 34, weight: .bold).monospacedDigit())
                        .frame(width: 58, height: 66)
                        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
            .padding(.top, 12)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Code \(room.code.map(String.init).joined(separator: " "))")
            Text(room.title)
                .font(.headline)
                .padding(.top, 16)
            if let profile = model.profile(room.profileId ?? selected) {
                HStack(spacing: 6) {
                    CommonGroundCardSwatch(design: model.design(of: profile), width: 18, height: 12, cornerRadius: 3)
                    Text("Sharing \(profile.title)")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            }
            ShareLink(item: room.code, subject: Text(room.title), message: Text(room.title)) {
                Text("Share this code")
            }
            .buttonStyle(CommonGroundPrimaryButtonStyle())
            .padding(.top, 22)
        }
        .frame(maxWidth: .infinity)
    }

    private func create() async {
        error = nil
        nameFocused = false
        if let room = await model.createRoom(name: name, profileId: model.profilesEnabled ? selected : nil) {
            withAnimation(.easeOut(duration: 0.25)) { created = room }
        } else {
            // The sheet covers the toast, so the error shows here.
            error = model.notice
            model.notice = nil
        }
    }
}

/// A small card with its glyph, for picking a card in a row.
private struct CardSwatchGlyph: View {
    let design: CommonGroundCardDesign
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = design.palette(scheme)
        ZStack {
            CommonGroundCardSwatch(design: design, width: 42, height: 28, cornerRadius: 6)
            Image(systemName: design.symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(palette.accent)
        }
    }
}
