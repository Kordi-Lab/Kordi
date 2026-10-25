import SwiftUI

/// The connector events an agent message is based on (#2091): provider
/// symbol and name with the event title in secondary color, in bordered
/// capsules that wrap.
struct MessageSourceChips: View {
    let sources: [MessageSource]

    var body: some View {
        MessageSourceChipLayout(spacing: 6) {
            ForEach(sources) { source in
                MessageSourceChip(source: source)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sources")
    }
}

private struct MessageSourceChip: View {
    let source: MessageSource

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: MessageSourcePresentation.systemImage(source.provider))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(MessageSourcePresentation.providerName(source.provider))
                .foregroundStyle(.primary)
                .fixedSize()
            if let title = source.title.nonEmpty {
                Text(title)
                    .foregroundStyle(.secondary)
                    .truncationMode(.tail)
            }
        }
        .font(.caption)
        .lineLimit(1)
        .padding(.horizontal, 10)
        .frame(minHeight: 26)
        .overlay {
            Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 0.5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MessageSourcePresentation.accessibilityLabel(source))
    }
}

/// Wraps chips onto new rows and reports only the width it uses, so the
/// chips never widen the message column.
private struct MessageSourceChipLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, maxWidth: proposal.width ?? .infinity)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, maxWidth: bounds.width) {
            var x = bounds.minX
            for item in row.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [(index: Int, size: CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            var size = subviews[index].sizeThatFits(.unspecified)
            if size.width > maxWidth {
                // A chip wider than the column is narrowed so its title truncates.
                size = subviews[index].sizeThatFits(ProposedViewSize(width: maxWidth, height: size.height))
            }
            let nextWidth = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if !current.items.isEmpty, nextWidth > maxWidth {
                rows.append(current)
                current = Row()
            }
            current.width = current.items.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.items.append((index, size))
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}
