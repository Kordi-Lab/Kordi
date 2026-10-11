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
