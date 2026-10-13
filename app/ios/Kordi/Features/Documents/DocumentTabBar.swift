import SwiftUI

/// Local tabs for the reader. Tabs live only in this view; the first tab is
/// the document and new tabs start empty.
struct DocumentTabs: Equatable {
    var names = ["Tab 1"]
    var current = 0
    var showsOnPage = false

    var currentName: String { names.indices.contains(current) ? names[current] : names[0] }
    var showsStrip: Bool { showsOnPage && names.count > 1 }

    mutating func addTab() {
        names.append("Tab \(names.count + 1)")
        current = names.count - 1
    }
}

/// The bar under the navigation: the tab menu and the insert tools. Insert
/// tools are disabled on iPhone because editing happens on the hosting Mac.
struct DocumentTabBar: View {
    @Binding var tabs: DocumentTabs

    var body: some View {
        HStack(spacing: 2) {
            Menu {
                Toggle("Show on page", isOn: $tabs.showsOnPage)
                Divider()
                ForEach(Array(tabs.names.enumerated()), id: \.offset) { index, name in
                    Button {
                        tabs.current = index
                    } label: {
                        if index == tabs.current {
                            Label(name, systemImage: "checkmark")
                        } else {
                            Text(name)
                        }
                    }
                }
                Divider()
                Button {
                    tabs.addTab()
                } label: {
                    Label("New tab", systemImage: "plus")
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "doc")
                    Text(tabs.currentName).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                }
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 10)
                .frame(minHeight: 34)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .foregroundStyle(.primary)
            .accessibilityLabel("Tabs, \(tabs.currentName)")

            separator
            tool("pencil.tip", label: "Draw")
            tool("chevron.left.forwardslash.chevron.right", label: "Code block")
            separator
            tool("tablecells", label: "Table")
            tool("photo", label: "Image")
            tool("checklist", label: "Checklist")
            tool("plus", label: "More blocks")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var separator: some View {
        Divider().frame(height: 18).padding(.horizontal, 4)
    }

    private func tool(_ symbol: String, label: String) -> some View {
        Button {} label: {
            Image(systemName: symbol)
                .font(.subheadline)
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
        }
        .buttonStyle(DocumentToolButtonStyle())
        .disabled(true)
        .accessibilityLabel(label)
    }
}

/// The tab strip shown on the page when Show on page is on.
struct DocumentTabStrip: View {
    @Binding var tabs: DocumentTabs

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(tabs.names.enumerated()), id: \.offset) { index, name in
                    Button(name) { tabs.current = index }
                        .font(.footnote.weight(index == tabs.current ? .semibold : .regular))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 30)
                        .background(
                            index == tabs.current ? Color(uiColor: .tertiarySystemFill) : .clear,
                            in: Capsule()
                        )
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(index == tabs.current ? .isSelected : [])
                }
            }
        }
    }
}
