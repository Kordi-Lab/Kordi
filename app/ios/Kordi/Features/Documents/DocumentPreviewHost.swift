#if DEBUG
import SwiftUI

/// `--preview-shared-document`: the reader with synthetic data and no
/// backend. `--preview-document-share` also opens Share, and
/// `--preview-document-selection` selects a paragraph.
struct SharedDocumentPreviewHost: View {
    @EnvironmentObject private var model: AppModel

    private var arguments: [String] { ProcessInfo.processInfo.arguments }

    var body: some View {
        NavigationStack {
            DocumentReaderView(
                request: request,
                service: PreviewDocumentService(),
                showsShareSheet: arguments.contains("--preview-document-share"),
                selectedBlockId: arguments.contains("--preview-document-selection") ? "b2" : nil
            )
        }
    }

    private var request: DocumentReaderRequest {
        let document = PreviewData.sharedDocument()
        let conversation = model.conversations.first { $0.id == "group:mobile" }
        let message = conversation.flatMap { model.messages(for: $0).last }
        return DocumentReaderRequest(
            source: .attachment(document.attachmentId),
            title: document.title,
            attachment: ChatAttachment(
                attachmentId: document.attachmentId,
                name: document.fileName,
                kind: .file,
                mimeType: document.contentType,
                sizeBytes: document.sizeBytes,
                previewURL: nil
            ),
            message: message,
            conversation: conversation
        )
    }
}
#endif
