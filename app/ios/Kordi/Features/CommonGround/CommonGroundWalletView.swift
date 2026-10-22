import SwiftUI

/// Home's profiles stacked like Apple Wallet, the shared card on top. Tap
/// the stack to fan the cards out, tap a card to share it, tap the shared
/// card again (or its "…") to turn it over. A dashed slot adds a card.
struct CommonGroundWallet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let cardWidth: CGFloat
    @Binding var fanned: Bool
    /// The card turned over in the detail, hidden here meanwhile.
    var hiddenID: String? = nil
    let onDetail: (String) -> Void
    let onBuild: () -> Void
    let onNewCard: () -> Void
    /// The top card's glyph opens its look.
    var onLook: ((String) -> Void)? = nil

    private let peek: CGFloat = 12
    private let strip: CGFloat = 54
    private let slotGap: CGFloat = 14
    private let slotHeight: CGFloat = 56

    private var cardHeight: CGFloat { cardWidth * ProfileCardView.aspect }

    var body: some View {
        let cards = model.walletCards
        let selected = cards.contains { $0.id == model.walletSelectedID } ? model.walletSelectedID : cards.first?.id
        let isFanned = fanned && cards.count > 1
        let places = layout(cards, selected: selected, fanned: isFanned)
        let bottom = places.bottom
        let showsSlot = model.canAddCard
        ZStack(alignment: .top) {
            ForEach(cards) { card in
                let place = places.items[card.id] ?? Place()
                cardView(card, selected: card.id == selected, fanned: isFanned)
                    .shadow(color: .black.opacity(card.id == selected && !isFanned ? 0.32 : 0.22), radius: card.id == selected ? 14 : 9, y: card.id == selected ? 12 : 8)
                    .scaleEffect(place.scale, anchor: .top)
                    .offset(y: place.y)
                    .zIndex(place.z)
                    .opacity(card.id == hiddenID ? 0 : place.opacity)
                    .onTapGesture { tap(card, selected: selected, count: cards.count) }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("\(card.name) card")
                    .accessibilityAddTraits(card.id == selected ? [.isButton, .isSelected] : .isButton)
            }
            if showsSlot {
                Button(action: onNewCard) {
                    Label("New card", systemImage: "plus")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: cardWidth, height: slotHeight)
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(Color(uiColor: .separator), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                        )
                        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
                .offset(y: bottom + slotGap)
            }
        }
        .frame(width: cardWidth, height: showsSlot ? bottom + slotGap + slotHeight : max(bottom, 0), alignment: .top)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: isFanned)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: selected)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: cards.map(\.id))
    }

    private func cardView(_ card: CommonGroundWalletCard, selected: Bool, fanned: Bool) -> some View {
        let trailing: ProfileCardView.Trailing = fanned
            ? (selected ? .check : .none)
            : (selected && card.hasCard && !card.isSuggested ? .more : .none)
        return ProfileCardView(
            design: card.design,
            icon: card.icon,
            kindDesign: card.kindDesign,
            name: card.name,
            focus: card.focus,
            bottom: bottom(for: card, selected: selected),
            trailing: trailing,
            showsMark: !(fanned && selected),
            width: cardWidth,
            onMore: { onDetail(card.id) },
            onBuild: onBuild,
            onGlyph: selected && card.hasLook && model.profilesEnabled ? onLook.map { look in { look(card.id) } } : nil
        )
    }

    private func bottom(for card: CommonGroundWalletCard, selected: Bool) -> ProfileCardView.Bottom {
        if selected && model.isBuilding { return .building }
        if card.isSuggested || !card.hasCard { return selected || card.isSuggested ? .build : .topics([]) }
        return .topics(card.topics)
    }

    private func tap(_ card: CommonGroundWalletCard, selected: String?, count: Int) {
        guard !card.isSuggested else { return }
        let motion: Animation? = reduceMotion ? nil : .easeOut(duration: 0.28)
        if !fanned || count < 2 {
            if count < 2 {
                if card.hasCard { onDetail(card.id) }
            } else {
                withAnimation(motion) { fanned = true }
            }
            return
        }
        withAnimation(motion) { fanned = false }
        if card.id == selected {
            if card.hasCard { onDetail(card.id) }
        } else {
            Task { await model.selectProfile(card.id) }
        }
    }

    // MARK: Layout

    private struct Place {
        var y: CGFloat = 0
        var scale: CGFloat = 1
        var z: Double = 0
        var opacity: Double = 1
    }

    /// Stacked: up to three cards peek above the selected one, each a
    /// little smaller. Fanned: every card shows a strip with its name.
    private func layout(_ cards: [CommonGroundWalletCard], selected: String?, fanned: Bool) -> (items: [String: Place], bottom: CGFloat) {
        var items: [String: Place] = [:]
        guard !cards.isEmpty else { return (items, -slotGap) }
        if fanned {
            for (index, card) in cards.enumerated() {
                items[card.id] = Place(y: CGFloat(index) * strip, z: Double(index + 1))
            }
            return (items, CGFloat(cards.count - 1) * strip + cardHeight)
        }
        let others = cards.filter { $0.id != selected }
        let back = min(others.count, 3)
        for (index, card) in others.enumerated() {
            let depth = others.count - index
            let shown = min(depth, back)
            items[card.id] = Place(
                y: CGFloat(back - shown) * peek,
                scale: 1 - CGFloat(shown) * 0.045,
                z: Double(20 - depth),
                opacity: depth > 3 ? 0 : 1
            )
        }
        if let selected { items[selected] = Place(y: CGFloat(back) * peek, z: 30) }
        return (items, CGFloat(back) * peek + cardHeight)
    }
}

/// "Sharing: Work" with the card's swatch, above the wallet.
struct CommonGroundSharingChip: View {
    let design: CommonGroundCardDesign
    let name: String

    var body: some View {
        HStack(spacing: 8) {
            CommonGroundCardSwatch(design: design, width: 20, height: 13, cornerRadius: 4)
            Text("Sharing: \(Text(name).fontWeight(.semibold))")
                .font(.system(size: 13.5, weight: .medium))
                .lineLimit(1)
        }
        .padding(.leading, 8)
        .padding(.trailing, 12)
        .frame(height: 30)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        .contentTransition(.opacity)
        .accessibilityElement(children: .combine)
    }
}
