import SwiftUI

/// A profile drawn as a card in its design: the kind's glyph, the name, the
/// focus line, up to five topic chips and the Kordi bird. The New card
/// sheet passes bindings so the name and focus are typed on the card.
struct ProfileCardView: View {
    enum Trailing { case none, more, check, badge(String) }
    enum Bottom { case topics([String]), build, building, skeleton }

    /// Credit-card proportions, as in the wallet.
    static let aspect: CGFloat = 213 / 338

    /// The wallet's card width for a container: 26 pt clear on each side.
    static func width(in container: CGFloat) -> CGFloat { min(max(container - 52, 240), 380) }

    let design: CommonGroundCardDesign
    /// The chosen icon; nil draws the design's glyph.
    var icon: CommonGroundCardIcon? = nil
    /// The kind's design, whose glyph a colour design draws.
    var kindDesign: CommonGroundCardDesign? = nil
    var name: String
    var focus: String? = nil
    var bottom: Bottom = .topics([])
    var trailing: Trailing = .none
    var showsMark = true
    var width: CGFloat = 338
    var onMore: (() -> Void)? = nil
    var onBuild: (() -> Void)? = nil
    /// Tapping the glyph opens the card's look.
    var onGlyph: (() -> Void)? = nil
    var nameField: Binding<String>? = nil
    var focusField: Binding<String>? = nil
    var fieldsDisabled = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = design.palette(scheme)
        ZStack(alignment: .topLeading) {
            CommonGroundCardSurface(design: design)
            VStack(alignment: .leading, spacing: 0) {
                head(palette)
                focusLine(palette)
                Spacer(minLength: 0)
            }
            bottomArea(palette)
                .padding(.leading, 16)
                .padding(.trailing, 46)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            if showsMark {
                KordiMark(size: 24, tint: KordiBirdTint(body: palette.text, beak: KordiTheme.brandAmber))
                    .opacity(0.82)
                    .padding(.trailing, 14)
                    .padding(.bottom, 15)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .foregroundStyle(palette.text)
        .frame(width: width, height: width * Self.aspect)
        .accessibilityElement(children: .contain)
    }

    private func head(_ palette: CommonGroundCardPalette) -> some View {
        HStack(spacing: 10) {
            CommonGroundCardGlyph(design: design, palette: palette, icon: icon, kindDesign: kindDesign, onTap: onGlyph)
            if let nameField {
                TextField("", text: nameField, prompt: Text(design.namePlaceholder).foregroundStyle(palette.text.opacity(0.45)))
                    .font(.system(size: 18, weight: .semibold))
                    .disabled(fieldsDisabled)
                    .submitLabel(.next)
                    .accessibilityLabel("Name")
            } else {
                Text(name)
                    .font(.system(size: 18, weight: .semibold))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            trailingView(palette)
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .frame(height: 60)
    }

    @ViewBuilder
    private func trailingView(_ palette: CommonGroundCardPalette) -> some View {
        switch trailing {
        case .none:
            EmptyView()
        case .more:
            Button { onMore?() } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 30, height: 30)
                    .background(palette.pill, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Card details")
        case .check:
            Image(systemName: "checkmark")
                .font(.system(size: 13, weight: .heavy))
                .foregroundStyle(palette.bottom)
                .frame(width: 30, height: 30)
                .background(palette.accent, in: Circle())
                .accessibilityLabel("Sharing")
        case .badge(let text):
            Text(text)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 9)
                .frame(height: 24)
                .background(palette.pill, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .fixedSize()
        }
    }

    @ViewBuilder
    private func focusLine(_ palette: CommonGroundCardPalette) -> some View {
        Group {
            if let focusField {
                TextField("", text: focusField, prompt: Text("Focus").foregroundStyle(palette.text.opacity(0.45)))
                    .disabled(fieldsDisabled)
                    .accessibilityLabel("Focus")
            } else if let focus, !focus.isEmpty {
                Text(focus).lineLimit(1)
            }
        }
        .font(.system(size: 14))
        .foregroundStyle(palette.secondary)
        .padding(.horizontal, 16)
        .padding(.top, -4)
    }

    @ViewBuilder
    private func bottomArea(_ palette: CommonGroundCardPalette) -> some View {
        switch bottom {
        case .topics(let topics):
            FlowLayout(spacing: 6) {
                ForEach(Array(topics.prefix(5)), id: \.self) { topic in
                    Text(topic)
                        .font(.system(size: 12.5, weight: .medium))
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .frame(height: 26)
                        .background(palette.pill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            .frame(maxHeight: 90, alignment: .bottomLeading)
            .clipped()
        case .build:
            Button { onBuild?() } label: {
                Text("Build")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.bottom)
                    .padding(.horizontal, 16)
                    .frame(height: 32)
                    .background(palette.text, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        case .building:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(palette.text)
                Text("Building").font(.system(size: 14, weight: .semibold))
            }
            .padding(.horizontal, 16)
            .frame(height: 32)
            .background(palette.pill, in: Capsule())
        case .skeleton:
            HStack(spacing: 6) {
                ForEach([70, 96, 58], id: \.self) { width in
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(palette.pill)
                        .frame(width: CGFloat(width), height: 26)
                        .opacity(0.75)
                }
            }
            .accessibilityHidden(true)
        }
    }
}

/// The card's icon, else the design's glyph, on a tinted rounded tile; a
/// button that opens the card's look when `onTap` is set.
struct CommonGroundCardGlyph: View {
    let design: CommonGroundCardDesign
    let palette: CommonGroundCardPalette
    var icon: CommonGroundCardIcon? = nil
    var kindDesign: CommonGroundCardDesign? = nil
    var size: CGFloat = 32
    var onTap: (() -> Void)? = nil

    var body: some View {
        if let onTap {
            Button(action: onTap) { tile.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel("Card look")
        } else {
            tile.accessibilityHidden(true)
        }
    }

    private var tile: some View {
        Image(systemName: icon?.symbol ?? design.glyph(kind: kindDesign))
            .font(.system(size: size * 0.53, weight: .medium))
            .foregroundStyle(palette.accent)
            .frame(width: size, height: size)
            .background(palette.glyphFill, in: RoundedRectangle(cornerRadius: size * 0.31, style: .continuous))
    }
}

/// A small card swatch: the gradient with its edge, for chips and rows.
struct CommonGroundCardSwatch: View {
    let design: CommonGroundCardDesign
    var width: CGFloat = 30
    var height: CGFloat = 20
    var cornerRadius: CGFloat = 5
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = design.palette(scheme)
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(LinearGradient(colors: [palette.top, palette.bottom], startPoint: UnitPoint(x: 0.25, y: 0), endPoint: UnitPoint(x: 0.75, y: 1)))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(palette.edge, lineWidth: 0.5))
            .frame(width: width, height: height)
            .shadow(color: .black.opacity(0.12), radius: 1, y: 1)
            .accessibilityHidden(true)
    }
}
