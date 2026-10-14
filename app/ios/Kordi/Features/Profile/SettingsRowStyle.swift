import SwiftUI

/// Shared building blocks for the plain settings screens (the root Settings
/// sheet and the screens it opens), so they read as one product.

/// Bold, left-aligned section title.
struct SettingsSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.footnote.weight(.semibold))
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
            .font(.caption)
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
        HStack(alignment: .center, spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundStyle(tint ?? Color.primary)
                    .frame(width: 22)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(tint ?? Color.primary)
                    .lineLimit(titleLineLimit)
                    .truncationMode(.tail)
                    .multilineTextAlignment(.leading)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                if dynamicTypeSize.isAccessibilitySize, let value {
                    Text(value).font(.caption).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if !dynamicTypeSize.isAccessibilitySize, let value {
                Spacer(minLength: 8)
                Text(value)
                    .font(.caption)
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
                .font(.subheadline)
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
                .font(.subheadline)
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
            .font(.subheadline)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 8)
    }
}
