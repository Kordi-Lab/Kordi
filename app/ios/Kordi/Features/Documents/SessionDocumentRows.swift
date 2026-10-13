import SwiftUI

/// A generated artifact in the session Files tab. Documents with a cloud
/// attachment open in the reader; artifacts without one stay on the Mac that
/// hosts the session and show **On this Mac**.
struct CloudArtifactRow: View {
    let artifact: CloudSessionArtifactActivity
    /// Nil when the artifact does not open in the reader.
    var onOpen: (() -> Void)? = nil

    private var isOnMac: Bool { artifact.attachmentId?.nonEmpty == nil }

    var body: some View {
        if let onOpen {
            Button(action: onOpen) { row.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the document")
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            Image(systemName: artifact.kind == "document" ? "doc.text.fill" : "shippingbox.fill")
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(width: 38, height: 38)
                .background(KordiTheme.signalBlue.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(artifact.name).font(.headline)
                Text(artifact.summary.nonEmpty ?? artifact.path)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            if isOnMac {
                DocumentOnMacBadge()
            } else if onOpen != nil {
                SettingsChevron()
            }
        }
        .padding(.vertical, 3)
    }
}

/// Marks a document that lives on the Mac hosting the session and has not
/// been uploaded, so it cannot open on iPhone yet.
struct DocumentOnMacBadge: View {
    var body: some View {
        Label("On this Mac", systemImage: "laptopcomputer")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .frame(minHeight: 24)
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
            .fixedSize()
    }
}

struct SessionDetailFileRow: View {
    let item: SessionDetailAttachment
    let isLoading: Bool
    let onReview: () -> Void
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.attachment.kind == .image ? "photo.fill" : "doc.text.fill")
                .foregroundStyle(item.attachment.kind == .image ? KordiTheme.signalBlue : .secondary)
                .frame(width: 38, height: 38)
                .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.attachment.name).font(.headline).lineLimit(1)
                Text([item.attachment.formatLabel, item.attachment.sizeLabel].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                Text("Shared by \(item.message.authorName)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            if isLoading {
                ProgressView().frame(width: 44, height: 44)
            } else {
                Menu {
                    Button(action: onReview) { Label("Review", systemImage: "eye") }
                    Button(action: onDownload) { Label("Download / Save to Files", systemImage: "arrow.down.circle") }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .contentShape(Rectangle())
                .accessibilityLabel("More actions for \(item.attachment.name)")
            }
        }
        .padding(.vertical, 3)
    }
}
