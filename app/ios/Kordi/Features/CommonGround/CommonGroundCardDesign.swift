import SwiftUI

/// A card's look in the wallet. Work, Health and Daily tasks follow their
/// kind; a custom profile is drawn as a Workshop, Research group or Custom
/// card. The server stores only the kind, so the design a custom card was
/// made with is kept on this device, and a custom card without one is
/// guessed from its name.
enum CommonGroundCardDesign: String, CaseIterable, Identifiable {
    case work, health, daily, workshop, research, custom

    var id: String { rawValue }

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
        }
    }

    var symbol: String {
        switch self {
        case .work: "briefcase"
        case .health: "leaf"
        case .daily: "checklist"
        case .workshop: "lanyardcard"
        case .research: "building.columns"
        case .custom: "sparkles"
        }
    }

    /// The server kind a card of this design is created with.
    var kind: CommonGroundProfileKind {
        switch self {
        case .work: .work
        case .health: .health
        case .daily: .daily
        case .workshop, .research, .custom: .custom
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

    var namePlaceholder: String { self == .custom ? "Name" : title }

    /// The design for a profile: its kind, else the design saved on this
    /// device, else one guessed from the name, else Custom.
    static func of(kind: String, name: String, saved: CommonGroundCardDesign? = nil) -> CommonGroundCardDesign {
        switch CommonGroundProfileKind(rawValue: kind) {
        case .work?: return .work
        case .health?: return .health
        case .daily?: return .daily
        default: break
        }
        if let saved, saved.kind == .custom { return saved }
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
        allCases.first { isAvailable($0, in: profiles) } ?? .workshop
    }
}

/// The design each custom profile was made with, per profile, on this device.
enum CommonGroundCardDesignStore {
    static func key(_ profileId: String) -> String { "commonGround.cardDesign.\(profileId)" }

    static func saved(_ profileId: String, defaults: UserDefaults) -> CommonGroundCardDesign? {
        defaults.string(forKey: key(profileId)).flatMap(CommonGroundCardDesign.init(rawValue:))
    }

    static func save(_ design: CommonGroundCardDesign?, profileId: String, defaults: UserDefaults) {
        if let design { defaults.set(design.rawValue, forKey: key(profileId)) } else { defaults.removeObject(forKey: key(profileId)) }
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
                Canvas { context, size in
                    var path = Path()
                    stride(from: -1, through: size.width, by: 18).forEach { path.addRect(CGRect(x: $0, y: 0, width: 1, height: size.height)) }
                    stride(from: -1, through: size.height, by: 18).forEach { path.addRect(CGRect(x: 0, y: $0, width: size.width, height: 1)) }
                    context.fill(path, with: .color(.white.opacity(0.055)))
                }
                .mask(RadialGradient(colors: [.black, .black, .clear], center: .topTrailing, startRadius: 0, endRadius: size.width * 1.1))
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
            }
        }
        .allowsHitTesting(false)
    }

    private var cgHexGlow: Color { cgHex(0xffd6b0, 0.42) }

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
