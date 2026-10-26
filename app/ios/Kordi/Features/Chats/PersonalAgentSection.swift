import SwiftUI

extension AppModel {
    /// The Personal agent rows of the Agents tab (#2091).
    func personalAgentRows(searchText: String = "") -> [ConversationSummary] {
        PersonalAgentSessionCatalog.rows(
            conversations: conversations,
            personalAgents: personalAgents,
            ownAccountId: account?.accountId ?? "",
            activeOwnedAgentIds: loadedActiveOwnedAgentIds,
            searchText: searchText
        )
    }
}

/// The Personal agent section above Pinned and Recents: one always-online
/// session per owned agent. Rows offer read state and mute only.
struct PersonalAgentSection: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let searchQuery: String
    let onOpen: (ConversationSummary) -> Void

    var body: some View {
        let rows = model.personalAgentRows(searchText: searchQuery)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("Personal agent")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 44 : 32, alignment: .leading)
                    .padding(.horizontal, 16)
                    .accessibilityAddTraits(.isHeader)
                ForEach(rows) { row($0) }
            }
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
    }

    private func row(_ conversation: ConversationSummary) -> some View {
        let isMuted = model.mutedSessionIds.contains(conversation.sessionId)
        let actions = PersonalAgentRowAction.available(isUnread: conversation.hasUnreadAttention, isMuted: isMuted)
        return Button {
            onOpen(conversation)
        } label: {
            PersonalAgentRow(conversation: conversation, isMuted: isMuted)
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(actions, id: \.self) { action in
                Button {
                    perform(action, on: conversation)
                } label: {
                    Label(action.title, systemImage: action.systemImage)
                }
            }
        }
        .accessibilityActions {
            ForEach(actions, id: \.self) { action in
                Button(action.title) { perform(action, on: conversation) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(uiColor: .separator).opacity(0.45))
                .frame(height: 0.5)
                .padding(.leading, PersonalAgentRow.separatorLeading)
        }
    }

    private func perform(_ action: PersonalAgentRowAction, on conversation: ConversationSummary) {
        Task {
            switch action {
            case .markRead:
                await model.markConversationRead(conversation)
            case .markUnread:
                _ = await model.setConversationUnread(conversation, unread: true)
            case .mute, .unmute:
                _ = await model.setConversationMuted(conversation, muted: action == .mute)
            }
        }
    }
}

struct PersonalAgentRow: View {
    static let avatarSize: CGFloat = 36
    static let separatorLeading: CGFloat = 16 + avatarSize + 10

    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let conversation: ConversationSummary
    var isMuted = false

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            PersonalAgentAvatar(conversation: conversation, size: Self.avatarSize)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(PersonalAgentSessionCatalog.name(of: conversation))
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .layoutPriority(1)
                    ChatListStateIndicators(isPinned: false, isMuted: isMuted)
                    Spacer(minLength: 8)
                    Text(chatListTimestamp(conversation.lastActivityAt))
                        .font(.caption)
                        .foregroundStyle(conversation.hasUnreadAttention && !isMuted ? chatTheme.accent : .secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                HStack(alignment: .center, spacing: 8) {
                    BlobEmojiPreviewText(text: PersonalAgentSessionCatalog.preview(of: conversation))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ConversationAttentionBadge(
                        unreadCount: conversation.unreadCount,
                        mentionCount: conversation.unreadMentionCount,
                        isMuted: isMuted
                    )
                }
            }
        }
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 46, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Double-tap to open. Touch and hold for more actions.")
    }

    private var accessibilityLabel: String {
        let unread = conversation.unreadCount > 0 ? ", \(conversation.unreadCount) unread" : ""
        let preview = BlobEmojiComposerText.plainText(PersonalAgentSessionCatalog.preview(of: conversation))
        return "\(PersonalAgentSessionCatalog.name(of: conversation)), \(PersonalAgentPresentation.onlineStatus)\(unread)"
            + ChatListStateIndicators.accessibilitySuffix(isPinned: false, isMuted: isMuted)
            + ". \(preview)"
    }
}

/// An agent's rounded-square avatar with the green online dot of a
/// personal session.
struct PersonalAgentAvatar: View {
    let conversation: ConversationSummary
    var size: CGFloat = PersonalAgentRow.avatarSize
    /// The surface behind the avatar, so the dot reads as cut out of it.
    var ringColor = Color(uiColor: .systemBackground)

    private var dotSize: CGFloat { max(9, (size * 0.26).rounded()) }
    private var ringWidth: CGFloat { size >= 40 ? 2.5 : 2 }

    var body: some View {
        IdentityAvatar(
            name: PersonalAgentSessionCatalog.name(of: conversation),
            imageSource: conversation.avatarSource,
            kind: .agent,
            size: size,
            seed: conversation.agentId?.nonEmpty ?? conversation.sessionId
        )
        .overlay(alignment: .bottomTrailing) {
            Circle()
                .fill(Color(uiColor: .systemGreen))
                .frame(width: dotSize, height: dotSize)
                .padding(ringWidth)
                .background(Circle().fill(ringColor))
                .offset(x: ringWidth + 1, y: ringWidth + 1)
        }
        .accessibilityHidden(true)
    }
}
