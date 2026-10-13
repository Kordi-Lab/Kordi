import Foundation

/// A forwarded document copy and the attachment it was forwarded from.
struct DocumentSourceLink: Equatable {
    let attachmentId: String
    let sourceAttachmentId: String
}

/// Forwarding re-uploads attachments under the sender's account. For
/// Markdown and HTML documents the new upload is linked back to its source
/// (`POST /v1/cloud/documents/<new>/source`) so the copy shows the original's
/// reactions, comments, revision, and link.
@MainActor
enum DocumentForwarding {
    /// Pending upload id to source attachment id, for documents being forwarded.
    private static var sourcesByPendingId: [String: String] = [:]

    /// Remembers which forwarded uploads are documents. `prepared` is in the
    /// same order as `sources`. Returns `prepared` unchanged.
    static func register(_ prepared: [PendingAttachment], sources: [ChatAttachment]) -> [PendingAttachment] {
        sourcesByPendingId.merge(sourceIds(pendingIds: prepared.map(\.id), sources: sources)) { _, new in new }
        return prepared
    }

    /// Links each uploaded document copy to its source. Failures are ignored
    /// so the message still sends; the copy then reads as its own document.
    static func linkSources(
        api: CloudAPIClient,
        token: String,
        drafts: [PendingAttachment],
        uploaded: [CloudMessageAttachment]
    ) async {
        let links = sourceLinks(
            pendingIds: drafts.map(\.id),
            uploadedIds: uploaded.map(\.attachmentId),
            sources: sourcesByPendingId
        )
        drafts.forEach { sourcesByPendingId[$0.id] = nil }
        for link in links {
            _ = try? await api.linkDocumentSource(
                token: token,
                attachmentId: link.attachmentId,
                sourceAttachmentId: link.sourceAttachmentId
            )
        }
    }

    /// Pending id to source id for the sources that are documents.
    nonisolated static func sourceIds(pendingIds: [String], sources: [ChatAttachment]) -> [String: String] {
        var result: [String: String] = [:]
        for (pendingId, source) in zip(pendingIds, sources)
        where DocumentReaderRequest.isDocument(name: source.name, contentType: source.mimeType) {
            result[pendingId] = source.attachmentId
        }
        return result
    }

    /// The source links for one upload, pairing drafts with uploads by position.
    nonisolated static func sourceLinks(
        pendingIds: [String],
        uploadedIds: [String],
        sources: [String: String]
    ) -> [DocumentSourceLink] {
        zip(pendingIds, uploadedIds).compactMap { pendingId, uploadedId in
            guard let source = sources[pendingId], source != uploadedId else { return nil }
            return DocumentSourceLink(attachmentId: uploadedId, sourceAttachmentId: source)
        }
    }
}
