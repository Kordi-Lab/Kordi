import QuickLook
import SwiftUI

private enum SessionDetailTab: String, CaseIterable, Identifiable {
    case info = "Info"
    case artifacts = "Artifacts"
    case tasks = "Tasks"

    var id: Self { self }
    var symbol: String {
        switch self {
        case .info: "info.circle"
        case .artifacts: "folder"
        case .tasks: "checkmark.circle"
        }
    }
}

struct SessionDetailSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary
    @State private var tab: SessionDetailTab = .info
    @State private var previewURL: URL?
    @State private var shareItem: SharedFileItem?
    @State private var loadingAttachmentId: String?

    private var activity: CloudSessionActivity? {
        model.sessionActivityByID[conversation.sessionId]
    }

    private var attachmentArtifacts: [SessionDetailAttachment] {
        model.messages(for: conversation)
            .flatMap { message in
                message.attachments.map { SessionDetailAttachment(message: message, attachment: $0) }
            }
            .sorted { $0.message.createdAt > $1.message.createdAt }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Session detail", selection: $tab) {
                    ForEach(SessionDetailTab.allCases) { item in
                        Label(item.rawValue, systemImage: item.symbol).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                Divider()

                switch tab {
                case .info: infoPage
                case .artifacts: artifactsPage
                case .tasks: tasksPage
                }
            }
            .navigationTitle(conversation.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .task {
            await model.loadConversation(conversation)
            await model.loadSessionActivity(conversation)
        }
        .quickLookPreview($previewURL)
        .sheet(item: $shareItem) { item in ActivityShareSheet(items: [item.url]) }
    }

    private var infoPage: some View {
        List {
            Section("Overview") {
                LabeledContent("Name", value: conversation.displayName)
                LabeledContent("Type", value: kindLabel)
                LabeledContent("Messages", value: String(model.messages(for: conversation).count))
                if conversation.kind == .group {
                    LabeledContent("Participants", value: String(conversation.groupParticipants.count))
                }
            }

            if conversation.kind == .group {
                Section("Participants") {
                    ForEach(conversation.groupParticipants) { participant in
                        HStack(spacing: 12) {
                            IdentityAvatar(
                                name: participant.displayName,
                                imageSource: participant.avatarUrl.nonEmpty,
                                kind: .person,
                                size: 36,
                                seed: participant.accountId
                            )
                            Text(participant.displayName)
                            Spacer()
                            if let role = participant.role.nonEmpty {
                                Text(role.capitalized).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var artifactsPage: some View {
        Group {
            if attachmentArtifacts.isEmpty && (activity?.artifacts.isEmpty ?? true) {
                ContentUnavailableView(
                    "No artifacts yet",
                    systemImage: "folder",
                    description: Text("Generated code, documents, and shared files from this session will appear here.")
                )
            } else {
                List {
                    if let artifacts = activity?.artifacts, !artifacts.isEmpty {
                        Section("Generated") {
                            ForEach(artifacts) { artifact in
                                CloudArtifactRow(artifact: artifact)
                            }
                        }
                    }
                    if !attachmentArtifacts.isEmpty {
                        Section("Files") {
                            ForEach(attachmentArtifacts) { item in
                                SessionDetailFileRow(
                                    item: item,
                                    isLoading: loadingAttachmentId == item.attachment.id,
                                    onReview: { prepare(item.attachment, forSharing: false) },
                                    onDownload: { prepare(item.attachment, forSharing: true) }
                                )
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
    }

    private var tasksPage: some View {
        Group {
            if activity?.tasks.isEmpty ?? true {
                ContentUnavailableView(
                    "No task activity yet",
                    systemImage: "checkmark.circle",
                    description: Text("Planning and execution tasks for this session will appear here.")
                )
            } else {
                List(activity?.tasks ?? []) { task in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: taskSymbol(task.status))
                            .foregroundStyle(taskTint(task.status))
                            .frame(width: 28, height: 28)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.title).font(.headline)
                            if let summary = task.summary.nonEmpty {
                                Text(summary).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Text(task.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(taskTint(task.status))
                        }
                    }
                    .padding(.vertical, 4)
                }
                .listStyle(.insetGrouped)
            }
        }
    }

    private var kindLabel: String {
        switch conversation.kind {
        case .person: "Contact"
        case .agent: "Agent session"
        case .group: "Group session"
        }
    }

    private func prepare(_ attachment: ChatAttachment, forSharing: Bool) {
        guard loadingAttachmentId == nil else { return }
        loadingAttachmentId = attachment.id
        Task {
            defer { loadingAttachmentId = nil }
            guard let url = await model.prepareAttachmentForPresentation(attachment) else { return }
            if forSharing { shareItem = SharedFileItem(url: url) } else { previewURL = url }
        }
    }

    private func taskSymbol(_ status: String) -> String {
        switch status.lowercased() {
        case "completed", "done": "checkmark.circle.fill"
        case "failed", "blocked": "exclamationmark.triangle.fill"
        default: "circle.dotted"
        }
    }

    private func taskTint(_ status: String) -> Color {
        switch status.lowercased() {
        case "completed", "done": .green
        case "failed", "blocked": .orange
        default: KordiTheme.signalBlue
        }
    }
}

private struct SessionDetailAttachment: Identifiable {
    let message: ChatMessage
    let attachment: ChatAttachment
    var id: String { "\(message.id):\(attachment.id)" }
}

private struct CloudArtifactRow: View {
    let artifact: CloudSessionArtifactActivity

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: artifact.kind == "document" ? "doc.text.fill" : "shippingbox.fill")
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(width: 38, height: 38)
                .background(KordiTheme.signalBlue.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(artifact.name).font(.headline)
                Text(artifact.summary.nonEmpty ?? artifact.path)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
    }
}

private struct SessionDetailFileRow: View {
    let item: SessionDetailAttachment
    let isLoading: Bool
    let onReview: () -> Void
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.attachment.kind == .image ? "photo.fill" : "doc.text.fill")
                .foregroundStyle(item.attachment.kind == .image ? KordiTheme.signalBlue : .secondary)
                .frame(width: 38, height: 38)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.attachment.name).font(.headline).lineLimit(1)
                Text([item.attachment.formatLabel, item.attachment.sizeLabel].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                Text("Shared by \(item.message.authorName)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            if isLoading {
                ProgressView().frame(width: 44, height: 44)
            } else {
                Menu {
                    Button(action: onReview) { Label("Review", systemImage: "eye") }
                    Button(action: onDownload) { Label("Download / Save to Files", systemImage: "arrow.down.circle") }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .contentShape(Rectangle())
            }
        }
        .padding(.vertical, 3)
    }
}
