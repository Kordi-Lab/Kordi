import Foundation

/// Shapes of the shared documents routes (issue 1741). Field names match the
/// server JSON, which is camelCase. See
/// `docs/development/issue-1741-shared-documents.md`.
struct DocumentResponse: Codable, Equatable {
    let attachmentId: String
    let title: String
    let fileName: String
    let format: DocumentFormat
    let contentType: String
    let sizeBytes: Int64?
    let createdAt: String
    let updatedAt: String
    let sessionId: String?
    let sessionTitle: String?
    let author: DocumentAuthor
    let agent: DocumentAgent?
    let blocks: [DocumentBlock]
    let rawPath: String?
    var reactions: [DocumentReaction]
    var comments: [DocumentComment]
    var share: DocumentShare?
    let viewer: DocumentViewer
    let viewerCan: DocumentViewerCapabilities
    /// Content revision; absent from servers that predate editing.
    var revision: Int64? = nil
    /// The id the document was opened with, when it is a forwarded copy of
    /// `attachmentId` (the canonical document).
    var requestedAttachmentId: String? = nil
    /// The agent that made the latest edit, when an agent did.
    var updatedByAgentName: String? = nil
}

enum DocumentFormat: String, Codable, Equatable {
    case markdown
    case html
}

enum DocumentViewer: String, Codable, Equatable {
    case owner
    case member
    case `public`
}

struct DocumentAuthor: Codable, Equatable {
    let accountId: String
    let displayName: String
    let kordiId: String
    let avatarUrl: String?
}

struct DocumentAgent: Codable, Equatable {
    let displayName: String
}

struct DocumentBlock: Codable, Equatable, Identifiable {
    let id: String
    let source: String
    let html: String
}

struct DocumentViewerCapabilities: Codable, Equatable {
    let share: Bool
    let react: Bool
    let comment: Bool
    let askAgent: Bool
    /// Absent from servers that predate editing.
    var edit: Bool? = nil
}

struct DocumentShare: Codable, Equatable, Identifiable {
    let shareId: String
    let attachmentId: String
    let shareUrl: String
    let deepLink: String
    let accessMode: String
    var readersCanAskAgent: Bool
    let createdAt: String
    let revokedAt: String?

    var id: String { shareId }
}

struct DocumentSharesResponse: Codable, Equatable {
    let shares: [DocumentShare]
}

struct DocumentReaction: Codable, Equatable, Identifiable {
    let reactionId: String
    let blockId: String
    let reaction: String
    let actor: DocumentReactionActor
    let mine: Bool
    let createdAt: String

    var id: String { reactionId }
}

struct DocumentReactionActor: Codable, Equatable {
    let accountId: String?
    let readerKey: String?
    let displayName: String
}

struct DocumentReactionsResponse: Codable, Equatable {
    let reactions: [DocumentReaction]
}

struct DocumentComment: Codable, Equatable, Identifiable {
    let commentId: String
    let blockId: String
    let parentCommentId: String?
    let author: DocumentCommentAuthor
    var body: String
    let mentionsAgent: Bool
    let mine: Bool
    let createdAt: String
    var editedAt: String?
    var resolvedAt: String?
    /// Absent from servers that predate agents in documents.
    var kind: DocumentCommentKind? = nil
    /// Set on a comment whose mention started an agent run.
    var agentRun: DocumentAgentRun? = nil

    var id: String { commentId }
}

struct DocumentCommentAuthor: Codable, Equatable {
    let accountId: String?
    let displayName: String
    let kordiId: String?
    let avatarUrl: String?
    /// Agent authors only; public routes send the name alone.
    var agentId: String? = nil
    var ownerAccountId: String? = nil
}

// MARK: Request bodies

struct DocumentShareCreateRequest: Encodable {
    var sessionId: String?
    var readersCanAskAgent: Bool?
}

struct DocumentShareUpdateRequest: Encodable {
    let readersCanAskAgent: Bool
}

struct DocumentReactionRequest: Encodable {
    let blockId: String
    let reaction: String
    var readerKey: String? = nil
    var readerName: String? = nil
}

struct DocumentCommentCreateRequest: Encodable {
    let blockId: String
    let body: String
    var parentCommentId: String? = nil
    var readerKey: String? = nil
    var readerName: String? = nil
}

/// Links a forwarded copy to the document it was forwarded from.
struct DocumentSourceLinkRequest: Encodable, Equatable {
    let sourceAttachmentId: String
}

/// Omitted fields keep their current value on the server.
struct DocumentCommentUpdateRequest: Encodable {
    var body: String? = nil
    var resolved: Bool? = nil
}

// MARK: Presentation helpers

/// One emoji on one block, with how many people chose it.
struct DocumentReactionSummary: Equatable, Identifiable {
    let reaction: String
    let count: Int
    let mine: Bool

    var id: String { reaction }
}

extension DocumentResponse {
    /// Reactions on `blockId`, grouped by emoji in first-use order.
    func reactionSummaries(blockId: String) -> [DocumentReactionSummary] {
        var order: [String] = []
        var counts: [String: (count: Int, mine: Bool)] = [:]
        for reaction in reactions where reaction.blockId == blockId {
            if counts[reaction.reaction] == nil { order.append(reaction.reaction) }
            let current = counts[reaction.reaction] ?? (0, false)
            counts[reaction.reaction] = (current.count + 1, current.mine || reaction.mine)
        }
        return order.compactMap { emoji in
            counts[emoji].map { DocumentReactionSummary(reaction: emoji, count: $0.count, mine: $0.mine) }
        }
    }

    /// Unresolved top-level comments on `blockId`. Resolved threads leave the page.
    func openThreads(blockId: String) -> [DocumentComment] {
        comments.filter { $0.blockId == blockId && $0.parentCommentId == nil && $0.resolvedAt == nil }
    }

    func replies(to commentId: String) -> [DocumentComment] {
        comments.filter { $0.parentCommentId == commentId }
    }

    /// Replaces the reactions on one block with the server's list after a toggle.
    mutating func replaceReactions(blockId: String, with next: [DocumentReaction]) {
        reactions.removeAll { $0.blockId == blockId }
        reactions.append(contentsOf: next)
    }

    mutating func upsert(_ comment: DocumentComment) {
        if let index = comments.firstIndex(where: { $0.commentId == comment.commentId }) {
            comments[index] = comment
        } else {
            comments.append(comment)
        }
    }

    /// Deleting a comment also removes its replies, like the server cascade.
    mutating func removeComment(_ commentId: String) {
        comments.removeAll { $0.commentId == commentId || $0.parentCommentId == commentId }
    }
}

enum DocumentDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }

    /// "Oct 9, 2026" for the header pill.
    static func pill(_ value: String) -> String {
        guard let date = parse(value) else { return value }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// A time today, otherwise a short date, for comments.
    static func short(_ value: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parse(value) else { return "" }
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
