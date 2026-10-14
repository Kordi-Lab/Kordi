import SwiftUI

/// Shared geometry of the file rows in the session Files tab.
enum SessionFileRowMetrics {
    static let iconWidth: CGFloat = 30
    static let spacing: CGFloat = 12
    /// Leading inset of the separators, so they start at the row text.
    static var textInset: CGFloat { SessionDetailMetrics.rowHorizontalInset + iconWidth + spacing }
}

/// SF Symbol and colour for a file, picked from its extension or MIME type.
enum SessionFileIcon {
    static func symbol(name: String, mimeType: String?, isImage: Bool = false) -> (name: String, color: Color) {
        let ext = URL(fileURLWithPath: name).pathExtension.lowercased()
        let mime = mimeType?.lowercased() ?? ""
        if isImage || mime.hasPrefix("image/") { return ("photo", .blue) }
        if ext == "pdf" || mime == "application/pdf" { return ("doc.text", .red) }
        if ["xls", "xlsx", "csv", "tsv", "numbers"].contains(ext) || mime.contains("spreadsheet") || mime == "text/csv" {
            return ("tablecells", .green)
        }
        if ["ppt", "pptx", "key"].contains(ext) || mime.contains("presentation") {
            return ("rectangle.on.rectangle", .orange)
        }
        if ["zip", "gz", "tgz", "tar", "rar", "7z"].contains(ext) || mime.contains("zip") || mime.contains("compressed") {
            return ("doc.zipper", .gray)
        }
        if mime.hasPrefix("video/") || ["mp4", "mov", "m4v"].contains(ext) { return ("film", .purple) }
        if mime.hasPrefix("audio/") || ["mp3", "m4a", "wav", "aac"].contains(ext) { return ("waveform", .pink) }
        if ["swift", "js", "ts", "tsx", "py", "rs", "json", "yaml", "yml", "sh"].contains(ext) {
            return ("chevron.left.forwardslash.chevron.right", .gray)
        }
        if ["md", "markdown", "txt", "rtf", "html", "htm", "doc", "docx", "pages"].contains(ext)
            || mime.hasPrefix("text/") || mime.contains("word") {
            return ("doc.text", .blue)
        }
        return ("doc", .gray)
    }
}

/// Leading document symbol of a file row.
struct SessionFileIconView: View {
    let symbol: (name: String, color: Color)

    var body: some View {
        Image(systemName: symbol.name)
            .font(.title3)
            .foregroundStyle(symbol.color)
            .frame(width: SessionFileRowMetrics.iconWidth, height: SessionFileRowMetrics.iconWidth)
            .accessibilityHidden(true)
    }
}

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
                .buttonStyle(SessionRowButtonStyle())
                .accessibilityHint("Opens the document")
        } else {
            row
        }
    }

    private var symbol: (name: String, color: Color) {
        artifact.kind == "document"
            ? SessionFileIcon.symbol(name: artifact.name, mimeType: artifact.contentType)
            : ("shippingbox", .gray)
    }

    private var row: some View {
        HStack(spacing: SessionFileRowMetrics.spacing) {
            SessionFileIconView(symbol: symbol)
            VStack(alignment: .leading, spacing: 1) {
                Text(DocumentTitles.shared.displayName(attachmentId: artifact.attachmentId, fileName: artifact.name))
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .loadsDocumentTitle(attachmentId: artifact.attachmentId, name: artifact.name, contentType: artifact.contentType)
                Text(artifact.summary.nonEmpty ?? artifact.path)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if isOnMac {
                DocumentOnMacBadge()
            } else if onOpen != nil {
                SettingsChevron()
            }
        }
        .padding(.leading, SessionDetailMetrics.rowHorizontalInset)
        .padding(.trailing, 14)
        .padding(.vertical, 8)
        .frame(minHeight: SessionDetailMetrics.fileRowMinHeight)
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

    private var sharedBy: String {
        item.message.author == .me ? "You" : item.message.authorName
    }

    private var detail: String {
        [item.attachment.sizeLabel, sharedBy].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: SessionFileRowMetrics.spacing) {
            SessionFileIconView(symbol: SessionFileIcon.symbol(
                name: item.attachment.name,
                mimeType: item.attachment.mimeType,
                isImage: item.attachment.kind == .image
            ))
            VStack(alignment: .leading, spacing: 1) {
                Text(DocumentTitles.shared.displayName(for: item.attachment))
                    .font(.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .loadsDocumentTitle(
                        attachmentId: item.attachment.attachmentId,
                        name: item.attachment.name,
                        contentType: item.attachment.mimeType
                    )
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue("\(item.attachment.formatLabel), shared by \(sharedBy)")
            Spacer(minLength: 4)
            if isLoading {
                ProgressView().frame(width: 44, height: 44)
            } else {
                Menu {
                    Button(action: onReview) { Label("Review", systemImage: "eye") }
                    Button(action: onDownload) { Label("Download / Save to Files", systemImage: "arrow.down.circle") }
                } label: {
                    SessionEllipsisCircleLabel()
                }
                .contentShape(Rectangle())
                .accessibilityLabel("More actions for \(item.attachment.name)")
            }
        }
        .padding(.leading, SessionDetailMetrics.rowHorizontalInset)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(minHeight: SessionDetailMetrics.fileRowMinHeight)
    }
}
