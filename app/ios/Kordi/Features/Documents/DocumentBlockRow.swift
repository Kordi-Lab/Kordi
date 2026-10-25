import SwiftUI

/// One document block: its content, the floating menu when selected, its
/// reaction pills, its open comment threads, and the composer.
struct DocumentBlockRow<Content: View>: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let block: DocumentBlock
    let reader: DocumentReaderModel
    let document: DocumentResponse
    let mentionCandidates: [DocumentMentionCandidate]
    let isSelected: Bool
    let isComposing: Bool
    @Binding var showsReactions: Bool
    let onSelect: () -> Void
    let onComment: () -> Void
    let onCloseComposer: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var menuHeight: CGFloat = 44

    private var isPublic: Bool { document.viewer == .public }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content()
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .background(
                    isSelected ? chatTheme.accent.opacity(0.1) : .clear,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
                .contentShape(Rectangle())
                .onTapGesture(perform: onSelect)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Shows comment and react")
                .overlay(alignment: .topLeading) {
                    if isSelected {
                        DocumentSelectionMenu(
                            showsFormatting: !isPublic,
                            canComment: document.viewerCan.comment,
                            canReact: document.viewerCan.react,
                            showsReactions: $showsReactions,
                            onComment: onComment,
                            onReact: { emoji in
                                reader.toggleReaction(blockId: block.id, reaction: emoji)
                                onSelect()
                            }
                        )
                        .background {
                            GeometryReader { proxy in
                                Color.clear.preference(key: DocumentMenuHeightKey.self, value: proxy.size.height)
                            }
                        }
                        .onPreferenceChange(DocumentMenuHeightKey.self) { menuHeight = $0 }
                        .offset(y: -menuHeight - 6)
                        .transition(.opacity)
                    }
                }

            let summaries = document.reactionSummaries(blockId: block.id)
            if !summaries.isEmpty {
                DocumentReactionPills(summaries: summaries, canReact: document.viewerCan.react) { emoji in
                    reader.toggleReaction(blockId: block.id, reaction: emoji)
                }
                .padding(.horizontal, 6)
            }

            ForEach(document.openThreads(blockId: block.id)) { comment in
                DocumentCommentThread(
                    comment: comment,
                    document: document,
                    mentionCandidates: mentionCandidates,
                    editedByAgentName: reader.agentEditNotices[comment.commentId],
                    canReply: document.viewerCan.comment,
                    canResolve: reader.canResolve(comment),
                    link: reader.shareURL,
                    onReply: { reader.postComment(blockId: block.id, body: $0, parentCommentId: comment.commentId) },
                    onEdit: { reader.editComment($0, body: $1) },
                    onDelete: { reader.deleteComment($0) },
                    onResolve: { reader.resolve(comment) }
                )
            }

            if isComposing {
                DocumentCommentComposer(
                    mentionCandidates: mentionCandidates,
                    onPost: { body in
                        reader.postComment(blockId: block.id, body: body)
                        onCloseComposer()
                    },
                    onCancel: onCloseComposer
                )
            }
        }
        .zIndex(isSelected ? 1 : 0)
    }
}

private struct DocumentMenuHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 44
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The People card for the `@author` chip.
struct DocumentPeopleCard: View {
    let author: DocumentAuthor
    /// Nil hides Message: the author is the viewer, or there is no chat to open.
    let onMessage: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsSectionTitle("People")
            HStack(spacing: 12) {
                IdentityAvatar(
                    name: author.displayName,
                    imageSource: author.avatarUrl,
                    kind: .person,
                    size: 48,
                    seed: author.accountId
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(author.displayName).font(.headline)
                    Text("Kordi ID \(Self.formattedKordiId(author.kordiId))")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 8)
                if let onMessage {
                    Button("Message", action: onMessage)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "123 456 789" for a nine-digit number; handles as is.
    static func formattedKordiId(_ value: String) -> String {
        let digits = value.filter(\.isNumber)
        guard digits.count == 9, digits.count == value.count else { return value }
        let chars = Array(digits)
        return [chars[0..<3], chars[3..<6], chars[6..<9]].map { String($0) }.joined(separator: " ")
    }
}
