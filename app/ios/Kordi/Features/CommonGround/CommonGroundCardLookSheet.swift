import SwiftUI
import UIKit

/// An icon a card can carry instead of its design's glyph. The server keeps
/// the raw value; nil means the design's own glyph.
enum CommonGroundCardIcon: String, CaseIterable, Identifiable {
    case briefcase, leaf, sun, flask, book, microscope, graduation, pin, star
    case heart, chat, globe, music, camera, code, calendar, rocket, coffee

    var id: String { rawValue }

    /// SF Symbols to try in order; the last one is on every iOS 17 device.
    var symbols: [String] {
        switch self {
        case .briefcase: ["briefcase.fill"]
        case .leaf: ["leaf.fill"]
        case .sun: ["sun.max.fill"]
        case .flask: ["flask.fill", "testtube.2"]
        case .book: ["book.fill"]
        case .microscope: ["microscope", "magnifyingglass"]
        case .graduation: ["graduationcap.fill"]
        case .pin: ["mappin"]
        case .star: ["star.fill"]
        case .heart: ["heart.fill"]
        case .chat: ["bubble.left.fill"]
        case .globe: ["globe"]
        case .music: ["music.note"]
        case .camera: ["camera.fill"]
        case .code: ["chevron.left.forwardslash.chevron.right"]
        case .calendar: ["calendar"]
        case .rocket: ["rocket.fill", "paperplane.fill"]
        case .coffee: ["cup.and.saucer.fill"]
        }
    }

    /// The first of `symbols` this system draws.
    var symbol: String {
        symbols.first { UIImage(systemName: $0) != nil } ?? symbols[symbols.count - 1]
    }

    var title: String {
        switch self {
        case .pin: "Place"
        case .chat: "Chat"
        case .code: "Code"
        case .graduation: "Graduation"
        default: rawValue.capitalized
        }
    }
}

/// The card's look: its background and its icon. Opened from the card's
/// glyph; each tap applies at once.
struct CommonGroundCardLookSheet: View {
    let design: CommonGroundCardDesign
    let icon: CommonGroundCardIcon?
    /// The kind's design, whose glyph is the default under a colour.
    var kindDesign: CommonGroundCardDesign? = nil
    let onDesign: (CommonGroundCardDesign) -> Void
    /// nil goes back to the design's glyph.
    let onIcon: (CommonGroundCardIcon?) -> Void
    @Environment(\.colorScheme) private var scheme

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 6)
    private let swatchColumns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 8)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                label("Background")
                LazyVGrid(columns: swatchColumns, spacing: 10) {
                    ForEach(CommonGroundCardDesign.backgrounds) { option in
                        Button { onDesign(option) } label: {
                            colourDot(option)
                                .padding(3)
                                .overlay {
                                    if option == design { Circle().strokeBorder(Color.accentColor, lineWidth: 2) }
                                }
                                .frame(maxWidth: .infinity)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(option.title)
                        .accessibilityAddTraits(option == design ? .isSelected : [])
                    }
                }
                label("Icon")
                LazyVGrid(columns: columns, spacing: 8) {
                    iconCell(symbol: design.glyph(kind: kindDesign), selected: icon == nil, name: "Default") { onIcon(nil) }
                    ForEach(CommonGroundCardIcon.allCases) { option in
                        iconCell(symbol: option.symbol, selected: option == icon, name: option.title) { onIcon(option) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 18)
            .padding(.bottom, 8)
    }

    private func iconCell(symbol: String, selected: Bool, name: String, action: @escaping () -> Void) -> some View {
        let palette = design.palette(scheme)
        return Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(palette.accent)
                .frame(width: 42, height: 42)
                .background(
                    LinearGradient(colors: [palette.top, palette.bottom], startPoint: .top, endPoint: .bottom),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .padding(3)
                .overlay(ring(selected, cornerRadius: 14))
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// A plain round swatch in the design's base colour.
    private func colourDot(_ option: CommonGroundCardDesign) -> some View {
        Circle()
            .fill(option.baseColour)
            .overlay(Circle().strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
            .frame(width: 30, height: 30)
    }

    @ViewBuilder
    private func ring(_ shown: Bool, cornerRadius: CGFloat) -> some View {
        if shown {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.accentColor, lineWidth: 2)
        }
    }
}
