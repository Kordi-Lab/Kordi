import SwiftUI

struct GroupSpaceRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let space: GroupSpaceSummary
    let isExpanded: Bool

    var body: some View {
        HStack(alignment: dynamicTypeSize.isAccessibilitySize ? .top : .center, spacing: 11) {
            GroupAvatarStack(
                participants: space.participants,
                size: dynamicTypeSize.isAccessibilitySize ? 52 : 44
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(space.displayName)
                    .font(.headline)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    .layoutPriority(1)

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
                Text(relativeTimestamp(space.lastActivityAt))
                    .font(.caption)
                    .foregroundStyle(
                        space.unreadCount > 0 || space.unreadMentionCount > 0
                            ? KordiTheme.signalBlue
                            : .secondary
                    )
                HStack(spacing: 5) {
                    if !isExpanded {
                        ConversationAttentionBadge(
                            unreadCount: space.unreadCount,
                            mentionCount: space.unreadMentionCount
                        )
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 0 : -90))
                }
            }
        }
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 64 : 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(space.accessibilitySummary)
        .accessibilityHint(isExpanded ? "Collapse sessions" : "Expand sessions")
    }

    private var detailText: String {
        let people = space.participants.count == 1 ? "1 person" : "\(space.participants.count) people"
        let sessions = space.sessions.count == 1 ? "1 session" : "\(space.sessions.count) sessions"
        return "Group · \(people) · \(sessions)"
    }
}

struct GroupSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: ConversationSummary

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(KordiTheme.signalBlue.opacity(0.3))
                .frame(width: 2)
                .padding(.vertical, 5)

            VStack(alignment: .leading, spacing: 2) {
                Text(sessionTitle)
                    .font(.body.weight(.semibold))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)

                BlobEmojiPreviewText(text: session.lastMessage.nonEmpty ?? "No messages yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 4) {
                Text(relativeTimestamp(session.lastActivityAt))
                    .font(.caption)
                    .foregroundStyle(session.hasUnreadAttention ? KordiTheme.signalBlue : .secondary)
                if session.hasUnreadAttention {
                    ConversationAttentionBadge(
                        unreadCount: session.unreadCount,
                        mentionCount: session.unreadMentionCount
                    )
                }
            }
        }
        .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 28)
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 46)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.accessibilitySummary)
    }

    private var sessionTitle: String {
        let title = session.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return "# Untitled session" }
        return title.hasPrefix("#") ? title : "# \(title)"
    }
}

private func relativeTimestamp(_ date: Date) -> String {
    let elapsed = max(0, Date().timeIntervalSince(date))
    return switch elapsed {
    case ..<60: "Now"
    case ..<3_600: "\(Int(elapsed / 60))m"
    case ..<86_400: "\(Int(elapsed / 3_600))h"
    case ..<604_800: "\(Int(elapsed / 86_400))d"
    default: date.formatted(.dateTime.month(.abbreviated).day())
    }
}
