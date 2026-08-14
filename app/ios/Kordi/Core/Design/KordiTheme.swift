import SwiftUI

enum KordiTheme {
    static let signalBlue = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let agentViolet = Color(red: 132 / 255, green: 122 / 255, blue: 196 / 255)
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
    static let ownBubble = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 45 / 255, green: 66 / 255, blue: 91 / 255, alpha: 1)
                : UIColor(red: 226 / 255, green: 235 / 255, blue: 245 / 255, alpha: 1)
        }
    )
    static let agentWash = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 132 / 255, green: 122 / 255, blue: 196 / 255, alpha: 0.16)
                : UIColor(red: 132 / 255, green: 122 / 255, blue: 196 / 255, alpha: 0.12)
        }
    )
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
