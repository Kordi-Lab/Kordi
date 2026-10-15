import SwiftUI

/// Formatting above the keyboard: the Mac's selection menu (text style,
/// bold, italic, underline, strikethrough, code, highlight, list, link) and
/// its insert tools (checklist, code block, table).
struct DocumentEditorToolbar: View {
    @ObservedObject var session: DocumentEditorSession
    let onLink: () -> Void

    private static let styles: [(style: String, label: String)] = [
        ("text", "Text"), ("h1", "Heading 1"), ("h2", "Heading 2"), ("h3", "Heading 3"), ("quote", "Quote"),
    ]
    private static let formats: [(format: String, icon: String, label: String)] = [
        ("bold", "bold", "Bold"),
        ("italic", "italic", "Italic"),
        ("underline", "underline", "Underline"),
        ("strike", "strikethrough", "Strikethrough"),
        ("code", "chevron.left.forwardslash.chevron.right", "Code"),
        ("highlight", "highlighter", "Highlight"),
    ]

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    styleMenu
                    divider
                    ForEach(Self.formats, id: \.format) { entry in
                        button(entry.icon, entry.label, isOn: session.toolbar.formats.contains(entry.format)) {
                            session.command(entry.format)
                        }
                    }
                    divider
                    button("list.bullet", "List", isOn: session.toolbar.list) { session.command("list") }
                    button("list.number", "Numbered list", isOn: session.toolbar.orderedList) { session.command("orderedList") }
                    button("checklist", "Checklist", isOn: session.toolbar.checklist) { session.command("checklist") }
                    button("link", session.toolbar.link ? "Remove link" : "Link", isOn: session.toolbar.link, action: onLink)
                    divider
                    button("curlybraces", "Code block", isOn: false) { session.command("codeBlock") }
                    button("tablecells", "Table", isOn: false) { session.command("table") }
                    divider
                    button("arrow.uturn.backward", "Undo", isOn: false) { session.command("undo") }
                    button("arrow.uturn.forward", "Redo", isOn: false) { session.command("redo") }
                }
                .padding(.horizontal, 8)
            }
            if session.isFocused {
                Divider().frame(height: 24)
                button("keyboard.chevron.compact.down", "Hide keyboard", isOn: false) { session.command("blur") }
                    .padding(.horizontal, 4)
            }
        }
        .frame(height: 44)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var styleMenu: some View {
        Menu {
            ForEach(Self.styles, id: \.style) { entry in
                Button {
                    session.command("block", value: entry.style)
                } label: {
                    if session.toolbar.block == entry.style {
                        Label(entry.label, systemImage: "checkmark")
                    } else {
                        Text(entry.label)
                    }
                }
            }
        } label: {
            Text("Aa")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 40, height: 36)
                .foregroundStyle(session.toolbar.block == "text" ? Color.primary : Color.accentColor)
        }
        .accessibilityLabel("Text style")
    }

    private var divider: some View {
        Divider().frame(height: 20).padding(.horizontal, 4)
    }

    private func button(_ icon: String, _ label: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .frame(width: 36, height: 36)
                .foregroundStyle(isOn ? Color.accentColor : Color.primary)
                .background(isOn ? Color.accentColor.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// Avatars of the others in the room, colored like their carets.
struct DocumentEditorPresence: View {
    let peers: [DocumentEditorPeer]

    var body: some View {
        HStack(spacing: -6) {
            ForEach(peers.prefix(3)) { peer in
                Text(String(peer.name.prefix(1)).uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color(documentEditorHex: peer.color) ?? KordiTheme.agentViolet, in: Circle())
                    .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
            }
            if peers.count > 3 {
                Text("+\(peers.count - 3)")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(Color(uiColor: .secondarySystemBackground), in: Circle())
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(peers.map(\.name).joined(separator: ", "))
    }
}

extension Color {
    /// `#rgb` or `#rrggbb`.
    init?(documentEditorHex hex: String) {
        var digits = hex.trimmingCharacters(in: .whitespaces)
        guard digits.hasPrefix("#") else { return nil }
        digits.removeFirst()
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

extension UIColor {
    /// `#rrggbb` of this color in the given appearance.
    func documentEditorHex(for traits: UITraitCollection) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let clamp = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", clamp(red), clamp(green), clamp(blue))
    }
}
