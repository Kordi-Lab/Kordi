import Foundation

/// Agents in shared documents (issue 1741): who wrote a comment, the run a
/// mention started, and how a thread presents both.
enum DocumentCommentKind: String, Codable, Equatable {
    case person
    case agent
    case system

    /// A kind this build does not know reads as a person's comment.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DocumentCommentKind(rawValue: raw) ?? .person
    }
}

struct DocumentAgentRun: Codable, Equatable {
    enum Status: String, Codable, Equatable {
        case queued
        case running
        case completed
        case failed
        case unknown

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .unknown
        }
    }

    let status: Status

    var isActive: Bool { status == .queued || status == .running }
}

extension DocumentComment {
    var isAgentReply: Bool { kind == .agent }
    var isSystemReply: Bool { kind == .system }
    var hasActiveAgentRun: Bool { agentRun?.isActive ?? false }
}

/// One line of a thread: a comment and what its agent run shows under it.
struct DocumentThreadEntry: Equatable, Identifiable {
    enum Run: Equatable {
        case none
        /// The agent is queued or running; the value is its name.
        case working(String)
        case failed
    }

    let comment: DocumentComment
    let isReply: Bool
    let run: Run

    var id: String { comment.commentId }
}

extension DocumentResponse {
    static let fallbackAgentName = "Agent"

    /// True while any open thread waits for an agent.
    var hasActiveAgentRun: Bool { !activeAgentRunThreadIds.isEmpty }

    /// Root comment ids of the open threads that wait for an agent.
    var activeAgentRunThreadIds: Set<String> {
        let resolved = Set(comments.filter { $0.parentCommentId == nil && $0.resolvedAt != nil }.map(\.commentId))
        return Set(comments.filter(\.hasActiveAgentRun)
            .map { $0.parentCommentId ?? $0.commentId }
            .filter { !resolved.contains($0) })
    }

    /// The thread in display order. A system reply that reports a failed run
    /// is left out, because the failed line under the mention replaces it.
    /// `agentNames` are the agents the viewer can mention.
    func threadEntries(for root: DocumentComment, agentNames: [String] = []) -> [DocumentThreadEntry] {
        let replies = replies(to: root.commentId)
        let all = [root] + replies
        var hidden = Set<String>()
        for (index, comment) in all.enumerated() where comment.agentRun?.status == .failed {
            let report = all[(index + 1)...].first { $0.isSystemReply && !hidden.contains($0.commentId) }
            if let report { hidden.insert(report.commentId) }
        }
        return all.enumerated().compactMap { index, comment in
            guard !hidden.contains(comment.commentId) else { return nil }
            return DocumentThreadEntry(
                comment: comment,
                isReply: index > 0,
                run: run(for: comment, replies: replies, agentNames: agentNames)
            )
        }
    }

    private func run(for comment: DocumentComment, replies: [DocumentComment], agentNames: [String]) -> DocumentThreadEntry.Run {
        if let agentRun = comment.agentRun {
            if agentRun.isActive { return .working(agentName(mentionedIn: comment.body, agentNames: agentNames)) }
            return agentRun.status == .failed ? .failed : .none
        }
        // Servers that predate agent runs send no kind: a mention without
        // any reply is assumed to be waiting.
        if comment.kind == nil, comment.parentCommentId == nil, comment.mentionsAgent, replies.isEmpty {
            return .working(agentName(mentionedIn: comment.body, agentNames: agentNames))
        }
        return .none
    }

    /// The agent a comment mentions: the longest known name in its text,
    /// else the document's agent.
    func agentName(mentionedIn body: String, agentNames: [String]) -> String {
        let known = agentNames.filter { !$0.isEmpty }.sorted { $0.count > $1.count }
        if let match = known.first(where: { body.range(of: "@\($0)", options: .caseInsensitive) != nil }) {
            return match
        }
        return agent?.displayName.nonEmpty ?? Self.fallbackAgentName
    }

    /// The person's comment an agent or system reply answers: the closest
    /// earlier comment of its thread that mentioned an agent.
    func commentAnswered(by reply: DocumentComment) -> DocumentComment? {
        guard reply.isAgentReply || reply.isSystemReply, let rootId = reply.parentCommentId,
              let root = comments.first(where: { $0.commentId == rootId }) else { return nil }
        let all = [root] + replies(to: rootId)
        guard let index = all.firstIndex(where: { $0.commentId == reply.commentId }) else { return nil }
        return all[..<index].last { ($0.agentRun != nil || $0.mentionsAgent) && !$0.isAgentReply && !$0.isSystemReply }
    }

    /// Authors edit their own comments; nobody edits an agent's.
    func canEdit(_ comment: DocumentComment) -> Bool {
        comment.mine && !comment.isAgentReply && !comment.isSystemReply
    }

    /// Authors delete their own comments. An agent's reply can be deleted by
    /// the document owner and by the person whose mention it answers.
    func canDelete(_ comment: DocumentComment) -> Bool {
        guard comment.isAgentReply || comment.isSystemReply else { return comment.mine }
        guard viewer != .public else { return false }
        return viewer == .owner || commentAnswered(by: comment)?.mine == true
    }

    /// The agent of the latest agent reply in a thread, for "Ask to edit".
    func editAgentName(inThread rootId: String) -> String? {
        guard viewerCan.edit == true, viewerCan.comment else { return nil }
        return replies(to: rootId).last(where: \.isAgentReply)?.author.displayName.nonEmpty
    }
}
