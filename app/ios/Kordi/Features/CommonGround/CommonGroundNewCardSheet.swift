import SwiftUI

/// New card: swipe through the six designs, type the name and focus on the
/// card, Create. Work, Health and Daily already in the wallet show
/// "In your wallet" and cannot be made again.
struct CommonGroundNewCardSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let cardWidth: CGFloat
    @State private var selection: String?
    @State private var names: [CommonGroundCardDesign: String] = [:]
    @State private var focuses: [CommonGroundCardDesign: String] = [:]
    @State private var error: String?
    /// The background and icon chosen from the glyph, per design.
    @State private var looks: [CommonGroundCardDesign: CommonGroundCardDesign] = [:]
    @State private var icons: [CommonGroundCardDesign: CommonGroundCardIcon] = [:]
    @State private var lookFor: CommonGroundCardDesign?

    private var design: CommonGroundCardDesign {
        selection.flatMap(CommonGroundCardDesign.init(rawValue:)) ?? .work
    }

    private func available(_ design: CommonGroundCardDesign) -> Bool {
        CommonGroundCardDesign.isAvailable(design, in: model.profiles)
    }

    private var canCreate: Bool {
        guard available(design), model.busy != "profile" else { return false }
        return design.kind.isFixed || !(names[design] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CommonGroundSheetHeader(title: "New card") { dismiss() }
            CommonGroundCardCarousel(
                ids: CommonGroundCardDesign.kinds.map(\.rawValue),
                selection: $selection,
                cardWidth: cardWidth,
                zoom: 0.86,
                caption: design.title
            ) { id in
                editableCard(CommonGroundCardDesign(rawValue: id) ?? .work)
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity).padding(.bottom, 8)
            }
            Button("Create") { Task { await create() } }
                .buttonStyle(CommonGroundPrimaryButtonStyle())
                .disabled(!canCreate)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .onAppear {
            for option in CommonGroundCardDesign.kinds { names[option] = option.defaultName }
            selection = CommonGroundCardDesign.firstAvailable(in: model.profiles).rawValue
        }
        .sheet(item: $lookFor) { option in
            CommonGroundCardLookSheet(
                design: looks[option] ?? option,
                icon: icons[option],
                kindDesign: option,
                onDesign: { looks[option] = $0 },
                onIcon: { icons[option] = $0 }
            )
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
    }

    private func editableCard(_ option: CommonGroundCardDesign) -> some View {
        let open = available(option)
        let editing = option.rawValue == selection && open
        return ProfileCardView(
            design: looks[option] ?? option,
            icon: icons[option],
            kindDesign: option,
            name: option.title,
            bottom: .skeleton,
            trailing: open ? .none : .badge("In your wallet"),
            width: cardWidth,
            onGlyph: editing ? { lookFor = option } : nil,
            nameField: option.kind.isFixed ? nil : nameBinding(option),
            focusField: focusBinding(option),
            fieldsDisabled: !editing
        )
    }

    private func nameBinding(_ option: CommonGroundCardDesign) -> Binding<String> {
        Binding(get: { names[option] ?? "" }, set: { names[option] = String($0.prefix(40)) })
    }

    private func focusBinding(_ option: CommonGroundCardDesign) -> Binding<String> {
        Binding(get: { focuses[option] ?? "" }, set: { focuses[option] = String($0.prefix(200)) })
    }

    private func create() async {
        guard canCreate else { return }
        error = nil
        let chosen = design
        let created = await model.createCard(chosen, name: names[chosen] ?? "", focus: focuses[chosen] ?? "",
                                             look: looks[chosen], icon: icons[chosen])
        if created != nil {
            dismiss()
        } else {
            // The sheet covers the toast, so the error shows here.
            error = model.notice
            model.notice = nil
        }
    }
}
