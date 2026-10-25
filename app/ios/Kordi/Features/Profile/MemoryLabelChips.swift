import SwiftUI

/// One label on a memory row: the category filled, a card outlined, the origin
/// plain grey. A chosen label (an active filter) is tinted. Tapping toggles it.
struct MemoryLabelChip: View {
    let label: MemoryLabel
    let isOn: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            Text(label.title)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
                .foregroundStyle(isOn ? Color.white : (label.layer == .origin ? Color.secondary : Color.primary.opacity(0.75)))
                .padding(.horizontal, label.layer == .origin && !isOn ? 2 : 7)
                .padding(.vertical, 3)
                .background { MemoryChipBackground(layer: label.layer, isOn: isOn, cornerRadius: 8) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label.title)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityHint("Show only memories with this label")
    }
}

/// The filter row: each layer's labels with counts, scrolling sideways, then Clear.
struct MemoryFilterRow: View {
    let groups: [MemoryFilterGroup]
    @Binding var filters: MemoryFilters

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(groups) { group in
                    HStack(spacing: 6) {
                        Text(group.layer.title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(group.chips) { chip in
                            filterChip(chip.label, count: chip.count)
                        }
                    }
                }
                if !filters.isEmpty {
                    Button("Clear") { filters.clear() }
                        .font(.footnote.weight(.medium))
                        .accessibilityIdentifier("memory-filter-clear")
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 4)
        }
        .padding(.horizontal, -20)
        .accessibilityIdentifier("memory-filter-row")
    }

    private func filterChip(_ label: MemoryLabel, count: Int) -> some View {
        let isOn = filters.contains(label)
        return Button { filters.toggle(label) } label: {
            HStack(spacing: 5) {
                Text(label.title)
                Text("\(count)").monospacedDigit().opacity(0.6)
            }
            .font(.footnote.weight(.medium))
            .lineLimit(1)
            .foregroundStyle(isOn ? Color.white : (label.layer == .origin ? Color.secondary : Color.primary))
            .padding(.horizontal, 11)
            .frame(height: 28)
            .background { MemoryChipBackground(layer: label.layer, isOn: isOn, cornerRadius: 14) }
            .fixedSize()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label.title), \(count)")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// Filled for a category, outlined for a card, none for an origin; tinted when chosen.
private struct MemoryChipBackground: View {
    let layer: MemoryLabelLayer
    let isOn: Bool
    let cornerRadius: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if isOn {
            shape.fill(Color.accentColor)
        } else {
            switch layer {
            case .category: shape.fill(Color(uiColor: .tertiarySystemFill))
            case .card: shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1)
            case .origin: Color.clear
            }
        }
    }
}
