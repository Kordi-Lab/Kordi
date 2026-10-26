import SwiftUI

/// Shared building blocks for the plain settings screens (the root Settings
/// sheet and the screens it opens), so they read as one product.

/// Text styles of the settings screens by role, taken from the root Settings
/// sheet. Text styles keep Dynamic Type working.
enum SettingsFont {
    /// Section titles.
    static var sectionTitle: Font { .footnote.weight(.semibold) }
    /// The name beside a 40 pt avatar or logo at the top of a screen.
    static var headerTitle: Font { .headline }
    /// Row titles, field text, and plain text rows.
    static var rowTitle: Font { .subheadline }
    /// Grey subtitles, trailing values, notes, and footers.
    static var subtitle: Font { .caption }
    /// Small status tags such as Review.
    static var badge: Font { .caption2.weight(.semibold) }
    /// Text buttons such as Try again.
    static var action: Font { .subheadline.weight(.semibold) }
    /// Small buttons beside a title or value, such as Rename.
    static var inlineAction: Font { .caption.weight(.semibold) }
}

/// Bold, left-aligned section title.
struct SettingsSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(SettingsFont.sectionTitle)
            .foregroundStyle(.primary)
            .textCase(nil)
            .padding(.top, 6)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Quiet one-line note inside a section, in the subtitle colour.
struct SettingsCaption: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(SettingsFont.subtitle)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 4)
    }
}

/// Thin line between sections.
struct SettingsDivider: View {
    var body: some View {
        Divider().padding(.vertical, 10)
    }
}

/// Trailing chevron for rows that open something.
struct SettingsChevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.caption)
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

/// Icon, title, optional subtitle, and optional trailing value.
struct CompactSettingsLabel: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let title: String
    var subtitle: String? = nil
    /// When nil the row has no icon column.
    let systemImage: String?
    var value: String? = nil
    /// Overrides the icon and title colour, for destructive or action rows.
    var tint: Color? = nil
    var titleLineLimit: Int? = nil

    var body: some View {
        HStack(alignment: .center, spacing: SettingsMetrics.iconSpacing) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundStyle(tint ?? Color.primary)
                    .frame(width: SettingsMetrics.iconWidth)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(SettingsFont.rowTitle)
                    .foregroundStyle(tint ?? Color.primary)
                    .lineLimit(titleLineLimit)
                    .truncationMode(.tail)
                    .multilineTextAlignment(.leading)
                if let subtitle {
                    Text(subtitle).font(SettingsFont.subtitle).foregroundStyle(.secondary)
                }
                if dynamicTypeSize.isAccessibilitySize, let value {
                    Text(value).font(SettingsFont.subtitle).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if !dynamicTypeSize.isAccessibilitySize, let value {
                Spacer(minLength: 8)
                Text(value)
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(1)
            }
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

/// Sizes shared by the plain settings screens.
enum SettingsMetrics {
    static let rowMinHeight: CGFloat = 48
    static let textRowMinHeight: CGFloat = 44
    static let pageInsets = EdgeInsets(top: 12, leading: 20, bottom: 24, trailing: 20)
    /// Width of the icon column and the gap after it, so row titles line up.
    static let iconWidth: CGFloat = 22
    static let iconSpacing: CGFloat = 12
}

/// Scrolling body of a plain settings screen: flat background, no cards.
struct SettingsPage<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SettingsMetrics.pageInsets)
        }
        .background(Color(uiColor: .systemBackground))
    }
}

/// Full-width row with an optional trailing control, tappable across its width.
struct SettingsRow<Content: View, Trailing: View>: View {
    @ViewBuilder var content: Content
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            content
            Spacer(minLength: 0)
            trailing
        }
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .contentShape(Rectangle())
    }
}

extension SettingsRow where Trailing == EmptyView {
    init(@ViewBuilder content: () -> Content) {
        self.init(content: content, trailing: { EmptyView() })
    }
}

/// Rounded search field above a long settings list.
struct SettingsSearchField: View {
    let prompt: String
    @Binding var text: String

    init(_ prompt: String, text: Binding<String>) {
        self.prompt = prompt
        _text = text
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .font(SettingsFont.rowTitle)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button("Clear search", systemImage: "xmark.circle.fill") { text = "" }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 10))
        .padding(.vertical, 6)
    }
}

extension View {
    /// A text field on a plain settings screen: row text on a soft rounded fill.
    func settingsField() -> some View {
        font(SettingsFont.rowTitle)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: SettingsMetrics.textRowMinHeight)
            .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 10))
    }

    /// A `List` that reads like `SettingsPage`, for screens that need list
    /// behaviour such as swipe actions. Mark its rows with `settingsListRow()`.
    func settingsListStyle() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .environment(\.defaultMinListRowHeight, 0)
    }

    /// One row of a `settingsListStyle()` list: page insets and no separator.
    func settingsListRow() -> some View {
        listRowInsets(EdgeInsets(
            top: 0,
            leading: SettingsMetrics.pageInsets.leading,
            bottom: 0,
            trailing: SettingsMetrics.pageInsets.trailing
        ))
        .listRowSeparator(.hidden)
    }
}

/// Destructive action shown as a plain red text row.
struct SettingsDestructiveRow: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(role: .destructive, action: action) {
            Text(title)
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, minHeight: SettingsMetrics.textRowMinHeight, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Spinner with a few words, for a screen that has nothing to show yet.
struct SettingsLoadingRow: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(text)
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.secondary)
        }
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .accessibilityElement(children: .combine)
    }
}

/// Error text in the settings screens.
struct SettingsErrorLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(SettingsFont.rowTitle)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 8)
    }
}
