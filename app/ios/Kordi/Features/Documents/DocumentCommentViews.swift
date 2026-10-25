import SwiftUI
import UIKit

/// One open comment thread under a block: the comment, its replies, what
/// the mentioned agent is doing, a reply field, and the author's actions.
struct DocumentCommentThread: View {
    let comment: DocumentComment
    let document: DocumentResponse
    let mentionCandidates: [DocumentMentionCandidate]
    /// Set after an agent edited the document for this thread.
    let editedByAgentName: String?
    let canReply: Bool
    let canResolve: Bool
    let link: URL?
    let onReply: (String) -> Void
    let onEdit: (DocumentComment, String) -> Void
    let onDelete: (DocumentComment) -> Void
    let onResolve: () -> Void

    @State private var replyDraft = ""
    @State private var editing: DocumentComment?
    @State private var editDraft = ""
    @FocusState private var replyFocused: Bool

    private var entries: [DocumentThreadEntry] {
        document.threadEntries(for: comment, agentNames: DocumentMentionCandidates.agentNames(mentionCandidates))
    }

    private var mentionNames: [String] {
        mentionCandidates.map(\.mention) + entries.map(\.comment).filter(\.isAgentReply).map(\.author.displayName)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(entries) { item in
                if item.comment.isSystemReply {
                    DocumentThreadNoticeLine(text: item.comment.body)
                        .padding(.leading, 30)
                } else {
                    entry(item.comment, isReply: item.isReply)
                        .padding(.leading, item.isReply ? 30 : 0)
                }
                switch item.run {
                case .none:
                    EmptyView()
                case .working(let agentName):
                    DocumentAgentWorkingLine(agentName: agentName)
                        .padding(.leading, 30)
                case .failed:
                    DocumentAgentFailedLine(
                        onRetry: canReply && item.comment.mine ? { onReply(item.comment.body) } : nil
                    )
                    .padding(.leading, 30)
                }
            }
            if let editedByAgentName {
                DocumentThreadNoticeLine(text: "Edited by \(editedByAgentName)")
                    .padding(.leading, 30)
            }
            if canReply {
                DocumentCommentField(
                    placeholder: "Reply",
                    text: $replyDraft,
                    mentionCandidates: mentionCandidates,
                    focus: $replyFocused
                ) {
                    onReply(replyDraft)
                    replyDraft = ""
                }
                .padding(.leading, 30)
                if let agentName = document.editAgentName(inThread: comment.commentId),
                   !replyDraft.hasPrefix("@\(agentName)") {
                    DocumentAskAgentToEditButton(agentName: agentName) {
                        replyDraft = "@\(agentName) " + replyDraft
                        replyFocused = true
                    }
                    .padding(.leading, 30)
                }
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .alert("Edit comment", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            TextField("Comment", text: $editDraft)
            Button("Save") {
                if let editing { onEdit(editing, editDraft) }
                editing = nil
            }
            Button("Cancel", role: .cancel) { editing = nil }
        }
    }

    private func hasActions(_ item: DocumentComment, isReply: Bool) -> Bool {
        document.canEdit(item) || document.canDelete(item) || (!isReply && canResolve)
    }

    private func entry(_ item: DocumentComment, isReply: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                IdentityAvatar(
                    name: item.author.displayName,
                    imageSource: item.author.avatarUrl,
                    kind: item.isAgentReply ? .agent : .person,
                    size: 22,
                    seed: item.isAgentReply
                        ? item.author.agentId?.nonEmpty ?? item.author.displayName
                        : item.author.accountId
                )
                Text(item.author.displayName)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                if item.isAgentReply { DocumentAgentTag() }
                Text(DocumentDates.short(item.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if hasActions(item, isReply: isReply) {
                    Menu {
                        actions(for: item, isReply: isReply)
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 32, height: 28)
                            .contentShape(Rectangle())
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("More actions")
                }
                if !isReply, canResolve {
                    Button(action: onResolve) {
                        Image(systemName: "checkmark")
                            .font(.footnote.weight(.semibold))
                            .frame(width: 32, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Resolve")
                }
            }
            DocumentMentionText(text: item.body, names: mentionNames)
                .font(.subheadline)
                .padding(.leading, 30)
        }
        .contentShape(Rectangle())
        .contextMenu {
            if hasActions(item, isReply: isReply) {
                actions(for: item, isReply: isReply)
            }
        }
    }

    @ViewBuilder
    private func actions(for item: DocumentComment, isReply: Bool) -> some View {
        if document.canEdit(item) {
            if let link {
                Button {
                    UIPasteboard.general.url = URL(string: "\(link.absoluteString.split(separator: "#").first ?? "")#\(item.commentId)")
                } label: {
                    Label("Copy link", systemImage: "link")
                }
            }
            Button {
                editDraft = item.body
                editing = item
            } label: {
                Label("Edit", systemImage: "pencil")
            }
        }
        if !isReply, canResolve {
            Button(action: onResolve) { Label("Resolve", systemImage: "checkmark.circle") }
        }
        if document.canDelete(item) {
            Button(role: .destructive) { onDelete(item) } label: {
                Label("Delete comment", systemImage: "trash")
            }
        }
    }
}

/// A one-line comment field with an `@` picker and Post.
struct DocumentCommentField: View {
    let placeholder: String
    @Binding var text: String
    let mentionCandidates: [DocumentMentionCandidate]
    var focus: FocusState<Bool>.Binding? = nil
    let onPost: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if !mentionCandidates.isEmpty {
                Menu {
                    ForEach(mentionCandidates) { candidate in
                        Button {
                            insertMention(candidate.mention)
                        } label: {
                            Label(candidate.name, systemImage: candidate.isAgent ? "sparkles" : "person")
                        }
                    }
                } label: {
                    Image(systemName: "at")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 32, height: 32)
                        .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                }
                .accessibilityLabel("Mention")
            }
            field
                .font(.subheadline)
                .lineLimit(1...4)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            Button("Post", action: onPost)
                .font(.subheadline.weight(.semibold))
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder
    private var field: some View {
        let field = TextField(placeholder, text: $text, axis: .vertical)
        if let focus { field.focused(focus) } else { field }
    }

    private func insertMention(_ name: String) {
        let needsSpace = !(text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n"))
        text += (needsSpace ? " " : "") + "@\(name) "
    }
}

/// The composer that opens under a block after Comment.
struct DocumentCommentComposer: View {
    let mentionCandidates: [DocumentMentionCandidate]
    let onPost: (String) -> Void
    let onCancel: () -> Void
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            DocumentCommentField(
                placeholder: "Add a comment",
                text: $draft,
                mentionCandidates: mentionCandidates
            ) {
                onPost(draft)
                draft = ""
            }
            Button("Cancel", action: onCancel)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Comment text with `@Name` mentions of known people and the agent tinted.
struct DocumentMentionText: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let text: String
    let names: [String]

    var body: some View {
        Text(attributed)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributed: AttributedString {
        var result = AttributedString(text)
        for name in names.sorted(by: { $0.count > $1.count }) {
            var searchStart = result.startIndex
            while let range = result[searchStart...].range(of: "@\(name)") {
                result[range].foregroundColor = chatTheme.accent
                result[range].font = .subheadline.weight(.semibold)
                searchStart = range.upperBound
            }
        }
        return result
    }
}
