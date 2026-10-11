import Foundation

/// How a public reader is named on reactions and comments.
struct DocumentReaderIdentity: Equatable {
    let readerKey: String
    let readerName: String
}

/// The document routes the reader uses. The cloud service calls the server;
/// the preview service keeps synthetic data in memory for
/// `--preview-shared-document`.
@MainActor
protocol DocumentService: AnyObject {
    func load(_ source: DocumentSource) async throws -> DocumentResponse
    func rawContent(_ document: DocumentResponse) async throws -> Data
    func toggleReaction(_ document: DocumentResponse, publicToken: String?, blockId: String, reaction: String, reader: DocumentReaderIdentity?) async throws -> [DocumentReaction]
    func postComment(_ document: DocumentResponse, publicToken: String?, blockId: String, body: String, parentCommentId: String?, reader: DocumentReaderIdentity?) async throws -> DocumentComment
    func updateComment(_ commentId: String, body: String?, resolved: Bool?) async throws -> DocumentComment
    func deleteComment(_ commentId: String) async throws
    func createShare(attachmentId: String, sessionId: String?) async throws -> DocumentShare
    func updateShare(_ shareId: String, readersCanAskAgent: Bool) async throws -> DocumentShare
    func deleteShare(_ shareId: String) async throws
}

@MainActor
final class CloudDocumentService: DocumentService {
    private let api: CloudAPIClient
    private let tokenProvider: @MainActor () -> String?

    init(api: CloudAPIClient, tokenProvider: @escaping @MainActor () -> String?) {
        self.api = api
        self.tokenProvider = tokenProvider
    }

    private func token() throws -> String {
        guard let token = tokenProvider() else {
            throw CloudAPIError(code: "unauthorized", message: "Sign in to continue.", statusCode: 401)
        }
        return token
    }

    func load(_ source: DocumentSource) async throws -> DocumentResponse {
        switch source {
        case .attachment(let attachmentId):
            return try await api.document(token: token(), attachmentId: attachmentId)
        case .link(let link):
            let shared = try await api.publicDocument(shareToken: link.token)
            // Members read through their own access, which keeps working when the link is off.
            if let token = tokenProvider(),
               let member = try? await api.document(token: token, attachmentId: shared.attachmentId) {
                return member
            }
            return shared
        }
    }

    func rawContent(_ document: DocumentResponse) async throws -> Data {
        guard let rawPath = document.rawPath?.nonEmpty else {
            throw CloudAPIError(code: "invalid_response", message: "Could not open this document.", statusCode: 0)
        }
        return try await api.documentRawContent(token: document.viewer == .public ? nil : token(), rawPath: rawPath)
    }

    func toggleReaction(_ document: DocumentResponse, publicToken: String?, blockId: String, reaction: String, reader: DocumentReaderIdentity?) async throws -> [DocumentReaction] {
        if let publicToken, let reader {
            return try await api.togglePublicDocumentReaction(
                shareToken: publicToken, blockId: blockId, reaction: reaction,
                readerKey: reader.readerKey, readerName: reader.readerName
            )
        }
        return try await api.toggleDocumentReaction(token: token(), attachmentId: document.attachmentId, blockId: blockId, reaction: reaction)
    }

    func postComment(_ document: DocumentResponse, publicToken: String?, blockId: String, body: String, parentCommentId: String?, reader: DocumentReaderIdentity?) async throws -> DocumentComment {
        if let publicToken, let reader {
            return try await api.postPublicDocumentComment(
                shareToken: publicToken, blockId: blockId, body: body, parentCommentId: parentCommentId,
                readerKey: reader.readerKey, readerName: reader.readerName
            )
        }
        return try await api.postDocumentComment(
            token: token(), attachmentId: document.attachmentId, blockId: blockId, body: body, parentCommentId: parentCommentId
        )
    }

    func updateComment(_ commentId: String, body: String?, resolved: Bool?) async throws -> DocumentComment {
        try await api.updateDocumentComment(token: token(), commentId: commentId, body: body, resolved: resolved)
    }

    func deleteComment(_ commentId: String) async throws {
        try await api.deleteDocumentComment(token: token(), commentId: commentId)
    }

    func createShare(attachmentId: String, sessionId: String?) async throws -> DocumentShare {
        try await api.createDocumentShare(token: token(), attachmentId: attachmentId, sessionId: sessionId)
    }

    func updateShare(_ shareId: String, readersCanAskAgent: Bool) async throws -> DocumentShare {
        try await api.updateDocumentShare(token: token(), shareId: shareId, readersCanAskAgent: readersCanAskAgent)
    }

    func deleteShare(_ shareId: String) async throws {
        try await api.deleteDocumentShare(token: token(), shareId: shareId)
    }
}

/// Offline document for `--preview-shared-document`. Writes change only this
/// in-memory copy; nothing leaves the device.
@MainActor
final class PreviewDocumentService: DocumentService {
    private var document: DocumentResponse
    private var counter = 0

    init(document: DocumentResponse = PreviewData.sharedDocument()) {
        self.document = document
    }

    private var viewerAccountId: String? { PreviewData.sharedDocumentViewerAccountId }

    func load(_ source: DocumentSource) async throws -> DocumentResponse { document }

    func rawContent(_ document: DocumentResponse) async throws -> Data { Data() }

    private func nextId(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)preview_\(counter)"
    }

    private var now: String { ISO8601DateFormatter().string(from: Date()) }

    func toggleReaction(_ document: DocumentResponse, publicToken: String?, blockId: String, reaction: String, reader: DocumentReaderIdentity?) async throws -> [DocumentReaction] {
        if let index = self.document.reactions.firstIndex(where: { $0.blockId == blockId && $0.reaction == reaction && $0.mine }) {
            self.document.reactions.remove(at: index)
        } else {
            self.document.reactions.append(DocumentReaction(
                reactionId: nextId("docrx_"), blockId: blockId, reaction: reaction,
                actor: DocumentReactionActor(accountId: viewerAccountId, readerKey: nil, displayName: PreviewData.sharedDocumentViewerName),
                mine: true, createdAt: now
            ))
        }
        return self.document.reactions.filter { $0.blockId == blockId }
    }

    func postComment(_ document: DocumentResponse, publicToken: String?, blockId: String, body: String, parentCommentId: String?, reader: DocumentReaderIdentity?) async throws -> DocumentComment {
        let comment = DocumentComment(
            commentId: nextId("doccmt_"), blockId: blockId, parentCommentId: parentCommentId,
            author: DocumentCommentAuthor(accountId: viewerAccountId, displayName: PreviewData.sharedDocumentViewerName, kordiId: nil, avatarUrl: nil),
            body: body, mentionsAgent: document.agent.map { body.contains("@\($0.displayName)") } ?? false,
            mine: true, createdAt: now, editedAt: nil, resolvedAt: nil
        )
        self.document.upsert(comment)
        return comment
    }

    func updateComment(_ commentId: String, body: String?, resolved: Bool?) async throws -> DocumentComment {
        guard var comment = document.comments.first(where: { $0.commentId == commentId }) else {
            throw CloudAPIError(code: "not_found", message: "This comment is gone.", statusCode: 404)
        }
        if let body { comment.body = body; comment.editedAt = now }
        if let resolved { comment.resolvedAt = resolved ? now : nil }
        document.upsert(comment)
        return comment
    }

    func deleteComment(_ commentId: String) async throws {
        document.removeComment(commentId)
    }

    func createShare(attachmentId: String, sessionId: String?) async throws -> DocumentShare {
        let share = PreviewData.sharedDocumentShare(createdAt: now)
        document.share = share
        return share
    }

    func updateShare(_ shareId: String, readersCanAskAgent: Bool) async throws -> DocumentShare {
        guard var share = document.share else { return try await createShare(attachmentId: document.attachmentId, sessionId: nil) }
        share.readersCanAskAgent = readersCanAskAgent
        document.share = share
        return share
    }

    func deleteShare(_ shareId: String) async throws {
        document.share = nil
    }
}
