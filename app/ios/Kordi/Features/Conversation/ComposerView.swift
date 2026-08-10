import SwiftUI

struct ComposerView: View {
    @Binding var text: String
    @Binding var attachments: [PendingAttachment]
    @Binding var replySource: MessageActionSource?
    @Binding var selectedMention: ComposerMentionTarget?
    let mentionTargets: [ComposerMentionTarget]
    let isSending: Bool
    let isPreparingAttachments: Bool
    let destinationName: String
    let cameraAvailable: Bool
    let onTakePhoto: () -> Void
    let onChoosePhotos: () -> Void
    let onChooseFiles: () -> Void
    let onOpenAgentModel: () -> Void
    let onSend: () -> Void
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !filteredMentionTargets.isEmpty {
                mentionPicker
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let replySource {
                replyPreview(replySource)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if !attachments.isEmpty {
                attachmentTray
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            inputSurface
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(.bar)
        .animation(.snappy(duration: 0.2), value: filteredMentionTargets.isEmpty)
        .animation(.snappy(duration: 0.2), value: attachments.count)
        .animation(.snappy(duration: 0.2), value: replySource?.sourceMessageId)
    }

    private var inputSurface: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Button(action: onOpenAgentModel) {
                Image(systemName: "line.3.horizontal")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())
            .accessibilityLabel("Change session model")
            .accessibilityHint("Opens provider, model, and thinking level settings for this session")

            attachmentMenu

            TextField("Message \(destinationName)", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .padding(.horizontal, 8)
                .padding(.vertical, 11)
                .onChange(of: text) { _, newValue in
                    if let selectedMention,
                       !newValue.localizedCaseInsensitiveContains(selectedMention.mentionText) {
                        self.selectedMention = nil
                    }
                }

            sendButton
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 3)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 17, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.32), lineWidth: 0.5)
        }
    }

    private var attachmentMenu: some View {
        Menu {
            Button(action: onTakePhoto) {
                Label("Camera", systemImage: "camera")
            }
            .disabled(!cameraAvailable)
            Button(action: onChoosePhotos) {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            Button(action: onChooseFiles) {
                Label("Files", systemImage: "doc")
            }
        } label: {
            ZStack {
                if isPreparingAttachments {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .disabled(isSending || isPreparingAttachments)
        .accessibilityLabel("Add photo or file")
    }

    private var sendButton: some View {
        Button(action: onSend) {
            ZStack {
                Circle().fill(canSend ? KordiTheme.signalBlue : Color(uiColor: .tertiarySystemFill))
                if isSending {
                    ProgressView().tint(.white).controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(canSend ? .white : .secondary)
                }
            }
            .frame(width: 44, height: 44)
        }
        .disabled(!canSend || isSending || isPreparingAttachments)
        .accessibilityLabel("Send message")
    }

    private var mentionPicker: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("MENTION")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 12)
                .padding(.top, 8)

            ForEach(filteredMentionTargets.prefix(5)) { target in
                Button {
                    insertMention(target)
                } label: {
                    HStack(spacing: 10) {
                        IdentityAvatar(
                            name: target.displayName,
                            imageSource: target.avatarSource,
                            kind: target.kind == .agent ? .agent : .person,
                            size: 30,
                            seed: target.agentId ?? target.accountId
                        )
                        VStack(alignment: .leading, spacing: 1) {
                            Text(target.displayName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(target.kind == .agent ? agentMentionSubtitle(target) : "Person")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: target.kind == .agent ? "sparkles" : "at")
                            .foregroundStyle(target.kind == .agent ? KordiTheme.agentViolet : KordiTheme.signalBlue)
                    }
                    .frame(minHeight: 44)
                    .padding(.horizontal, 12)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, 6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.25), lineWidth: 0.5)
        }
    }

    private func replyPreview(_ source: MessageActionSource) -> some View {
        HStack(spacing: 10) {
            Capsule()
                .fill(KordiTheme.signalBlue)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text("Replying to \(source.senderLabel)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
                Text(source.textPreview.nonEmpty ?? attachmentCountText(source.attachmentCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                replySource = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var attachmentTray: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 8) {
                        Image(systemName: attachment.kind == .image ? "photo.fill" : "doc.fill")
                            .foregroundStyle(attachment.kind == .image ? KordiTheme.signalBlue : .secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.name)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: attachment.sizeBytes, countStyle: .file))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Button {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.tertiary)
                                .frame(width: 28, height: 28)
                        }
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 4)
                    .padding(.vertical, 6)
                    .frame(maxWidth: 240)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
                }
            }
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private var mentionQuery: String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        let before = text[..<at]
        if let last = before.last, !last.isWhitespace { return nil }
        let query = String(text[text.index(after: at)...])
        guard !query.contains("\n"), query.count <= 80 else { return nil }
        if query.last?.isWhitespace == true,
           mentionTargets.contains(where: {
               query.trimmingCharacters(in: .whitespacesAndNewlines)
                   .localizedCaseInsensitiveCompare($0.displayName) == .orderedSame
           }) {
            return nil
        }
        return query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredMentionTargets: [ComposerMentionTarget] {
        guard let query = mentionQuery else { return [] }
        if query.isEmpty { return mentionTargets }
        return mentionTargets.filter {
            $0.displayName.localizedCaseInsensitiveContains(query)
                || $0.ownerName?.localizedCaseInsensitiveContains(query) == true
        }
    }

    private func insertMention(_ target: ComposerMentionTarget) {
        guard let at = text.lastIndex(of: "@") else { return }
        text = String(text[..<at]) + target.mentionText + " "
        selectedMention = target
        isFocused = true
    }

    private func agentMentionSubtitle(_ target: ComposerMentionTarget) -> String {
        guard let ownerName = target.ownerName?.nonEmpty else { return "Cloud agent" }
        return "\(ownerName)’s agent · Cloud or Mac"
    }

    private func attachmentCountText(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }
}
