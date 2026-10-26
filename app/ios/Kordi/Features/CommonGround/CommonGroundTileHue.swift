import SwiftUI
import UIKit

/// The Grounding palette for row tiles, drawn in the tint style: the glyph
/// in its hue on a faint wash of the same hue, with no border. Pink belongs
/// to the Grounding entry; Tap is violet, Pair code cyan and Nearby amber.
enum CommonGroundTileHue: CaseIterable {
    case pink
    case violet
    case cyan
    case amber

    /// sRGB values per scheme: glyph light and dark, wash light and dark.
    private var rgb: (glyphLight: UInt32, glyphDark: UInt32, washLight: UInt32, washDark: UInt32) {
        switch self {
        case .pink: (0xBC3181, 0xFF8AD5, 0xE356A2, 0xF86AB5)
        case .violet: (0x6B62BF, 0xBBB6FF, 0x8A84E4, 0x9C96F8)
        case .cyan: (0x00829D, 0x54D8F4, 0x00A4C0, 0x26B7D3)
        case .amber: (0xA75D00, 0xFFB147, 0xCB7F00, 0xDF911A)
        }
    }

    /// The wash opacity over the group background.
    static let washOpacityLight: CGFloat = 0.16
    static let washOpacityDark: CGFloat = 0.20

    var glyph: Color {
        let rgb = rgb
        return Color(uiColor: UIColor { traits in
            Self.color(traits.userInterfaceStyle == .dark ? rgb.glyphDark : rgb.glyphLight, alpha: 1)
        })
    }

    var wash: Color {
        let rgb = rgb
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? Self.color(rgb.washDark, alpha: Self.washOpacityDark)
                : Self.color(rgb.washLight, alpha: Self.washOpacityLight)
        })
    }

    private static func color(_ hex: UInt32, alpha: CGFloat) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

/// A 30 pt row tile in the tint style, with an 8 pt continuous corner.
struct CommonGroundTile: View {
    let symbol: String
    let hue: CommonGroundTileHue

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(hue.glyph)
            .frame(width: 30, height: 30)
            .background(hue.wash, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityHidden(true)
    }
}
