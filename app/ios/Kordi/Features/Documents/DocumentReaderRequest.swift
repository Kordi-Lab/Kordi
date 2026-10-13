import Foundation

/// Where the reader loads a document from.
enum DocumentSource: Hashable {
    /// The authenticated route, for an attachment the account can already see.
    case attachment(String)
    /// The public route for a shared link; members switch to the attachment route.
    case link(SharedDocumentLink)
}

/// One opening of the document reader. It carries the conversation and the
/// message that hold the attachment, when known, so Share can forward the
/// message and save the file.
struct DocumentReaderRequest: Identifiable, Hashable {
    let id = UUID()
    let source: DocumentSource
    let title: String
    var attachment: ChatAttachment? = nil
    var message: ChatMessage? = nil
    var conversation: ConversationSummary? = nil

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    /// A reader request for an attachment card, or nil when the attachment is
    /// not a Markdown or HTML document and should open in Quick Look.
    init?(attachment: ChatAttachment, message: ChatMessage?, conversation: ConversationSummary?) {
        guard Self.isDocument(name: attachment.name, contentType: attachment.mimeType) else { return nil }
        self.init(
            source: .attachment(attachment.attachmentId),
            title: attachment.name,
            attachment: attachment,
            message: message,
            conversation: conversation
        )
    }

    /// A reader request for a generated artifact in the Files tab, or nil
    /// when it has no cloud attachment (Mac-hosted) or is not a document.
    init?(artifact: CloudSessionArtifactActivity, messages: [ChatMessage], conversation: ConversationSummary) {
        guard let attachmentId = artifact.attachmentId?.nonEmpty,
              Self.isDocument(name: artifact.name, contentType: artifact.contentType) else { return nil }
        let message = messages.first { $0.attachments.contains { $0.attachmentId == attachmentId } }
        let attachment = message?.attachments.first { $0.attachmentId == attachmentId } ?? ChatAttachment(
            attachmentId: attachmentId,
            name: artifact.name,
            kind: .file,
            mimeType: artifact.contentType,
            sizeBytes: artifact.sizeBytes,
            previewURL: nil
        )
        self.init(
            source: .attachment(attachmentId),
            title: artifact.name,
            attachment: attachment,
            message: message,
            conversation: conversation
        )
    }

    init(link: SharedDocumentLink) {
        self.init(source: .link(link), title: "Document")
    }

    init(
        source: DocumentSource,
        title: String,
        attachment: ChatAttachment? = nil,
        message: ChatMessage? = nil,
        conversation: ConversationSummary? = nil
    ) {
        self.source = source
        self.title = title
        self.attachment = attachment
        self.message = message
        self.conversation = conversation
    }

    static let documentContentTypes: Set<String> = ["text/markdown", "text/x-markdown", "text/html"]
    static let documentExtensions: Set<String> = ["md", "markdown", "html"]

    static func isDocument(name: String, contentType: String?) -> Bool {
        let type = contentType?
            .split(separator: ";").first
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        if let type, documentContentTypes.contains(type) { return true }
        let ext = (name as NSString).pathExtension.lowercased()
        return documentExtensions.contains(ext)
    }
}
