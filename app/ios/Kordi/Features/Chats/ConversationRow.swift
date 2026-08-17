import SwiftUI

enum ConversationRowPresentation: Equatable {
    case standard
    case contactAgent(ownerName: String)
}

struct ConversationRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let conversation: ConversationSummary
    var presentation: ConversationRowPresentation = .standard

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibilityLayout
            } else {
                compactLayout
            }
        }
        .contentShape(Rectangle())
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 64 : 48)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(conversation.accessibilitySummary)
    }

    private var compactLayout: some View {
        HStack(spacing: 11) {
            avatar
            identityDetails
            Spacer(minLength: 8)
            trailingStatus
        }
    }

    private var accessibilityLayout: some View {
        HStack(alignment: .top, spacing: 11) {
            avatar

            VStack(alignment: .leading, spacing: 10) {
                identityDetails

                HStack(spacing: 10) {
                    Text(relativeTimestamp)
                        .font(.caption)
                        .foregroundStyle(conversation.unreadCount > 0 ? KordiTheme.signalBlue : .secondary)
                    unreadBadge
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var avatar: some View {
        Group {
            if conversation.kind == .group {
                GroupAvatarStack(
                    participants: conversation.groupParticipants,
                    size: avatarSize
                )
            } else {
                IdentityAvatar(
                    name: conversation.agentDisplayName?.nonEmpty ?? conversation.displayName,
                    imageSource: conversation.avatarSource,
                    kind: conversation.kind,
                    size: avatarSize,
                    seed: conversation.agentId?.nonEmpty ?? conversation.peerAccountId.nonEmpty ?? conversation.sessionId
                )
            }
        }
    }

    private var avatarSize: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 52 : 44
    }

    private var identityDetails: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(conversation.displayName)
                    .font(.headline)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
                    .layoutPriority(1)
                if conversation.kind == .agent {
                    Image(systemName: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(KordiTheme.agentViolet)
                        .accessibilityHidden(true)
                }
            }

            if let activity = conversation.agentActivity {
                if case let .contactAgent(ownerName) = presentation {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(shortOwnerName(ownerName))’s agent")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            AgentActivityLabel(activity: activity)
                        }
                    } else {
                        contactAgentStatus(ownerName: ownerName, activity: activity)
                            .font(.subheadline)
                            .lineLimit(1)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Text(conversation.agentDisplayName?.nonEmpty ?? "My Kordi")
                                .foregroundStyle(KordiTheme.agentViolet)
                                .lineLimit(1)
                            Text("·")
                                .foregroundStyle(.tertiary)
                            Text(conversation.lastMessage)
                                .foregroundStyle(.secondary)
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                        }
                        .font(.subheadline)

                        if activity != .ready {
                            AgentActivityLabel(activity: activity)
                        }
                    }
                }
            } else {
                Text(conversation.lastMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
            }
        }
    }

    private var trailingStatus: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(relativeTimestamp)
                .font(.caption)
                .foregroundStyle(conversation.unreadCount > 0 ? KordiTheme.signalBlue : .secondary)
                .lineLimit(1)
            unreadBadge
        }
    }

    @ViewBuilder
    private var unreadBadge: some View {
        if conversation.unreadCount > 0 {
            Text(String(conversation.unreadCount))
                .font(.caption2.bold())
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(KordiTheme.signalBlue, in: Capsule())
                .accessibilityLabel("\(conversation.unreadCount) unread messages")
        }
    }

    private func contactAgentStatus(ownerName: String, activity: AgentActivity) -> Text {
        Text("\(shortOwnerName(ownerName))’s agent")
            .foregroundStyle(.secondary)
        + Text(" · ")
            .foregroundStyle(.secondary)
        + Text(activity.label)
            .foregroundStyle(activity == .failed ? Color.red : KordiTheme.agentViolet)
    }

    private var relativeTimestamp: String {
        let elapsed = max(0, Date().timeIntervalSince(conversation.lastActivityAt))
        switch elapsed {
        case ..<60:
            return "Now"
        case ..<3_600:
            return "\(Int(elapsed / 60))m"
        case ..<86_400:
            return "\(Int(elapsed / 3_600))h"
        case ..<604_800:
            return "\(Int(elapsed / 86_400))d"
        default:
            return conversation.lastActivityAt.formatted(.dateTime.month(.abbreviated).day())
        }
    }

    private func shortOwnerName(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
    }
}

private struct AgentActivityLabel: View {
    let activity: AgentActivity

    var body: some View {
        HStack(spacing: 6) {
            if activity == .replying {
                Circle()
                    .fill(KordiTheme.agentViolet)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
            } else {
                Circle()
                    .fill(activity == .failed ? Color.red : Color.green)
                    .frame(width: 7, height: 7)
                Text(activity.label)
                    .font(.subheadline)
                    .foregroundStyle(activity == .failed ? Color.red : KordiTheme.agentViolet)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(activity.label)
    }
}
