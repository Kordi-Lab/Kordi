import SwiftUI

/// The name on a file attachment card: a document's renamed title when
/// known, otherwise the file name with its extension kept visible.
struct AttachmentCardFileName: View {
    let attachment: ChatAttachment

    var body: some View {
        let name = DocumentTitles.shared.displayName(for: attachment)
        Group {
            if name != attachment.name {
                Text(name)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else {
                HStack(spacing: 0) {
                    Text(String(name.dropLast(nameExtension.count)))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(nameExtension)
                        .fixedSize()
                }
            }
        }
        .loadsDocumentTitle(attachmentId: attachment.attachmentId, name: attachment.name, contentType: attachment.mimeType)
    }

    private var nameExtension: String {
        let ext = URL(fileURLWithPath: attachment.name).pathExtension
        return ext.isEmpty ? "" : ".\(ext)"
    }
}

extension View {
    /// Chat list rows: fetch the title of a lone document preview while visible.
    @ViewBuilder
    func loadsPreviewDocumentTitle(_ attachment: ChatAttachment?) -> some View {
        if let attachment, attachment.kind != .image {
            loadsDocumentTitle(attachmentId: attachment.attachmentId, name: attachment.name, contentType: attachment.mimeType)
        } else {
            self
        }
    }

    /// Fetches the title of a cloud document while this view is on screen,
    /// so a renamed document shows its title instead of the file name.
    func loadsDocumentTitle(attachmentId: String?, name: String, contentType: String?) -> some View {
        modifier(DocumentTitleLoader(attachmentId: attachmentId ?? "", name: name, contentType: contentType))
    }
}

private struct DocumentTitleLoader: ViewModifier {
    @EnvironmentObject private var model: AppModel
    let attachmentId: String
    let name: String
    let contentType: String?

    private var loads: Bool {
        DocumentTitles.loadsTitle(attachmentId: attachmentId, name: name, contentType: contentType)
    }

    func body(content: Content) -> some View {
        content
            .task(id: attachmentId) {
                guard loads, !model.isPreviewMode else { return }
                let service = model.makeDocumentService()
                DocumentTitles.shared.request(attachmentId) { try await service.load(.attachment($0)) }
            }
            .onDisappear {
                if loads { DocumentTitles.shared.withdraw(attachmentId) }
            }
    }
}
