import Foundation

/// Shared documents routes (issue 1741). Authenticated routes take the
/// session token; public routes take a share token and no bearer.
extension CloudAPIClient {
    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }

    func document(token: String, attachmentId: String) async throws -> DocumentResponse {
        try await send(
            path: "/v1/cloud/documents/\(Self.pathComponent(attachmentId))",
            method: "GET",
            token: token,
            fallback: "Could not open this document."
        )
    }

    func publicDocument(shareToken: String) async throws -> DocumentResponse {
        try await send(
            path: "/v1/cloud/public/documents/\(Self.pathComponent(shareToken))",
            method: "GET",
            fallback: "Could not open this document."
        )
    }

    /// Points a forwarded copy at the document it came from, so both share
    /// one set of reactions, comments, revision, and link. Answers the
    /// canonical document.
    @discardableResult
    func linkDocumentSource(token: String, attachmentId: String, sourceAttachmentId: String) async throws -> DocumentResponse {
        try await send(
            path: "/v1/cloud/documents/\(Self.pathComponent(attachmentId))/source",
            method: "POST",
            token: token,
            body: DocumentSourceLinkRequest(sourceAttachmentId: sourceAttachmentId),
            fallback: "Could not link the forwarded document."
        )
    }

    /// Returns the live share when one exists, otherwise creates it.
    func createDocumentShare(token: String, attachmentId: String, sessionId: String?) async throws -> DocumentShare {
        try await send(
            path: "/v1/cloud/documents/\(Self.pathComponent(attachmentId))/shares",
            method: "POST",
            token: token,
            body: DocumentShareCreateRequest(sessionId: sessionId, readersCanAskAgent: true),
            fallback: "Could not turn on the link."
        )
    }

    func documentShares(token: String, attachmentId: String) async throws -> [DocumentShare] {
        let response: DocumentSharesResponse = try await send(
            path: "/v1/cloud/documents/\(Self.pathComponent(attachmentId))/shares",
            method: "GET",
            token: token,
            fallback: "Could not load the link."
        )
        return response.shares
    }

    func updateDocumentShare(token: String, shareId: String, readersCanAskAgent: Bool) async throws -> DocumentShare {
        try await send(
            path: "/v1/cloud/documents/shares/\(Self.pathComponent(shareId))",
            method: "PATCH",
            token: token,
            body: DocumentShareUpdateRequest(readersCanAskAgent: readersCanAskAgent),
            fallback: "Could not update the link."
        )
    }

    func deleteDocumentShare(token: String, shareId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/documents/shares/\(Self.pathComponent(shareId))",
            method: "DELETE",
            token: token,
            fallback: "Could not turn off the link."
        )
    }

    /// Toggles one reaction and returns the block's reactions after the toggle.
    func toggleDocumentReaction(token: String, attachmentId: String, blockId: String, reaction: String) async throws -> [DocumentReaction] {
        let response: DocumentReactionsResponse = try await send(
            path: "/v1/cloud/documents/\(Self.pathComponent(attachmentId))/reactions",
            method: "POST",
            token: token,
            body: DocumentReactionRequest(blockId: blockId, reaction: reaction),
            fallback: "Could not save the reaction."
        )
        return response.reactions
    }

    func togglePublicDocumentReaction(
        shareToken: String,
        blockId: String,
        reaction: String,
        readerKey: String,
        readerName: String
    ) async throws -> [DocumentReaction] {
        let response: DocumentReactionsResponse = try await send(
            path: "/v1/cloud/public/documents/\(Self.pathComponent(shareToken))/reactions",
            method: "POST",
            body: DocumentReactionRequest(blockId: blockId, reaction: reaction, readerKey: readerKey, readerName: readerName),
            fallback: "Could not save the reaction."
        )
        return response.reactions
    }

    func postDocumentComment(
        token: String,
        attachmentId: String,
        blockId: String,
        body: String,
        parentCommentId: String?
    ) async throws -> DocumentComment {
        try await send(
            path: "/v1/cloud/documents/\(Self.pathComponent(attachmentId))/comments",
            method: "POST",
            token: token,
            body: DocumentCommentCreateRequest(blockId: blockId, body: body, parentCommentId: parentCommentId),
            fallback: "Could not post the comment."
        )
    }

    func postPublicDocumentComment(
        shareToken: String,
        blockId: String,
        body: String,
        parentCommentId: String?,
        readerKey: String,
        readerName: String
    ) async throws -> DocumentComment {
        try await send(
            path: "/v1/cloud/public/documents/\(Self.pathComponent(shareToken))/comments",
            method: "POST",
            body: DocumentCommentCreateRequest(
                blockId: blockId,
                body: body,
                parentCommentId: parentCommentId,
                readerKey: readerKey,
                readerName: readerName
            ),
            fallback: "Could not post the comment."
        )
    }

    func updateDocumentComment(token: String, commentId: String, body: String?, resolved: Bool?) async throws -> DocumentComment {
        try await send(
            path: "/v1/cloud/documents/comments/\(Self.pathComponent(commentId))",
            method: "PATCH",
            token: token,
            body: DocumentCommentUpdateRequest(body: body, resolved: resolved),
            fallback: "Could not update the comment."
        )
    }

    func deleteDocumentComment(token: String, commentId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/documents/comments/\(Self.pathComponent(commentId))",
            method: "DELETE",
            token: token,
            fallback: "Could not delete the comment."
        )
    }

    /// The bytes of an HTML document from its `rawPath`: the authenticated
    /// raw route with a bearer header, or the public `/d/<token>/raw` route
    /// without one.
    func documentRawContent(token: String?, rawPath: String) async throws -> Data {
        let fallback = "Could not open this document."
        guard rawPath.hasPrefix("/v1/cloud/documents/") || rawPath.hasPrefix("/d/") else {
            throw CloudAPIError(code: "invalid_response", message: fallback, statusCode: 0)
        }
        var request = try makeRequest(path: rawPath, method: "GET", token: token, query: [], body: nil)
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 60
        let (data, response) = try await transportData(for: request, fallback: fallback)
        try validate(response: response, data: data, fallback: fallback)
        return data
    }
}
