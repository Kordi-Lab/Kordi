import SwiftUI

struct GroupSpaceRow: View {
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let space: GroupSpaceSummary
    let isExpanded: Bool
    var mutedSessionIds: Set<String> = []
    var isPinned = false
    var isMuted = false

    var body: some View {
        HStack(alignment: dynamicTypeSize.isAccessibilitySize ? .top : .center, spacing: 11) {
            GroupAvatarStack(
                participants: space.participants,
                size: dynamicTypeSize.isAccessibilitySize ? 52 : 44
            )

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(space.displayName)
                        .font(.headline)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .layoutPriority(1)
                    ChatListStateIndicators(isPinned: isPinned, isMuted: isMuted)
                }

                BlobEmojiPreviewText(text: space.lastMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)

                if dynamicTypeSize.isAccessibilitySize {
                    Text(detailText)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 4) {
                Text(chatListTimestamp(space.lastActivityAt))
                    .font(.caption)
                    .foregroundStyle(
                        unmutedUnreadCount > 0 || unmutedMentionCount > 0
                            ? KordiTheme.signalBlue
                            : .secondary
                    )
                HStack(spacing: 5) {
                    if !isExpanded {
                        ConversationAttentionBadge(
                            unreadCount: displayedUnreadCount,
                            mentionCount: displayedMentionCount,
                            isMuted: showsOnlyMutedAttention
                        )
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 0 : -90))
                        .animation(
                            accessibilityReduceMotion ? nil : .snappy(duration: 0.22),
                            value: isExpanded
                        )
                }
            }
        }
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 64 : 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            space.accessibilitySummary
                + ChatListStateIndicators.accessibilitySuffix(isPinned: isPinned, isMuted: isMuted)
        )
        .accessibilityHint(isExpanded ? "Collapse sessions" : "Expand sessions")
    }

    private var detailText: String {
        let people = space.participants.count == 1 ? "1 person" : "\(space.participants.count) people"
        let sessions = space.sessions.count == 1 ? "1 session" : "\(space.sessions.count) sessions"
        return "Group · \(people) · \(sessions)"
    }

    private var unmutedUnreadCount: Int {
        space.sessions.lazy
            .filter { !mutedSessionIds.contains($0.sessionId) }
            .reduce(0) { $0 + $1.unreadCount }
    }

    private var unmutedMentionCount: Int {
        space.sessions.lazy
            .filter { !mutedSessionIds.contains($0.sessionId) }
            .reduce(0) { $0 + $1.unreadMentionCount }
    }

    private var mutedUnreadCount: Int {
        space.sessions.lazy
            .filter { mutedSessionIds.contains($0.sessionId) }
            .reduce(0) { $0 + $1.unreadCount }
    }

    private var mutedMentionCount: Int {
        space.sessions.lazy
            .filter { mutedSessionIds.contains($0.sessionId) }
            .reduce(0) { $0 + $1.unreadMentionCount }
    }

    private var showsOnlyMutedAttention: Bool {
        unmutedUnreadCount == 0 && unmutedMentionCount == 0
            && (mutedUnreadCount > 0 || mutedMentionCount > 0)
    }

    private var displayedUnreadCount: Int {
        showsOnlyMutedAttention ? mutedUnreadCount : unmutedUnreadCount
    }

    private var displayedMentionCount: Int {
        showsOnlyMutedAttention ? mutedMentionCount : unmutedMentionCount
    }
}

struct GroupSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: ConversationSummary
    var isPinned = false
    var isMuted = false

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(KordiTheme.signalBlue.opacity(0.3))
                .frame(width: 2)
                .padding(.vertical, 5)

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(sessionTitle)
                        .font(.body.weight(.semibold))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    ChatListStateIndicators(isPinned: isPinned, isMuted: isMuted)
                }

                BlobEmojiPreviewText(text: session.lastMessage.nonEmpty ?? "No messages yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 4) {
                Text(chatListTimestamp(session.lastActivityAt))
                    .font(.caption)
                    .foregroundStyle(session.hasUnreadAttention && !isMuted ? KordiTheme.signalBlue : .secondary)
                if session.hasUnreadAttention {
                    ConversationAttentionBadge(
                        unreadCount: session.unreadCount,
                        mentionCount: session.unreadMentionCount,
                        isMuted: isMuted
                    )
                }
            }
        }
        .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 28)
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 46)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            session.accessibilitySummary
                + ChatListStateIndicators.accessibilitySuffix(isPinned: isPinned, isMuted: isMuted)
        )
    }

    private var sessionTitle: String {
        let title = session.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return "# Untitled session" }
        return title.hasPrefix("#") ? title : "# \(title)"
    }
}
