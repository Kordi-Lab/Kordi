import SwiftUI

/// The floating menu above a selected block. Comment and react act; the
/// formatting tools stay disabled on iPhone because editing happens on the
/// Mac that hosts the session. Public readers get comment and react only.
struct DocumentSelectionMenu: View {
    static let quickReactions = ["❤️", "👍", "🔥", "👀", "🤔", "🎉"]

    let showsFormatting: Bool
    let canComment: Bool
    let canReact: Bool
    @Binding var showsReactions: Bool
    let onComment: () -> Void
    let onReact: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsReactions {
                HStack(spacing: 2) {
                    ForEach(Self.quickReactions, id: \.self) { emoji in
                        Button { onReact(emoji) } label: {
                            Text(emoji)
                                .font(.title3)
                                .frame(width: 40, height: 40)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("React with \(emoji)")
                    }
                }
                .padding(.horizontal, 4)
                .background(.regularMaterial, in: Capsule())
                .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    tool("text.bubble", label: "Comment", action: onComment).disabled(!canComment)
                    tool("face.smiling", label: "React") { showsReactions.toggle() }.disabled(!canReact)
                    if showsFormatting {
                        separator
                        tool("textformat", label: "Text style") {}.disabled(true)
                        separator
                        tool("bold", label: "Bold") {}.disabled(true)
                        tool("italic", label: "Italic") {}.disabled(true)
                        tool("underline", label: "Underline") {}.disabled(true)
                        tool("strikethrough", label: "Strikethrough") {}.disabled(true)
                        tool("chevron.left.forwardslash.chevron.right", label: "Code") {}.disabled(true)
                        tool("highlighter", label: "Highlight") {}.disabled(true)
                        separator
                        tool("list.bullet", label: "List") {}.disabled(true)
                        separator
                        tool("link", label: "Link") {}.disabled(true)
                    }
                }
                .padding(.horizontal, 4)
            }
            .fixedSize(horizontal: !showsFormatting, vertical: true)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        }
    }

    private var separator: some View {
        Divider().frame(height: 18).padding(.horizontal, 2)
    }

    private func tool(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.medium))
                .frame(width: 34, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(DocumentToolButtonStyle())
        .accessibilityLabel(label)
    }
}

/// Plain tool button that dims when disabled, so tools that only work on the
/// Mac read as unavailable.
struct DocumentToolButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? Color.primary : Color.secondary.opacity(0.55))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Reaction pills under a block. Tapping one toggles the viewer's reaction.
struct DocumentReactionPills: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let summaries: [DocumentReactionSummary]
    let canReact: Bool
    let onToggle: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(summaries) { summary in
                    Button { onToggle(summary.reaction) } label: {
                        Text("\(summary.reaction) \(summary.count)")
                            .font(.footnote.weight(.medium))
                            .monospacedDigit()
                            .padding(.horizontal, 10)
                            .frame(minHeight: 30)
                            .background(
                                summary.mine ? chatTheme.accent.opacity(0.14) : Color(uiColor: .secondarySystemBackground),
                                in: Capsule()
                            )
                            .overlay {
                                Capsule().stroke(summary.mine ? chatTheme.accent.opacity(0.5) : .clear, lineWidth: 1)
                            }
                    }
                    .buttonStyle(.plain)
                    .disabled(!canReact)
                    .accessibilityLabel("\(summary.reaction), \(summary.count)")
                    .accessibilityAddTraits(summary.mine ? .isSelected : [])
                }
            }
        }
    }
}
