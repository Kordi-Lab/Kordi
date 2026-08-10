import SwiftUI
import UIKit

struct MessageForwardRequest: Identifiable {
    let id = UUID()
    let sourceConversation: ConversationSummary
    let messages: [ChatMessage]
}

struct ForwardMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let request: MessageForwardRequest
    let onComplete: (ConversationSummary) -> Void

    @State private var selectedDestination: ConversationSummary?
    @State private var caption = ""
    @State private var isForwarding = false

    private var destinations: [ConversationSummary] {
        model.conversations
            .filter { $0.sessionId != request.sourceConversation.sessionId && !$0.representsKordiSupport }
            .sorted {
                $0.lastActivityAt > $1.lastActivityAt || (
                    $0.lastActivityAt == $1.lastActivityAt
                        && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
                )
            }
    }

    var body: some View {
        NavigationStack {
            List {
                Section(request.messages.count == 1 ? "Forwarding message" : "Forwarding \(request.messages.count) messages") {
                    ForEach(request.messages.prefix(3)) { message in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(message.authorName)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(message.text.nonEmpty ?? attachmentSummary(message.attachments.count))
                                .font(.subheadline)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                    if request.messages.count > 3 {
                        Text("+\(request.messages.count - 3) more")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if request.messages.count == 1 {
                    Section("Optional comment") {
                        TextField("Add a comment…", text: $caption, axis: .vertical)
                            .lineLimit(2...4)
                    }
                }

                Section("Choose a chat") {
                    if destinations.isEmpty {
                        ContentUnavailableView(
                            "No other chats",
                            systemImage: "arrowshape.turn.up.right",
                            description: Text("Start another chat before forwarding this message.")
                        )
                    } else {
                        ForEach(destinations) { destination in
                            Button {
                                selectedDestination = destination
                            } label: {
                                HStack(spacing: 11) {
                                    destinationAvatar(destination)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(destination.displayName)
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(.primary)
                                            .lineLimit(1)
                                        Text(destinationSubtitle(destination))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: selectedDestination?.id == destination.id ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selectedDestination?.id == destination.id ? KordiTheme.signalBlue : Color.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Forward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        forward()
                    } label: {
                        if isForwarding {
                            ProgressView()
                        } else {
                            Text("Forward")
                        }
                    }
                    .disabled(selectedDestination == nil || isForwarding)
                }
            }
        }
    }

    @ViewBuilder
    private func destinationAvatar(_ destination: ConversationSummary) -> some View {
        if destination.kind == .group {
            GroupAvatarStack(participants: destination.groupParticipants, size: 38)
        } else {
            IdentityAvatar(
                name: destination.agentDisplayName?.nonEmpty ?? destination.displayName,
                imageSource: destination.avatarSource,
                kind: destination.kind,
                size: 38,
                seed: destination.agentId?.nonEmpty ?? destination.peerAccountId.nonEmpty ?? destination.sessionId
            )
        }
    }

    private func destinationSubtitle(_ destination: ConversationSummary) -> String {
        switch destination.kind {
        case .person: "Contact"
        case .agent: destination.agentDisplayName?.nonEmpty ?? "Agent session"
        case .group: "Group · \(destination.groupParticipants.count) people"
        }
    }

    private func attachmentSummary(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }

    private func forward() {
        guard let selectedDestination else { return }
        isForwarding = true
        Task {
            let didForward = await model.forward(
                request.messages,
                caption: caption,
                from: request.sourceConversation,
                to: selectedDestination
            )
            isForwarding = false
            guard didForward else { return }
            dismiss()
            onComplete(selectedDestination)
        }
    }
}

struct MessageDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let message: ChatMessage
    let readers: [CloudGroupParticipant]

    var body: some View {
        NavigationStack {
            List {
                Section("Message") {
                    LabeledContent("From", value: message.authorName)
                    LabeledContent("Sent", value: message.createdAt.formatted(date: .abbreviated, time: .shortened))
                    LabeledContent("Status", value: message.deliveryState.label)
                    if readers.isEmpty, let count = message.readByCount, count > 0 {
                        LabeledContent("Read by", value: "\(count) people")
                    }
                    if message.messageAction?.kind == "forward" {
                        LabeledContent("Forwarded from", value: message.messageAction?.source.senderLabel ?? "Message")
                    }
                }

                if !readers.isEmpty {
                    Section("Read by") {
                        ForEach(readers) { reader in
                            HStack(spacing: 12) {
                                IdentityAvatar(
                                    name: reader.displayName,
                                    imageSource: reader.avatarUrl,
                                    kind: .person,
                                    size: 34,
                                    seed: reader.accountId
                                )
                                Text(reader.displayName)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("Read by \(reader.displayName)")
                        }
                    }
                }

                if !message.text.isEmpty {
                    Section("Content") {
                        Text(message.text)
                            .textSelection(.enabled)
                    }
                }

                if !message.attachments.isEmpty {
                    Section("Attachments") {
                        ForEach(message.attachments) { attachment in
                            Label(attachment.name, systemImage: attachment.kind == .image ? "photo" : "doc")
                        }
                    }
                }
            }
            .navigationTitle("Message details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct ConversationSelectionBar: View {
    let count: Int
    let onCancel: () -> Void
    let onCopy: () -> Void
    let onForward: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button("Cancel", action: onCancel)
                .frame(minWidth: 56, minHeight: 44)

            Text("\(count) selected")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)

            Button(action: onCopy) {
                Image(systemName: "doc.on.doc")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Copy selected messages")

            Button(action: onForward) {
                Image(systemName: "arrowshape.turn.up.right")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Forward selected messages")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

struct PinnedMessageBar: View {
    let message: ChatMessage
    let onOpen: () -> Void
    let onUnpin: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onOpen) {
                HStack(spacing: 9) {
                    Image(systemName: "pin.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(KordiTheme.signalBlue)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Pinned message")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(KordiTheme.signalBlue)
                        Text(message.text.nonEmpty ?? "Attachment")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onUnpin) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .frame(width: 44, height: 44)
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Unpin message")
        }
        .padding(.leading, 14)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}
