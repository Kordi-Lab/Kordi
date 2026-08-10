import QuickLook
import SwiftUI
import UIKit

struct SharedFileItem: Identifiable {
    let id = UUID()
    let url: URL
}

struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct SessionFilesSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary
    @State private var previewURL: URL?
    @State private var shareItem: SharedFileItem?
    @State private var loadingAttachmentId: String?

    private var files: [SessionFileItem] {
        model.messages(for: conversation)
            .flatMap { message in
                message.attachments.map {
                    SessionFileItem(message: message, attachment: $0)
                }
            }
            .sorted { $0.message.createdAt > $1.message.createdAt }
    }

    var body: some View {
        NavigationStack {
            Group {
                if files.isEmpty {
                    ContentUnavailableView(
                        "No files yet",
                        systemImage: "folder",
                        description: Text("Attachments shared in this session will appear here.")
                    )
                } else {
                    List(files) { item in
                        SessionFileRow(
                            item: item,
                            isLoading: loadingAttachmentId == item.attachment.id,
                            onReview: { prepare(item.attachment, forSharing: false) },
                            onDownload: { prepare(item.attachment, forSharing: true) }
                        )
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Files")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(conversation.displayName)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        Text(fileCountText)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await model.loadConversation(conversation) }
        .quickLookPreview($previewURL)
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: [item.url])
        }
    }

    private var fileCountText: String {
        files.count == 1 ? "1 file" : "\(files.count) files"
    }

    private func prepare(_ attachment: ChatAttachment, forSharing: Bool) {
        guard loadingAttachmentId == nil else { return }
        loadingAttachmentId = attachment.id
        Task {
            defer { loadingAttachmentId = nil }
            guard let url = await model.prepareAttachmentForPresentation(attachment) else { return }
            if forSharing {
                shareItem = SharedFileItem(url: url)
            } else {
                previewURL = url
            }
        }
    }
}

struct ConversationInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Session", value: conversation.displayName)
                    LabeledContent("Type", value: kindLabel)
                    if conversation.kind == .group {
                        LabeledContent("Participants", value: String(conversation.groupParticipants.count))
                    }
                }
            }
            .navigationTitle("Conversation info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
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
}

private struct SessionFileItem: Identifiable {
    let message: ChatMessage
    let attachment: ChatAttachment

    var id: String { "\(message.id):\(attachment.id)" }
}

private struct SessionFileRow: View {
    let item: SessionFileItem
    let isLoading: Bool
    let onReview: () -> Void
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onReview) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(item.attachment.kind == .image
                              ? KordiTheme.signalBlue.opacity(0.12)
                              : Color(uiColor: .secondarySystemGroupedBackground))
                    if isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: item.attachment.kind == .image ? "photo.fill" : "doc.text.fill")
                            .foregroundStyle(item.attachment.kind == .image ? KordiTheme.signalBlue : .secondary)
                    }
                }
                .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Review \(item.attachment.name)")

            Button(action: onReview) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.attachment.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(fileSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("Shared by \(item.message.authorName) · \(item.message.createdAt.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Menu {
                Button(action: onReview) {
                    Label("Review", systemImage: "eye")
                }
                Button(action: onDownload) {
                    Label("Download / Save to Files", systemImage: "arrow.down.circle")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .contentShape(Rectangle())
            .disabled(isLoading)
            .accessibilityLabel("More actions for \(item.attachment.name)")
        }
        .padding(.vertical, 4)
    }

    private var fileSubtitle: String {
        [item.attachment.formatLabel, item.attachment.sizeLabel]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}
