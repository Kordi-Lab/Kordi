import Foundation

/// Synthetic shared document for `--preview-shared-document`. The people,
/// Kordi ID, and share token are placeholders.
extension PreviewData {
    static let sharedDocumentViewerAccountId = "acct_me"
    static let sharedDocumentViewerName = "Alex Morgan"
    static let sharedDocumentToken = "kordi_ds_" + String(repeating: "x", count: 43)

    static func sharedDocumentShare(createdAt: String = "2026-10-09T09:31:00Z") -> DocumentShare {
        DocumentShare(
            shareId: "docshare_preview",
            attachmentId: "att_preview_related_work",
            shareUrl: "https://kordi.ai/d/\(sharedDocumentToken)",
            deepLink: "kordi://document/\(sharedDocumentToken)",
            accessMode: "link",
            readersCanAskAgent: true,
            createdAt: createdAt,
            revokedAt: nil
        )
    }

    static func sharedDocument(now: Date = Date()) -> DocumentResponse {
        let stamp = ISO8601DateFormatter().string(from: now.addingTimeInterval(-1_800))
        let blocks = [
            "## Summary",
            "Almost all published work on agents in human groups studies one shared agent inside a group of people. Kordi's configuration, where every person brings their own agent into a shared conversation, has no end-to-end prior study.",
            "That configuration is the most defensible niche for Kordi, and it inherits the hardest open problem in the literature: keeping each person's private context from leaking across users.",
            "## 1. Coordination theory",
            "- **Coordination theory**: managing dependencies between activities.\n- **Grounding**: collaborators keep checking that they understand each other.\n- **Awareness**: knowing what others are doing.",
            "| Paper | Method | Claim |\n| --- | --- | --- |\n| Human to agent collaboration | Framework | Agents act like remote colleagues |\n| The collaboration gap | 16 interviews | Partnership outpaces grounding |",
            "## 2. When an agent speaks",
            "Turn-taking in a group with several agents is the technical core. The open question is whether an agent answers only when addressed by name.",
        ].enumerated().map { DocumentBlock(id: "b\($0.offset)", source: $0.element, html: "") }
        func reaction(_ id: String, _ block: String, _ emoji: String, _ name: String, mine: Bool = false) -> DocumentReaction {
            DocumentReaction(
                reactionId: id, blockId: block, reaction: emoji,
                actor: DocumentReactionActor(accountId: mine ? sharedDocumentViewerAccountId : "acct_\(name.lowercased())", readerKey: nil, displayName: name),
                mine: mine, createdAt: stamp
            )
        }
        func comment(_ id: String, _ block: String, _ name: String, _ body: String, parent: String? = nil, agent: Bool = false) -> DocumentComment {
            DocumentComment(
                commentId: id, blockId: block, parentCommentId: parent,
                author: DocumentCommentAuthor(accountId: "acct_\(name.lowercased())", displayName: name, kordiId: nil, avatarUrl: nil),
                body: body, mentionsAgent: agent, mine: false, createdAt: stamp, editedAt: nil, resolvedAt: nil
            )
        }
        return DocumentResponse(
            attachmentId: "att_preview_related_work",
            title: "Kordi Related Work",
            fileName: "kordi-related-work.md",
            format: .markdown,
            contentType: "text/markdown",
            sizeBytes: 18_432,
            createdAt: "2026-10-09T09:31:00Z",
            updatedAt: "2026-10-09T09:31:00Z",
            sessionId: "session:group:mobile",
            sessionTitle: "Related work",
            author: DocumentAuthor(accountId: sharedDocumentViewerAccountId, displayName: "Alex Morgan", kordiId: "123456789", avatarUrl: nil),
            agent: DocumentAgent(displayName: "Lab agent"),
            blocks: blocks,
            rawPath: nil,
            reactions: [
                reaction("docrx_1", "b1", "👍", "Theo"),
                reaction("docrx_2", "b1", "👍", "Alex Morgan", mine: true),
                reaction("docrx_3", "b2", "❤️", "Priya"),
            ],
            comments: [
                comment("doccmt_1", "b2", "Priya", "@Lab agent what does \"defensible niche\" mean here?", agent: true),
                comment("doccmt_2", "b7", "Theo", "Worth adding the turn-taking benchmark here."),
                comment("doccmt_3", "b7", "Priya", "Agreed, I'll find the link.", parent: "doccmt_2"),
            ],
            share: sharedDocumentShare(),
            viewer: .owner,
            viewerCan: DocumentViewerCapabilities(share: true, react: true, comment: true, askAgent: true)
        )
    }

    /// The people the comment composer offers besides the agent.
    static let sharedDocumentPeople = ["Priya", "Theo"]
}
