import Foundation

/// An account the signed-in person blocked. The list is private to them.
struct CloudBlockedAccount: Codable, Hashable, Identifiable {
    let accountId: String
    var kordiId: String? = nil
    var displayName: String? = nil
    var avatarUrl: String? = nil
    var blockedAt: String? = nil

    var id: String { accountId }
    var preferredName: String { displayName?.nonEmpty ?? kordiId?.nonEmpty ?? "Kordi user" }
}

/// `PUT /v1/cloud/blocks/{account_id}`.
struct CloudBlockResult: Codable, Hashable {
    let block: CloudBlockedAccount
    /// Whether the block ended an accepted contact relationship.
    var removedContact: Bool = false
}

/// Report reasons the app offers, with their API values.
enum CloudReportReason: String, Codable, CaseIterable, Identifiable {
    case spam
    case harassment
    case inappropriate
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .spam: "Spam"
        case .harassment: "Harassment or hate"
        case .inappropriate: "Sexual or violent content"
        case .other: "Something else"
        }
    }
}

/// `POST /v1/cloud/reports`. Absent values are left out of the JSON body.
struct CloudReportRequest: Encodable, Equatable {
    static let maxDetailsLength = 1_000

    let clientReportId: String
    let reason: CloudReportReason
    var details: String? = nil
    var reportedAccountId: String? = nil
    var conversationId: String? = nil
    var messageIds: [String]? = nil
    var contactRequestId: String? = nil
    var alsoBlock: Bool? = nil
}

/// The receipt for a report the server received.
struct CloudReportReceipt: Codable, Hashable {
    let reportId: String
    let reference: String
    let status: String
    let reason: String
    let targetKind: String
    var evidenceMessageCount: Int = 0
    var reportedDisplayName: String? = nil
    let createdAt: String
    var closedAt: String? = nil
}

struct CloudReportResult: Codable, Hashable {
    let report: CloudReportReceipt
    /// True when `alsoBlock` was honoured.
    var blocked: Bool = false
}

private struct CloudBlockListResponse: Decodable {
    let blocks: [CloudBlockedAccount]
}

private struct CloudSafetyEmptyBody: Encodable {}

extension CloudAPIClient {
    private static let safetyPathSegment = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    private static func safetySegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: safetyPathSegment) ?? value
    }

    /// The signed-in person's blocks, newest first.
    func listBlockedAccounts(token: String) async throws -> [CloudBlockedAccount] {
        let response: CloudBlockListResponse = try await send(
            path: "/v1/cloud/blocks",
            method: "GET",
            token: token,
            fallback: "Could not load blocked accounts."
        )
        return response.blocks
    }

    /// Idempotent. The server also removes the contact and pending requests.
    func blockAccount(token: String, accountId: String) async throws -> CloudBlockResult {
        try await send(
            path: "/v1/cloud/blocks/\(Self.safetySegment(accountId))",
            method: "PUT",
            token: token,
            body: CloudSafetyEmptyBody(),
            fallback: "Could not block this account."
        )
    }

    /// Idempotent; the contact is not restored.
    func unblockAccount(token: String, accountId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/blocks/\(Self.safetySegment(accountId))",
            method: "DELETE",
            token: token,
            fallback: "Could not unblock this account."
        )
    }

    /// Sends a report. A message report names messages by their chat sync v2
    /// ids; `sessionId` is resolved to the v2 conversation id here. Reusing
    /// `clientReportId` makes a retry of the same report safe.
    func createReport(token: String, request: CloudReportRequest, sessionId: String?) async throws -> CloudReportResult {
        var request = request
        if let messageIds = request.messageIds, !messageIds.isEmpty, request.conversationId == nil {
            guard let sessionId = sessionId?.nonEmpty,
                  let conversationId = try await chatConversationId(token: token, sessionId: sessionId) else {
                throw CloudAPIError(code: "chat_conversation_missing", message: "This conversation is unavailable.", statusCode: 404)
            }
            request.conversationId = conversationId
        }
        return try await send(
            path: "/v1/cloud/reports",
            method: "POST",
            token: token,
            body: request,
            fallback: "Could not send the report."
        )
    }

    /// The v2 conversation id for a session, bootstrapping chat sync once
    /// when the conversation is not cached yet.
    private func chatConversationId(token: String, sessionId: String) async throws -> String? {
        func cached() -> String? {
            cachedChatConversations().first { $0.id == sessionId || $0.legacySessionId == sessionId }?.id
        }
        if let id = cached() { return id }
        _ = try await bootstrapChatLatestMessages(token: token)
        return cached()
    }
}
