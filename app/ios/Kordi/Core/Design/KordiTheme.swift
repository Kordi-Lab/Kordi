import SwiftUI

enum KordiTheme {
    static let signalBlue = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let agentViolet = Color(red: 132 / 255, green: 122 / 255, blue: 196 / 255)
    static let agentMention = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 96 / 255, green: 165 / 255, blue: 250 / 255, alpha: 1)
                : UIColor(red: 37 / 255, green: 99 / 255, blue: 235 / 255, alpha: 1)
        }
    )
    static let personMention = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 80 / 255, green: 210 / 255, blue: 154 / 255, alpha: 1)
                : UIColor(red: 28 / 255, green: 122 / 255, blue: 82 / 255, alpha: 1)
        }
    )
    static let brandPink = Color(red: 248 / 255, green: 62 / 255, blue: 156 / 255)
    static let brandCyan = Color(red: 39 / 255, green: 185 / 255, blue: 209 / 255)
    static let brandAmber = Color(red: 252 / 255, green: 181 / 255, blue: 38 / 255)
    static let loginPrimaryFill = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 0.96, alpha: 1)
                : UIColor(red: 22 / 255, green: 24 / 255, blue: 29 / 255, alpha: 1)
        }
    )
    static let loginPrimaryText = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 22 / 255, green: 24 / 255, blue: 29 / 255, alpha: 1)
                : UIColor(white: 0.98, alpha: 1)
        }
    )
    fileprivate static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(
            uiColor: UIColor { traits in
                uiColor(traits.userInterfaceStyle == .dark ? dark : light)
            }
        )
    }

    private static func uiColor(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }
}

enum KordiChatTheme: String, CaseIterable, Identifiable {
    case quiet
    case midnight
    case sand
    case ocean

    static let storageKey = "kordi.chatTheme.v1"
    static let ownMetadataOpacity = 0.88
    static let otherMetadataOpacity = 0.68

    var id: String { rawValue }

    var label: String {
        switch self {
        case .quiet: "Quiet Signal"
        case .midnight: "Midnight Violet"
        case .sand: "Warm Sand"
        case .ocean: "Ocean Slate"
        }
    }

    var detail: String {
        switch self {
        case .quiet: "Calm neutrals with restrained blue signals."
        case .midnight: "Deep violet surfaces with a subtle star field."
        case .sand: "Low-glare earth tones with warm message color."
        case .ocean: "Cool mineral surfaces with a quiet ripple pattern."
        }
    }

    var systemImage: String {
        switch self {
        case .quiet: "message.fill"
        case .midnight: "moon.stars.fill"
        case .sand: "sun.haze.fill"
        case .ocean: "water.waves"
        }
    }

    var canvas: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0xF4F5F7, dark: 0x0F1115)
        case .midnight: KordiTheme.adaptive(light: 0xF1EFF8, dark: 0x100F18)
        case .sand: KordiTheme.adaptive(light: 0xF2EBDD, dark: 0x181411)
        case .ocean: KordiTheme.adaptive(light: 0xE8F0EF, dark: 0x0D1719)
        }
    }

    var ownBubble: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0xE2EBF5, dark: 0x2D425B)
        case .midnight: KordiTheme.adaptive(light: 0x6652A3, dark: 0x6554A2)
        case .sand: KordiTheme.adaptive(light: 0x9D572F, dark: 0x9A5734)
        case .ocean: KordiTheme.adaptive(light: 0x2E6F7A, dark: 0x2D6872)
        }
    }

    var ownText: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0x1F3145, dark: 0xF5F8FC)
        case .midnight, .sand, .ocean: .white
        }
    }

    var peerBubble: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0xFFFFFF, dark: 0x20242C)
        case .midnight: KordiTheme.adaptive(light: 0xFCFAFF, dark: 0x242032)
        case .sand: KordiTheme.adaptive(light: 0xFFF9F0, dark: 0x2A221C)
        case .ocean: KordiTheme.adaptive(light: 0xF8FBFB, dark: 0x1B2D30)
        }
    }

    var peerText: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0x111827, dark: 0xF8FAFC)
        case .midnight: KordiTheme.adaptive(light: 0x221D30, dark: 0xF8F6FC)
        case .sand: KordiTheme.adaptive(light: 0x2D2118, dark: 0xFBF6EF)
        case .ocean: KordiTheme.adaptive(light: 0x17272A, dark: 0xF3FAFA)
        }
    }

    var agentBubble: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0xEEEAF8, dark: 0x262238)
        case .midnight: KordiTheme.adaptive(light: 0xE8E0F4, dark: 0x2A2340)
        case .sand: KordiTheme.adaptive(light: 0xECE6F3, dark: 0x2D2533)
        case .ocean: KordiTheme.adaptive(light: 0xE5E5F2, dark: 0x222B3B)
        }
    }

    var accent: Color {
        switch self {
        case .quiet: KordiTheme.adaptive(light: 0x2563EB, dark: 0x60A5FA)
        case .midnight: KordiTheme.adaptive(light: 0x6D5CB2, dark: 0xAFA3E9)
        case .sand: KordiTheme.adaptive(light: 0xA75C33, dark: 0xDE9968)
        case .ocean: KordiTheme.adaptive(light: 0x236979, dark: 0x68C7CA)
        }
    }

    var patternColor: Color {
        let opacity = switch self {
        case .quiet: 0.055
        case .midnight: 0.14
        case .sand: 0.08
        case .ocean: 0.045
        }
        return accent.opacity(opacity)
    }

    var usesLightOwnTextInLightAppearance: Bool {
        self != .quiet
    }
}

extension EnvironmentValues {
    @Entry var kordiChatTheme: KordiChatTheme = .quiet
}

struct KordiChatWallpaper: View {
    let theme: KordiChatTheme

    var body: some View {
        theme.canvas
            .overlay {
                Canvas { context, size in
                    switch theme {
                    case .quiet:
                        drawDots(in: &context, size: size, spacing: 18, radius: 0.65)
                    case .midnight:
                        drawDots(in: &context, size: size, spacing: 54, radius: 0.9)
                        drawDots(in: &context, size: size, spacing: 86, radius: 0.65, offset: 27)
                    case .sand:
                        drawDots(in: &context, size: size, spacing: 16, radius: 0.7)
                        drawDots(in: &context, size: size, spacing: 16, radius: 0.45, offset: 8)
                    case .ocean:
                        drawRipples(in: &context, size: size)
                    }
                }
                .accessibilityHidden(true)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func drawDots(
        in context: inout GraphicsContext,
        size: CGSize,
        spacing: CGFloat,
        radius: CGFloat,
        offset: CGFloat = 1
    ) {
        for y in stride(from: offset, through: size.height, by: spacing) {
            for x in stride(from: offset, through: size.width, by: spacing) {
                context.fill(
                    Path(
                        ellipseIn: CGRect(
                            x: x - radius,
                            y: y - radius,
                            width: radius * 2,
                            height: radius * 2
                        )
                    ),
                    with: .color(theme.patternColor)
                )
            }
        }
    }

    private func drawRipples(in context: inout GraphicsContext, size: CGSize) {
        for y in stride(from: CGFloat(-70), through: size.height + 110, by: 110) {
            for x in stride(from: CGFloat(-70), through: size.width + 110, by: 110) {
                var path = Path()
                path.addArc(
                    center: CGPoint(x: x, y: y),
                    radius: 38,
                    startAngle: .degrees(270),
                    endAngle: .degrees(360),
                    clockwise: false
                )
                context.stroke(path, with: .color(theme.patternColor), lineWidth: 0.8)
            }
        }
    }
}

extension View {
    func kordiListRow() -> some View {
        modifier(KordiListRowModifier())
    }
}

struct KordiPullDownSearchField: View {
    @Binding var text: String
    let prompt: String
    let accessibilityLabel: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            TextField(prompt, text: $text)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .frame(width: 40, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, 13)
        .padding(.trailing, text.isEmpty ? 13 : 4)
        .frame(minHeight: 44)
        .background(
            Color(uiColor: .tertiarySystemFill),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

struct KordiPageSearchHeader<Controls: View>: View {
    @Binding var text: String
    let prompt: String
    let accessibilityLabel: String
    private let controls: Controls

    init(
        text: Binding<String>,
        prompt: String,
        accessibilityLabel: String,
        @ViewBuilder controls: () -> Controls
    ) {
        _text = text
        self.prompt = prompt
        self.accessibilityLabel = accessibilityLabel
        self.controls = controls()
    }

    var body: some View {
        VStack(spacing: 10) {
            KordiPullDownSearchField(
                text: $text,
                prompt: prompt,
                accessibilityLabel: accessibilityLabel
            )

            controls
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .overlay(alignment: .bottom) {
            Divider()
        }
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .contain)
    }
}

private struct KordiListRowModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let verticalInset: CGFloat = dynamicTypeSize.isAccessibilitySize ? 8 : 4
        content
            .listRowInsets(EdgeInsets(top: verticalInset, leading: 16, bottom: verticalInset, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparatorTint(Color(uiColor: .separator).opacity(0.55))
    }
}
