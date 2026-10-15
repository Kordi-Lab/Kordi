import SwiftUI

/// Shared look of the conversation info page: grouped sections with the large
/// system corner radius, Settings-style rows, and Liquid Glass controls.
enum SessionDetailMetrics {
    static let sectionCornerRadius: CGFloat = 26
    static let actionCornerRadius: CGFloat = 18
    static let actionMinHeight: CGFloat = 62
    static let rowMinHeight: CGFloat = 52
    static let fileRowMinHeight: CGFloat = 60
    static let rowHorizontalInset: CGFloat = 16
}

/// A grouped section: rows on the secondary grouped background, clipped to
/// the large corner radius. The optional title is sentence case.
struct SessionDetailSection<Content: View>: View {
    var title: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .accessibilityAddTraits(.isHeader)
            }

            VStack(spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: SessionDetailMetrics.sectionCornerRadius, style: .continuous)
            )
            .clipShape(RoundedRectangle(cornerRadius: SessionDetailMetrics.sectionCornerRadius, style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Thin row separator, inset so it starts at the row text.
struct SessionDetailSeparator: View {
    let leading: CGFloat

    var body: some View {
        Divider().padding(.leading, leading)
    }
}

/// Grey highlight while a full-width row is pressed, like a Settings row.
struct SessionRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color(uiColor: .systemGray4) : Color.clear)
    }
}

/// Settings-style icon: a white symbol on a small rounded square.
struct SessionSettingsIconTile: View {
    let systemImage: String
    var color = Color(uiColor: .systemGray)
    @ScaledMetric(relativeTo: .body) private var size = 30.0

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.53, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// One Settings-style row: icon tile, title, thin chevron.
struct SessionSettingsRow: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                SessionSettingsIconTile(systemImage: systemImage)
                Text(title)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionRowButtonStyle())
    }
}

/// The standard trailing "more" control: an ellipsis in a filled circle.
struct SessionEllipsisCircleLabel: View {
    @ScaledMetric(relativeTo: .body) private var size = 24.0

    var body: some View {
        Image(systemName: "ellipsis.circle.fill")
            .symbolRenderingMode(.palette)
            .foregroundStyle(.tint, Color(uiColor: .tertiarySystemFill))
            .font(.system(size: size))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}

/// Liquid Glass behind a control, with a material fallback before iOS 26 and
/// an opaque fill when Reduce Transparency is on.
struct SessionGlassSurface<S: Shape>: ViewModifier {
    let shape: S
    var selectionTint: Color? = nil
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(
                selectionTint?.opacity(0.22) ?? Color(uiColor: .secondarySystemGroupedBackground),
                in: shape
            )
        } else if #available(iOS 26.0, *) {
            content.glassEffect(
                selectionTint.map { Glass.regular.tint($0.opacity(0.28)).interactive() } ?? .regular.interactive(),
                in: shape
            )
        } else {
            content
                .background(.regularMaterial, in: shape)
                .background(selectionTint?.opacity(0.18) ?? Color.clear, in: shape)
        }
    }
}

extension View {
    func sessionGlass<S: Shape>(in shape: S, selectionTint: Color? = nil) -> some View {
        modifier(SessionGlassSurface(shape: shape, selectionTint: selectionTint))
    }
}
