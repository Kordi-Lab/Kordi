import SwiftUI

struct AgentSessionSectionHeader: View {
    let section: AgentSessionSection

    var body: some View {
        HStack(spacing: 10) {
            IdentityAvatar(
                name: section.displayName,
                imageSource: section.avatarSource,
                kind: .agent,
                size: 30,
                seed: section.agentId ?? section.id
            )

            VStack(alignment: .leading, spacing: 1) {
                Text(section.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(section.sessions.count == 1 ? "1 session" : "\(section.sessions.count) sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct AgentSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let conversation: ConversationSummary
    var isFork = false
    var isPinned = false
    var isMuted = false

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibilityLayout
            } else {
                regularLayout
            }
        }
        .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 46, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            conversation.accessibilitySummary
                + ChatListStateIndicators.accessibilitySuffix(isPinned: isPinned, isMuted: isMuted)
        )
    }

    private var accessibilityLayout: some View {
        VStack(alignment: .leading, spacing: 8) {
            title
            preview

            if let activity = conversation.agentActivity, activity != .ready {
                AgentSessionActivityLabel(activity: activity)
            }

            HStack(spacing: 10) {
                timestamp
                if conversation.hasUnreadAttention {
                    attentionBadge
                }
            }
        }
        .padding(.vertical, 8)
    }

    private var regularLayout: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                title
                preview
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 4) {
                timestamp

                if conversation.hasUnreadAttention {
                    attentionBadge
                } else if let activity = conversation.agentActivity,
                          activity != .ready {
                    AgentSessionActivityLabel(activity: activity, compact: true)
                }
            }
        }
    }

    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if isFork {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            Text(sessionTitle)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                .layoutPriority(1)
            ChatListStateIndicators(isPinned: isPinned, isMuted: isMuted)
        }
    }

    private var preview: some View {
        HStack(spacing: 0) {
            Text(conversation.agentDisplayName?.nonEmpty ?? "Kordi")
                .foregroundStyle(KordiTheme.agentViolet)
            Text(" · ")
                .foregroundStyle(.secondary)
            BlobEmojiPreviewText(text: conversation.lastMessage.nonEmpty ?? "No messages yet")
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 1)
    }

    private var timestamp: some View {
        Text(relativeTimestamp)
            .font(.caption)
            .foregroundStyle(conversation.hasUnreadAttention && !isMuted ? KordiTheme.signalBlue : .secondary)
            .lineLimit(1)
    }

    private var attentionBadge: some View {
        ConversationAttentionBadge(
            unreadCount: conversation.unreadCount,
            mentionCount: conversation.unreadMentionCount,
            isMuted: isMuted
        )
    }

    private var sessionTitle: String {
        guard conversation.displayName == conversation.agentDisplayName,
              conversation.lastMessage == "New session" else {
            return conversation.displayName
        }
        return "New session"
    }

    private var relativeTimestamp: String {
        chatListTimestamp(conversation.lastActivityAt)
    }
}

private struct AgentSessionActivityLabel: View {
    let activity: AgentActivity
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            if activity == .replying {
                Circle()
                    .fill(KordiTheme.agentViolet)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: "exclamationmark.circle.fill")
                    .accessibilityHidden(true)
            }
            if !compact || activity != .replying {
                Text(activity.label)
                    .font(compact ? .caption2.weight(.semibold) : .caption.weight(.medium))
            }
        }
        .foregroundStyle(activity == .failed ? Color.red : KordiTheme.agentViolet)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(activity.label)
    }
}
