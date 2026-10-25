import SwiftUI

/// The category chip on a memory row: a small 8 pt rounded tag.
struct MemoryCategoryTag: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .fixedSize()
    }
}

/// A memory's text over its caption ("From a correction · Today") with the
/// category chip after it, then any extra caption lines.
struct MemoryRowLabel: View {
    let text: String
    let detail: String
    let category: String?
    var captions: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(3)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
            HStack(spacing: 6) {
                if !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                if let label = MemoryPresentation.categoryLabel(for: category) {
                    MemoryCategoryTag(label: label)
                }
            }
            ForEach(captions, id: \.self) { caption in
                Text(caption).font(.caption).foregroundStyle(.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
