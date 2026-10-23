import SwiftUI

/// Avatar, title and subtitle with an optional trailing accessory; the shared
/// shape of every Contacts row.
struct ContactsRowLayout<Leading: View, Trailing: View>: View {
    let title: String
    let subtitle: String?
    /// Overrides the secondary subtitle color, such as the tint for "online".
    var subtitleColor: Color? = nil
    /// A small mark before the subtitle, drawn in the subtitle color.
    var subtitleIcon: Image? = nil
    var subtitleIconLabel: String? = nil
    private let leading: Leading
    private let trailing: Trailing
    @ScaledMetric(relativeTo: .footnote) private var iconSize: CGFloat = 12

    init(
        title: String,
        subtitle: String?,
        subtitleColor: Color? = nil,
        subtitleIcon: Image? = nil,
        subtitleIconLabel: String? = nil,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.subtitleColor = subtitleColor
        self.subtitleIcon = subtitleIcon
        self.subtitleIconLabel = subtitleIconLabel
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            leading
                .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let subtitle {
                    HStack(spacing: 4) {
                        if let subtitleIcon {
                            subtitleIcon
                                .renderingMode(.template)
                                .resizable()
                                .scaledToFit()
                                .frame(width: iconSize, height: iconSize)
                                .accessibilityLabel(subtitleIconLabel ?? "")
                        }
                        Text(subtitle)
                            .font(.footnote)
                            .lineLimit(1)
                    }
                    .foregroundStyle(subtitleColor.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            trailing
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

extension ContactsRowLayout where Trailing == EmptyView {
    init(
        title: String,
        subtitle: String?,
        subtitleColor: Color? = nil,
        subtitleIcon: Image? = nil,
        subtitleIconLabel: String? = nil,
        @ViewBuilder leading: () -> Leading
    ) {
        self.init(
            title: title,
            subtitle: subtitle,
            subtitleColor: subtitleColor,
            subtitleIcon: subtitleIcon,
            subtitleIconLabel: subtitleIconLabel,
            leading: leading
        ) { EmptyView() }
    }
}
