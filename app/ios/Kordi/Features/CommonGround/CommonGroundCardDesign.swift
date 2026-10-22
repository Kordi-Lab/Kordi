import SwiftUI

/// A card's look in the wallet. Work, Health and Daily tasks follow their
/// kind; a custom profile is drawn as a Workshop, Research group or Custom
/// card. The server stores each profile's design; a custom card without
/// one is guessed from its name. The ten colours are plain backgrounds any
/// card can take from its look sheet; they keep the kind's glyph.
enum CommonGroundCardDesign: String, CaseIterable, Identifiable {
    case work, health, daily, workshop, research, custom
    case ocean, sky, rose, coral, amber, forest, lavender, graphite, mint, olive

    var id: String { rawValue }

    /// The six designs a new card is made as.
    static let kinds: [CommonGroundCardDesign] = [.work, .health, .daily, .workshop, .research, .custom]
    /// The plain colours, chosen only from the look sheet.
    static let colours: [CommonGroundCardDesign] = [.ocean, .sky, .rose, .coral, .amber, .forest, .lavender, .graphite, .mint, .olive]

    /// The look sheet's sixteen swatches: the kinds, then the colours.
    static var backgrounds: [CommonGroundCardDesign] { kinds + colours }

    var isColour: Bool { colourHex != nil }

    /// The plain colour a design's swatch shows.
    var baseHex: UInt32 {
        switch self {
        case .work: 0x24335f
        case .health: 0x3f7d53
        case .daily: 0xd9c39a
        case .workshop: 0x4d5868
        case .research: 0xc4643f
        case .custom: 0x6c4377
        default: colourHex ?? 0x3b3f46
        }
    }

    /// A colour's base, tuned for white text.
    var colourHex: UInt32? {
        switch self {
        case .ocean: 0x0f6e73
        case .sky: 0x2a6fb8
        case .rose: 0xb33a63
        case .coral: 0xd8613f
        case .amber: 0xb97a12
        case .forest: 0x2f5e3a
        case .lavender: 0x6b5bb5
        case .graphite: 0x3b3f46
        case .mint: 0x2f8f7a
        case .olive: 0x6b6a2e
        default: nil
        }
    }

    /// Cards a wallet holds at most, as the server allows profiles.
    static let walletLimit = 5

    var title: String {
        switch self {
        case .work: "Work"
        case .health: "Health"
        case .daily: "Daily tasks"
        case .workshop: "Workshop"
        case .research: "Research group"
        case .custom: "Custom"
        default: rawValue.capitalized
        }
    }

    /// The design's glyph; a colour has none of its own and shows sparkles.
    var symbol: String {
        switch self {
        case .work: "briefcase"
        case .health: "leaf"
        case .daily: "checklist"
        case .workshop: "lanyardcard"
        case .research: "building.columns"
        default: "sparkles"
        }
    }

    /// The glyph a card draws without an icon: a colour takes its kind's.
    func glyph(kind: CommonGroundCardDesign?) -> String {
        isColour ? (kind ?? .custom).symbol : symbol
    }

    /// The server kind a card of this design is created with.
    var kind: CommonGroundProfileKind {
        switch self {
        case .work: .work
        case .health: .health
        case .daily: .daily
        default: .custom
        }
    }

    /// The name a new card of this design starts with; fixed kinds send none.
    var defaultName: String {
        switch self {
        case .workshop: "Workshop"
        case .research: "Research group"
        default: ""
        }
    }

    var namePlaceholder: String { self == .custom || isColour ? "Name" : title }

    /// The design for a profile: the server's design, else the kind's
    /// default, else for a custom card one guessed from the name.
    static func of(kind: String, name: String, design: String? = nil) -> CommonGroundCardDesign {
        if let design = design.flatMap(CommonGroundCardDesign.init(rawValue:)) { return design }
        switch CommonGroundProfileKind(rawValue: kind) {
        case .work?: return .work
        case .health?: return .health
        case .daily?: return .daily
        default: break
        }
        let text = name.lowercased()
        if ["workshop", "conference", "poster", "meetup", "summit"].contains(where: text.contains) { return .workshop }
        if ["research", "lab", "group", "university", "institute"].contains(where: text.contains) { return .research }
        return .custom
    }

    /// Work, Health and Daily tasks are in a wallet at most once; the
    /// other designs are custom profiles and can repeat.
    static func isAvailable(_ design: CommonGroundCardDesign, in profiles: [CommonGroundProfileSummary]) -> Bool {
        !design.kind.isFixed || !profiles.contains { $0.kind == design.kind.rawValue }
    }

    /// The first design the New card sheet opens on.
    static func firstAvailable(in profiles: [CommonGroundProfileSummary]) -> CommonGroundCardDesign {
        kinds.first { isAvailable($0, in: profiles) } ?? .workshop
    }
}

/// Designs earlier builds kept per profile on this device, before the
/// server stored them; read once to move them to the server, then dropped.
enum CommonGroundCardDesignStore {
    static func key(_ profileId: String) -> String { "commonGround.cardDesign.\(profileId)" }

    static func saved(_ profileId: String, defaults: UserDefaults) -> CommonGroundCardDesign? {
        defaults.string(forKey: key(profileId)).flatMap(CommonGroundCardDesign.init(rawValue:))
    }

    static func drop(_ profileId: String, defaults: UserDefaults) {
        defaults.removeObject(forKey: key(profileId))
    }
}

/// One design's colours: the gradient, text, pills, accent and edge.
struct CommonGroundCardPalette {
    let top: Color
    let bottom: Color
    let text: Color
    let secondary: Color
    let pill: Color
    let accent: Color
    let glyphFill: Color
    let edge: Color
    let danger: Color
}

/// Mixes a colour toward white (positive) or black (negative).
private func cgShade(_ hex: UInt32, _ amount: Double) -> UInt32 {
    func channel(_ shift: UInt32) -> UInt32 {
        let value = Double((hex >> shift) & 0xff)
        let mixed = amount >= 0 ? value + (255 - value) * amount : value * (1 + amount)
        return UInt32(max(0, min(255, mixed.rounded()))) << shift
    }
    return channel(16) | channel(8) | channel(0)
}

private func cgHex(_ hex: UInt32, _ alpha: Double = 1) -> Color {
    Color(
        .sRGB,
        red: Double((hex >> 16) & 0xff) / 255,
        green: Double((hex >> 8) & 0xff) / 255,
        blue: Double(hex & 0xff) / 255,
        opacity: alpha
    )
}

extension CommonGroundCardDesign {
    var baseColour: Color { cgHex(baseHex) }

    func palette(_ scheme: ColorScheme) -> CommonGroundCardPalette {
        let dark = scheme == .dark
        let white = Color.white
        func p(_ top: UInt32, _ bottom: UInt32, _ text: UInt32, _ secondary: Double, pill: Color,
               accent: UInt32, glyph: Color, edge: Color, danger: Color = cgHex(0xffb3ad)) -> CommonGroundCardPalette {
            CommonGroundCardPalette(
                top: cgHex(top), bottom: cgHex(bottom), text: cgHex(text), secondary: cgHex(text, secondary),
                pill: pill, accent: cgHex(accent), glyphFill: glyph, edge: edge, danger: danger
            )
        }
        if let base = colourHex {
            return p(cgShade(base, dark ? 0.2 : 0.1), cgShade(base, dark ? -0.2 : -0.3), 0xffffff, 0.74, pill: white.opacity(0.15),
                     accent: cgShade(base, 0.72), glyph: white.opacity(0.17), edge: white.opacity(dark ? 0.1 : 0.07))
        }
        switch self {
        case .work:
            return p(dark ? 0x1f2c52 : 0x24335f, dark ? 0x0a1024 : 0x0e1630, 0xeef2ff, 0.66, pill: white.opacity(0.1),
                     accent: 0x9db8ff, glyph: cgHex(0x9db8ff, 0.16), edge: white.opacity(dark ? 0.1 : 0.07))
        case .research:
            return p(dark ? 0xa8522f : 0xc4643f, dark ? 0x66251a : 0x8a3523, 0xfff6f0, 0.76, pill: white.opacity(0.17),
                     accent: 0xffd9c2, glyph: white.opacity(0.17), edge: dark ? white.opacity(0.08) : Color.black.opacity(0.06))
        case .health:
            return dark
                ? p(0x26412f, 0x142519, 0xd6eedb, 0.64, pill: cgHex(0xd6eedb, 0.1), accent: 0x7fd6a0,
                    glyph: cgHex(0x7fd6a0, 0.14), edge: white.opacity(0.08), danger: cgHex(0xff8a80))
                : p(0xe4f0e1, 0xc2dcc3, 0x1d3a27, 0.66, pill: cgHex(0x1d3a27, 0.09), accent: 0x2e7d4f,
                    glyph: cgHex(0x2e7d4f, 0.14), edge: cgHex(0x1d3a27, 0.13), danger: cgHex(0xc4271c))
        case .daily:
            return dark
                ? p(0x43392b, 0x29221a, 0xf2e5cc, 0.62, pill: cgHex(0xf2e5cc, 0.1), accent: 0xe9b866,
                    glyph: cgHex(0xe9b866, 0.14), edge: white.opacity(0.08), danger: cgHex(0xff8a80))
                : p(0xf7efdf, 0xe8d8ba, 0x3f311d, 0.64, pill: cgHex(0x3f311d, 0.08), accent: 0xa8741f,
                    glyph: cgHex(0xa8741f, 0.14), edge: cgHex(0x3f311d, 0.13), danger: cgHex(0xc4271c))
        case .workshop:
            return p(dark ? 0x3f4855 : 0x4d5868, dark ? 0x20262d : 0x2b323c, 0xf2f5f8, 0.7, pill: white.opacity(0.11),
                     accent: 0xf4b740, glyph: cgHex(0xf4b740, 0.17), edge: white.opacity(dark ? 0.09 : 0.07))
        case .custom:
            return p(dark ? 0x5a3762 : 0x6c4377, dark ? 0x2f1b35 : 0x3c2444, 0xf8eefb, 0.7, pill: white.opacity(0.12),
                     accent: 0xecc0f8, glyph: cgHex(0xecc0f8, 0.16), edge: white.opacity(dark ? 0.09 : 0.07))
        default:
            return p(0x3b3f46, 0x20242a, 0xffffff, 0.74, pill: white.opacity(0.15), accent: 0xd0d4da,
                     glyph: white.opacity(0.17), edge: white.opacity(0.08))
        }
    }
}

/// The card's face: the gradient, the design's pattern and a soft top sheen.
struct CommonGroundCardSurface: View {
    let design: CommonGroundCardDesign
    var cornerRadius: CGFloat = 18
    /// The back of the card runs its gradient a little steeper.
    var back = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = design.palette(scheme)
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        ZStack {
            LinearGradient(
                colors: [palette.top, palette.bottom],
                startPoint: back ? UnitPoint(x: 0.4, y: 0) : UnitPoint(x: 0.25, y: 0),
                endPoint: back ? UnitPoint(x: 0.6, y: 1) : UnitPoint(x: 0.75, y: 1)
            )
            CommonGroundCardPattern(design: design, palette: palette)
            LinearGradient(colors: [Color.white.opacity(0.1), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.34))
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(palette.edge, lineWidth: 0.5))
    }
}

/// Each design's texture, drawn with Canvas: a grid for Work, rings for
/// Health and Research, ruled lines for Daily tasks, stripes for Workshop
/// and dots for Custom.
struct CommonGroundCardPattern: View {
    let design: CommonGroundCardDesign
    let palette: CommonGroundCardPalette

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            switch design {
            case .work:
                grid(size)
            case .research:
                let center = CGPoint(x: size.width * 0.88, y: size.height * 0.08)
                ZStack {
                    RadialGradient(colors: [cgHexGlow, .clear], center: UnitPoint(x: 0.88, y: 0.08), startRadius: 0, endRadius: size.width * 0.42)
                    rings(center: center, step: 23, width: 1, color: .white.opacity(0.07), size: size)
                }
            case .health:
                rings(center: CGPoint(x: size.width * 1.04, y: size.height * 1.08), step: 16.5, width: 1.5,
                      color: palette.accent.opacity(0.12), size: size)
                    .mask(RadialGradient(colors: [.black, .black, .clear], center: .bottomTrailing,
                                         startRadius: 0, endRadius: size.width * 0.75))
            case .daily:
                Canvas { context, size in
                    var path = Path()
                    stride(from: 29, through: size.height, by: 22).forEach { path.addRect(CGRect(x: 0, y: $0, width: size.width, height: 1)) }
                    context.fill(path, with: .color(palette.text.opacity(0.07)))
                }
            case .workshop:
                Canvas { context, size in
                    // CSS `linear-gradient(112deg)` bands, drawn across the
                    // rotated box so their edges stay crisp.
                    let angle = Angle.degrees(112)
                    let dx = sin(angle.radians), dy = -cos(angle.radians)
                    let length = abs(size.width * dx) + abs(size.height * dy)
                    var rotated = context
                    rotated.translateBy(x: size.width / 2, y: size.height / 2)
                    rotated.rotate(by: .radians(atan2(dy, dx)))
                    func band(_ from: Double, _ to: Double, _ color: Color) {
                        let rect = CGRect(x: (from - 0.5) * length, y: -length, width: (to - from) * length, height: length * 2)
                        rotated.fill(Path(rect), with: .color(color))
                    }
                    band(0.71, 0.76, palette.accent)
                    band(0.79, 0.805, palette.accent.opacity(0.45))
                }
                .opacity(0.95)
                .mask(LinearGradient(stops: [.init(color: .black, location: 0.35), .init(color: .clear, location: 0.72)],
                                     startPoint: .top, endPoint: .bottom))
            case .custom:
                Canvas { context, size in
                    var path = Path()
                    for x in stride(from: 0, through: size.width, by: 14) {
                        for y in stride(from: 0, through: size.height, by: 14) {
                            path.addEllipse(in: CGRect(x: x - 1, y: y - 1, width: 2, height: 2))
                        }
                    }
                    context.fill(path, with: .color(.white.opacity(0.16)))
                }
                .mask(LinearGradient(colors: [.black, .clear], startPoint: UnitPoint(x: 0.7, y: 0), endPoint: UnitPoint(x: 0.2, y: 0.9)))
            default:
                // A colour: the subtle grid only.
                grid(size)
            }
        }
        .allowsHitTesting(false)
    }

    private var cgHexGlow: Color { cgHex(0xffd6b0, 0.42) }

    private func grid(_ size: CGSize) -> some View {
        Canvas { context, size in
            var path = Path()
            stride(from: -1, through: size.width, by: 18).forEach { path.addRect(CGRect(x: $0, y: 0, width: 1, height: size.height)) }
            stride(from: -1, through: size.height, by: 18).forEach { path.addRect(CGRect(x: 0, y: $0, width: size.width, height: 1)) }
            context.fill(path, with: .color(.white.opacity(0.055)))
        }
        .mask(RadialGradient(colors: [.black, .black, .clear], center: .topTrailing, startRadius: 0, endRadius: size.width * 1.1))
    }

    private func rings(center: CGPoint, step: CGFloat, width: CGFloat, color: Color, size: CGSize) -> some View {
        Canvas { context, size in
            let reach = hypot(max(center.x, size.width - center.x), max(center.y, size.height - center.y))
            var path = Path()
            for radius in stride(from: step, through: reach, by: step) {
                path.addEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            }
            context.stroke(path, with: .color(color), lineWidth: width)
        }
    }
}
