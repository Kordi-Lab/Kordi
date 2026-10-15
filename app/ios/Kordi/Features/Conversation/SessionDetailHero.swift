import SwiftUI

/// Avatar, name and status at the top of the conversation info page, followed
/// by the action buttons.
struct SessionProfileHero<Actions: View>: View {
    let conversation: ConversationSummary
    let displayName: String
    let participants: [CloudGroupParticipant]
    let statusText: String
    let tint: Color
    private let actions: Actions
    @ScaledMetric(relativeTo: .largeTitle) private var avatarSize = 92.0
    @ScaledMetric(relativeTo: .title2) private var nameSize = 24.0

    init(
        conversation: ConversationSummary,
        displayName: String,
        participants: [CloudGroupParticipant],
        statusText: String,
        tint: Color,
        @ViewBuilder actions: () -> Actions
    ) {
        self.conversation = conversation
        self.displayName = displayName
        self.participants = participants
        self.statusText = statusText
        self.tint = tint
        self.actions = actions()
    }

    var body: some View {
        VStack(spacing: 0) {
            avatar
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4)

            VStack(spacing: 2) {
                Text(displayName)
                    .font(.system(size: nameSize, weight: .bold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)

                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 10)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(displayName), \(statusText)")

            actions
                .padding(.top, 16)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private var avatar: some View {
        if conversation.kind == .group {
            GroupAvatarStack(participants: participants, size: avatarSize, imageSource: conversation.avatarSource)
        } else {
            IdentityAvatar(
                name: conversation.displayName,
                imageSource: conversation.avatarSource,
                kind: conversation.kind,
                size: avatarSize,
                seed: conversation.agentId ?? conversation.peerAccountId
            )
        }
    }
}

/// Round Liquid Glass back button over the top-leading corner.
struct SessionDetailBackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .sessionGlass(in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 16)
        .safeAreaPadding(.top, 8)
        .accessibilityLabel("Back")
    }
}

struct SessionDetailBackground: View {
    let tint: Color

    var body: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)

            LinearGradient(
                stops: [
                    .init(color: tint.opacity(0.25), location: 0),
                    .init(color: tint.opacity(0.18), location: 0.28),
                    .init(color: tint.opacity(0.07), location: 0.52),
                    .init(color: .clear, location: 0.70)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }
}

enum SessionHeroAction: String, Identifiable {
    case chat
    case call
    case video
    case mute
    case search
    case more

    var id: Self { self }
}

enum SessionMoreAction: String, Identifiable {
    case addMembers
    case groupSettings
    case copyGroupName
    case copyKordiID
    case backToChat

    var id: Self { self }

    var title: String {
        switch self {
        case .addMembers: "Add members"
        case .groupSettings: "Group settings"
        case .copyGroupName: "Copy group name"
        case .copyKordiID: "Copy Kordi ID"
        case .backToChat: "Back to chat"
        }
    }

    var symbol: String {
        switch self {
        case .addMembers: "person.badge.plus"
        case .groupSettings: "slider.horizontal.3"
        case .copyGroupName, .copyKordiID: "doc.on.doc"
        case .backToChat: "bubble.left"
        }
    }
}

/// Icon above a short label on a Liquid Glass tile. Every symbol sits in the
/// same fixed box so icons and labels line up across the row.
struct SessionProfileActionLabel: View {
    let title: String
    let symbol: String
    let tint: Color
    let isSelected: Bool
    @ScaledMetric(relativeTo: .caption) private var iconBox = 24.0
    @ScaledMetric(relativeTo: .caption) private var iconSize = 19.0

    var body: some View {
        VStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: iconSize, weight: .medium))
                .symbolRenderingMode(.monochrome)
                .frame(width: iconBox + 6, height: iconBox)
            Text(title)
                .font(.caption.weight(.medium))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.82)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.actionMinHeight)
        .sessionGlass(
            in: RoundedRectangle(cornerRadius: SessionDetailMetrics.actionCornerRadius, style: .continuous),
            selectionTint: isSelected ? tint : nil
        )
        .contentShape(RoundedRectangle(cornerRadius: SessionDetailMetrics.actionCornerRadius, style: .continuous))
    }
}

struct SessionProfileActionButton: View {
    let title: String
    let symbol: String
    let tint: Color
    var isSelected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SessionProfileActionLabel(
                title: title,
                symbol: symbol,
                tint: tint,
                isSelected: isSelected
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
