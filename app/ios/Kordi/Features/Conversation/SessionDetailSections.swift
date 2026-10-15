import SwiftUI
import UIKit

/// Sections and rows shown in the tabs of the conversation info page.

struct SessionDetailFact: Identifiable {
    let id: String
    let label: String
    let value: String
}

struct SessionFactsSection: View {
    let facts: [SessionDetailFact]

    var body: some View {
        SessionDetailSection {
            ForEach(Array(facts.enumerated()), id: \.element.id) { index, fact in
                LabeledContent(fact.label) {
                    Text(fact.value)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                .font(.body)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .padding(.vertical, 6)
                .frame(minHeight: SessionDetailMetrics.rowMinHeight)

                if index < facts.count - 1 {
                    SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
                }
            }
        }
    }
}

struct SessionParticipantsSection: View {
    let participants: [CloudGroupParticipant]
    let selfAccountId: String?
    let onAddMember: () -> Void
    let onOpenParticipant: (CloudGroupParticipant) -> Void
    @ScaledMetric(relativeTo: .body) private var avatarSize = 40.0

    private var textInset: CGFloat { SessionDetailMetrics.rowHorizontalInset + avatarSize + 12 }

    var body: some View {
        SessionDetailSection {
            Button(action: onAddMember) {
                HStack(spacing: 12) {
                    Image(systemName: "person.badge.plus")
                        .font(.body.weight(.medium))
                        .frame(width: avatarSize, height: avatarSize)
                        .accessibilityHidden(true)
                    Text("Add members")
                        .font(.body)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.tint)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(SessionRowButtonStyle())

            if !participants.isEmpty {
                SessionDetailSeparator(leading: textInset)
            }

            ForEach(Array(participants.enumerated()), id: \.element.id) { index, participant in
                HStack(spacing: 12) {
                    if selfAccountId == nil || participant.accountId == selfAccountId {
                        participantAvatar(participant)
                    } else {
                        Button { onOpenParticipant(participant) } label: {
                            participantAvatar(participant)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open profile for \(participant.displayName)")
                    }
                    Text(participant.displayName)
                        .font(.body)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(roleLabel(participant))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .padding(.vertical, 6)
                .frame(minHeight: 56)

                if index < participants.count - 1 { SessionDetailSeparator(leading: textInset) }
            }
        }
    }

    private func participantAvatar(_ participant: CloudGroupParticipant) -> some View {
        IdentityAvatar(
            name: participant.displayName,
            imageSource: participant.avatarUrl.nonEmpty,
            kind: .person,
            size: avatarSize,
            seed: participant.accountId
        )
        .frame(width: avatarSize, height: avatarSize)
        .frame(minWidth: 44, minHeight: 44)
    }

    private func roleLabel(_ participant: CloudGroupParticipant) -> String {
        if participant.accountId == selfAccountId { return "You" }
        if let role = participant.role?.lowercased(), ["owner", "admin"].contains(role) {
            return "Admin"
        }
        return "Member"
    }
}

struct SessionRelatedGroupsSection: View {
    let spaces: [GroupSpaceSummary]
    let onOpen: (GroupSpaceSummary) -> Void
    @ScaledMetric(relativeTo: .body) private var avatarSize = 40.0

    var body: some View {
        SessionDetailSection {
            ForEach(Array(spaces.enumerated()), id: \.element.id) { index, space in
                Button { onOpen(space) } label: {
                    HStack(spacing: 12) {
                        GroupAvatarStack(participants: space.participants, size: avatarSize, imageSource: space.avatarSource)

                        VStack(alignment: .leading, spacing: 1) {
                            Text(space.displayName)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(groupDetail(space))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }

                        Spacer(minLength: 8)

                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .padding(.vertical, 8)
                    .frame(minHeight: SessionDetailMetrics.fileRowMinHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SessionRowButtonStyle())
                .accessibilityLabel("Open \(space.displayName), \(groupDetail(space))")

                if index < spaces.count - 1 {
                    SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + avatarSize + 12)
                }
            }
        }
    }

    private func groupDetail(_ space: GroupSpaceSummary) -> String {
        let participantCount = space.participants.count
        let sessionCount = space.sessions.count
        return "\(participantCount) members · \(sessionCount) \(sessionCount == 1 ? "session" : "sessions")"
    }
}

struct SessionDetailEmptyState: View {
    let title: String
    let symbol: String

    var body: some View {
        ContentUnavailableView(title, systemImage: symbol)
            .frame(maxWidth: .infinity, minHeight: 180)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: SessionDetailMetrics.sectionCornerRadius, style: .continuous)
            )
    }
}

struct SessionAgentThreadRow: View {
    let task: CloudAgentSubsessionTask
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                IdentityAvatar(name: task.agentDisplayName, imageSource: task.agentAvatarUrl,
                    kind: .agent, size: 28, seed: task.agentId)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title).font(.body)
                    Text("\(task.agentDisplayName) · Owner · \(task.ownerDisplayName)")
                        .font(.footnote).foregroundStyle(.secondary)
                    TimelineView(.animation(minimumInterval: 1, paused: !task.live || task.status != "running")) { context in
                        Text([task.statusLabel, task.elapsedLabel(at: context.date), task.executionBackend == "desktop" ? "Mac runtime" : "Cloud runtime"].compactMap { $0 }.joined(separator: " · "))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionRowButtonStyle())
    }
}

struct SessionMediaThumbnail: View {
    @EnvironmentObject private var model: AppModel
    let item: SessionDetailAttachment
    let onOpen: () -> Void
    @State private var image: UIImage?
    @State private var hasFailed = false

    var body: some View {
        Button(action: onOpen) {
            Color(uiColor: .secondarySystemGroupedBackground)
                .overlay {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else if hasFailed {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .clipped()
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .task(id: item.attachment.id) { await loadImage() }
        .accessibilityLabel("Review \(item.attachment.name)")
    }

    private func loadImage() async {
        if let source = item.attachment.previewURL,
           let preview = await AvatarImageLoader.image(from: source) {
            guard !Task.isCancelled else { return }
            image = preview
            return
        }

        guard let url = await model.prepareAttachmentForPresentation(item.attachment) else {
            guard !Task.isCancelled else { return }
            hasFailed = true
            return
        }
        let loaded = await Task.detached(priority: .utility) {
            UIImage(contentsOfFile: url.path)
        }.value
        guard !Task.isCancelled else { return }
        image = loaded
        hasFailed = loaded == nil
    }
}

struct SessionTaskRow: View {
    let task: CloudSessionTaskActivity

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.body)
                if let summary = task.summary.nonEmpty {
                    Text(summary).font(.subheadline).foregroundStyle(.secondary)
                }
                Text(["active", "running", "processing"].contains(task.status.lowercased())
                    ? "Last reported as running · Status unverified"
                    : task.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 10)
    }

    private var symbol: String {
        switch task.status.lowercased() {
        case "completed", "done": "checkmark.circle.fill"
        case "failed", "blocked": "exclamationmark.triangle.fill"
        default: "circle.dotted"
        }
    }

    private var tint: Color {
        switch task.status.lowercased() {
        case "completed", "done": .green
        case "failed", "blocked": .orange
        default: KordiTheme.signalBlue
        }
    }
}
