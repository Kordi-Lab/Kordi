import SwiftUI
import UIKit

/// Resolves the stored appearance preferences the Appearance screen edits.
enum AppearanceSettingsSelection {
    static func chatTheme(_ rawValue: String) -> KordiChatTheme {
        KordiChatTheme(rawValue: rawValue) ?? .classic
    }

    static func colorMode(_ rawValue: String) -> AppAppearance {
        AppAppearance(rawValue: rawValue) ?? .system
    }

    static func preferredColorScheme(_ rawValue: String) -> ColorScheme? {
        switch colorMode(rawValue) {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    static func messageLayout(_ rawValue: String) -> MessageLayout {
        MessageLayout.resolve(rawValue)
    }

    /// Accessibility identifiers of every option on the screen, in display order.
    static var optionIdentifiers: [String] {
        KordiChatTheme.allCases.map { optionIdentifier($0.rawValue) }
            + MessageLayout.allCases.map { optionIdentifier($0.rawValue) }
            + AppAppearance.allCases.map { optionIdentifier($0.rawValue) }
    }

    static func appIconIdentifier(_ key: String) -> String {
        "appearance-app-icon-\(key)"
    }

    static func optionIdentifier(_ rawValue: String) -> String {
        "appearance-option-\(rawValue)"
    }
}

/// Chat theme, message display, color mode, and app icon on one screen.
struct AppearanceSettingsView: View {
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @AppStorage(MessageLayout.storageKey) private var messageLayoutRawValue = MessageLayout.chat.rawValue
    @AppStorage(KordiChatTheme.storageKey) private var chatThemeRawValue = KordiChatTheme.classic.rawValue
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selectedAppIcon = KordiAppIcon.primary
    @State private var supportsAppIcons = false

    private var selectedChatTheme: KordiChatTheme { AppearanceSettingsSelection.chatTheme(chatThemeRawValue) }
    private var selectedLayout: MessageLayout { AppearanceSettingsSelection.messageLayout(messageLayoutRawValue) }
    private var selectedAppearance: AppAppearance { AppearanceSettingsSelection.colorMode(appearanceRawValue) }

    var body: some View {
        SettingsPage {
            HStack(alignment: .firstTextBaseline) {
                SettingsSectionTitle("Chat theme")
                Spacer(minLength: 8)
                Text(selectedChatTheme.label)
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityHidden(true)
            }
            HStack(spacing: 4) {
                ForEach(KordiChatTheme.allCases) { theme in
                    ChatThemeDot(theme: theme, isSelected: theme == selectedChatTheme) {
                        select { chatThemeRawValue = theme.rawValue }
                    }
                }
            }
            // The 44 pt tap targets centre each 34 pt dot; keep the dots flush with the title.
            .padding(.leading, -5)
            .padding(.top, 2)
            SettingsDivider()

            SettingsSectionTitle("Message display")
            HStack(alignment: .top, spacing: 10) {
                ForEach(MessageLayout.allCases) { layout in
                    AppearanceOptionCard(
                        title: layout.title,
                        identifier: layout.rawValue,
                        isSelected: layout == selectedLayout,
                        action: { select { messageLayoutRawValue = layout.rawValue } },
                        preview: { MessageLayoutExample(layout: layout) }
                    )
                }
            }
            .padding(.top, 4)
            SettingsDivider()

            SettingsSectionTitle("Color mode")
            HStack(alignment: .top, spacing: 10) {
                ForEach(AppAppearance.allCases) { appearance in
                    AppearanceOptionCard(
                        title: appearance.label,
                        identifier: appearance.rawValue,
                        isSelected: appearance == selectedAppearance,
                        action: { select { appearanceRawValue = appearance.rawValue } },
                        preview: { ColorModeExample(appearance: appearance) }
                    )
                }
            }
            .padding(.top, 4)

            if supportsAppIcons {
                SettingsDivider()

                SettingsSectionTitle("App icon")
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: AppIconThumbnail.size, maximum: AppIconThumbnail.size + 16), spacing: 12)],
                    alignment: .leading,
                    spacing: 14
                ) {
                    ForEach(KordiAppIcon.all) { icon in
                        AppIconThumbnail(icon: icon, isSelected: icon == selectedAppIcon) {
                            selectAppIcon(icon)
                        }
                    }
                }
                .padding(.top, 4)
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.selection, trigger: appearanceRawValue + ":" + messageLayoutRawValue + ":" + chatThemeRawValue)
        .sensoryFeedback(.selection, trigger: selectedAppIcon)
        .onAppear {
            supportsAppIcons = AppIconSettings.isSupported
            selectedAppIcon = AppIconSettings.current
        }
    }

    private func selectAppIcon(_ icon: KordiAppIcon) {
        guard icon != selectedAppIcon else { return }
        select { selectedAppIcon = icon }
        Task { @MainActor in
            let applied = await AppIconSettings.select(icon)
            if applied != selectedAppIcon {
                select { selectedAppIcon = applied }
            }
        }
    }

    private func select(_ change: () -> Void) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18), change)
    }
}

/// Round swatch: the theme's chat background top left, its outgoing bubble bottom right.
private struct ChatThemeDot: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let theme: KordiChatTheme
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: theme.canvas, location: 0),
                            .init(color: theme.canvas, location: 0.5),
                            .init(color: theme.ownBubble, location: 0.5),
                            .init(color: theme.ownBubble, location: 1),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay { Circle().strokeBorder(AppearanceExampleColors.hairline, lineWidth: 1) }
                .frame(width: 34, height: 34)
                .padding(2)
                .overlay {
                    if isSelected {
                        Circle().strokeBorder(chatTheme.accent, lineWidth: 2).padding(-2)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(theme.label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(AppearanceSettingsSelection.optionIdentifier(theme.rawValue))
    }
}

/// Rounded-square home screen icon thumbnail.
private struct AppIconThumbnail: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    static let size: CGFloat = 58

    let icon: KordiAppIcon
    let isSelected: Bool
    let action: () -> Void

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Self.size * 0.2237, style: .continuous)
    }

    var body: some View {
        Button(action: action) {
            Image(icon.previewImageName)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fill)
                .frame(width: Self.size, height: Self.size)
                .clipShape(shape)
                .overlay { shape.strokeBorder(AppearanceExampleColors.hairline, lineWidth: 1) }
                .padding(3)
                .overlay {
                    if isSelected {
                        RoundedRectangle(cornerRadius: Self.size * 0.2237 + 3, style: .continuous)
                            .strokeBorder(chatTheme.accent, lineWidth: 2)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 16, height: 16)
                            .background(chatTheme.accent, in: Circle())
                            .offset(x: 2, y: -2)
                    }
                }
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(icon.displayName)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(AppearanceSettingsSelection.appIconIdentifier(icon.key))
    }
}

/// Example card with the option name under it.
private struct AppearanceOptionCard<Preview: View>: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let title: String
    let identifier: String
    let isSelected: Bool
    let action: () -> Void
    @ViewBuilder let preview: () -> Preview

    private let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                preview()
                    .frame(maxWidth: .infinity)
                    .frame(height: 62)
                    .clipShape(shape)
                    .overlay {
                        shape.strokeBorder(
                            isSelected ? chatTheme.accent : AppearanceExampleColors.hairline,
                            lineWidth: isSelected ? 2 : 1
                        )
                    }
                    .overlay(alignment: .topTrailing) {
                        if isSelected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 16, height: 16)
                                .background(chatTheme.accent, in: Circle())
                                .padding(5)
                        }
                    }
                Text(title)
                    .font(SettingsFont.subtitle.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? .primary : .secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(AppearanceSettingsSelection.optionIdentifier(identifier))
    }
}

/// Short example of a message layout that fills its card.
private struct MessageLayoutExample: View {
    let layout: MessageLayout

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            VStack(spacing: 0) {
                switch layout {
                case .chat:
                    bubble(AppearanceExampleColors.incoming, width: width * 0.62, alignment: .leading)
                    Spacer(minLength: 0)
                    bubble(KordiTheme.signalBlue, width: width * 0.70, alignment: .trailing)
                    Spacer(minLength: 0)
                    bubble(AppearanceExampleColors.incoming, width: width * 0.46, alignment: .leading)
                case .threads:
                    threadRow(avatar: KordiTheme.brandPink, textFraction: 0.88)
                    Spacer(minLength: 0)
                    threadRow(avatar: KordiTheme.brandCyan, textFraction: 0.70)
                }
            }
            .frame(width: width, height: proxy.size.height)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 8)
        .background(KordiChatTheme.classic.canvas)
    }

    private func bubble(_ color: Color, width: CGFloat, alignment: Alignment) -> some View {
        Capsule()
            .fill(color)
            .frame(width: width, height: 9)
            .frame(maxWidth: .infinity, alignment: alignment)
    }

    private func threadRow(avatar: Color, textFraction: CGFloat) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(avatar)
                .frame(width: 11, height: 11)
            GeometryReader { proxy in
                VStack(alignment: .leading, spacing: 3) {
                    Capsule()
                        .fill(AppearanceExampleColors.nameLine)
                        .frame(width: proxy.size.width * 0.4, height: 4)
                    Capsule()
                        .fill(AppearanceExampleColors.textLine)
                        .frame(width: proxy.size.width * textFraction, height: 4)
                }
            }
            .frame(height: 11)
        }
    }
}

/// Fixed light, fixed dark, or split light and dark for System.
private struct ColorModeExample: View {
    let appearance: AppAppearance

    var body: some View {
        switch appearance {
        case .light:
            canvas(.light)
        case .dark:
            canvas(.dark)
        case .system:
            canvas(.light)
                .overlay {
                    canvas(.dark)
                        .mask {
                            HStack(spacing: 0) {
                                Color.clear
                                Color.black
                            }
                        }
                }
        }
    }

    private func canvas(_ scheme: ColorScheme) -> some View {
        let isDark = scheme == .dark
        let incoming = isDark ? Color(exampleHex: 0x2B3037) : Color(exampleHex: 0xD9DCE1)
        return GeometryReader { proxy in
            let width = proxy.size.width
            VStack(spacing: 0) {
                bubble(incoming, width: width * 0.62, alignment: .leading)
                Spacer(minLength: 0)
                bubble(KordiTheme.signalBlue, width: width * 0.70, alignment: .trailing)
                Spacer(minLength: 0)
                bubble(incoming, width: width * 0.46, alignment: .leading)
            }
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 8)
        .background(isDark ? Color(exampleHex: 0x0F1115) : Color(exampleHex: 0xF2F3F5))
    }

    private func bubble(_ color: Color, width: CGFloat, alignment: Alignment) -> some View {
        Capsule()
            .fill(color)
            .frame(width: width, height: 9)
            .frame(maxWidth: .infinity, alignment: alignment)
    }
}

private enum AppearanceExampleColors {
    static let hairline = Color.primary.opacity(0.1)
    static let incoming = adaptive(light: 0xE9EBEE, dark: 0x23272E)
    static let nameLine = adaptive(light: 0xA9AEB6, dark: 0x5A606A)
    static let textLine = adaptive(light: 0xD5D8DD, dark: 0x3A3F47)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(Color(exampleHex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }
}

private extension Color {
    init(exampleHex hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
