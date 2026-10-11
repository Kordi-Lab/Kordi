import SwiftUI
import UIKit

/// Someone the comment composer can mention.
struct DocumentMentionCandidate: Hashable, Identifiable {
    let name: String
    let isAgent: Bool
    var id: String { (isAgent ? "agent:" : "person:") + name }
}

/// One open comment thread under a block: the comment, its replies, a reply
/// field, and the author's actions.
struct DocumentCommentThread: View {
    let comment: DocumentComment
    let replies: [DocumentComment]
    let agentName: String?
    let mentionCandidates: [DocumentMentionCandidate]
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            entry(comment, isReply: false)
            ForEach(replies) { reply in
                entry(reply, isReply: true)
                    .padding(.leading, 30)
            }
            if comment.mentionsAgent, replies.isEmpty, let agentName {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("\(agentName) is working")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, 30)
                .accessibilityElement(children: .combine)
            }
            if canReply {
                DocumentCommentField(
                    placeholder: "Reply",
                    text: $replyDraft,
                    mentionCandidates: mentionCandidates
                ) {
                    onReply(replyDraft)
                    replyDraft = ""
                }
                .padding(.leading, 30)
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

    private func entry(_ item: DocumentComment, isReply: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                IdentityAvatar(
                    name: item.author.displayName,
                    imageSource: item.author.avatarUrl,
                    kind: .person,
                    size: 22,
                    seed: item.author.accountId
                )
                Text(item.author.displayName)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                Text(DocumentDates.short(item.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if item.mine || (!isReply && canResolve) {
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
            DocumentMentionText(text: item.body, names: mentionCandidates.map(\.name))
                .font(.subheadline)
                .padding(.leading, 30)
        }
        .contentShape(Rectangle())
        .contextMenu {
            if item.mine || (!isReply && canResolve) {
                actions(for: item, isReply: isReply)
            }
        }
    }

    @ViewBuilder
    private func actions(for item: DocumentComment, isReply: Bool) -> some View {
        if item.mine {
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
        if item.mine {
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
    let onPost: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if !mentionCandidates.isEmpty {
                Menu {
                    ForEach(mentionCandidates) { candidate in
                        Button {
                            insertMention(candidate.name)
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
            TextField(placeholder, text: $text, axis: .vertical)
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
                result[range].foregroundColor = KordiTheme.signalBlue
                result[range].font = .subheadline.weight(.semibold)
                searchStart = range.upperBound
            }
        }
        return result
    }
}
