import SwiftUI
import UIKit

struct ComposerTextSelection: Equatable {
    var location: Int
    var length: Int
}

struct ComposerTextReplacement: Equatable {
    var text: String
    var selection: ComposerTextSelection
}

func replacingComposerText(
    _ text: String,
    selection: ComposerTextSelection,
    with replacement: String
) -> ComposerTextReplacement {
    let source = text as NSString
    let safeLocation = min(max(selection.location, 0), source.length)
    let safeLength = min(max(selection.length, 0), source.length - safeLocation)
    let updatedText = source.replacingCharacters(
        in: NSRange(location: safeLocation, length: safeLength),
        with: replacement
    )
    return ComposerTextReplacement(
        text: updatedText,
        selection: ComposerTextSelection(
            location: safeLocation + (replacement as NSString).length,
            length: 0
        )
    )
}

struct ComposerView: View {
    @Binding var text: String
    @Binding var attachments: [PendingAttachment]
    @Binding var photoGrouping: PhotoSendGrouping
    @Binding var replySource: MessageActionSource?
    @Binding var selectedMention: ComposerMentionTarget?
    @Binding var isExpressivePickerPresented: Bool
    let mentionTargets: [ComposerMentionTarget]
    let isSending: Bool
    let isPreparingAttachments: Bool
    let destinationName: String
    let cameraAvailable: Bool
    let onTakePhoto: () -> Void
    let onChoosePhotos: () -> Void
    let onChooseMeme: () -> Void
    let onChooseFiles: () -> Void
    let onOpenAgentModel: () -> Void
    let onSendExpressiveMedia: (PendingAttachment) async -> Void
    let onSend: () -> Void
    @State private var isFocused = false
    @State private var textSelection = ComposerTextSelection(location: 0, length: 0)

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

            if isExpressivePickerPresented {
                ExpressiveMediaPicker(
                    isSending: isSending,
                    onInsertEmoji: insertEmoji,
                    onSendMedia: onSendExpressiveMedia
                )
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
        .animation(.snappy(duration: 0.22), value: isExpressivePickerPresented)
    }

    private var inputSurface: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Button {
                dismissExpressivePicker()
                onOpenAgentModel()
            } label: {
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

            expressivePickerButton

            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text("Message \(destinationName)")
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 13)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }

                ComposerTextView(
                    text: $text,
                    selection: $textSelection,
                    isFocused: $isFocused,
                    accessibilityLabel: "Message \(destinationName)"
                )
                .frame(minHeight: 44)
                .padding(.horizontal, 8)
                .onChange(of: isFocused) { _, isFocused in
                    if isFocused { isExpressivePickerPresented = false }
                }
                .onChange(of: text) { _, newValue in
                    if let selectedMention,
                       !newValue.localizedCaseInsensitiveContains(selectedMention.mentionText) {
                        self.selectedMention = nil
                    }
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

    private var expressivePickerButton: some View {
        Button {
            isFocused = false
            isExpressivePickerPresented.toggle()
        } label: {
            Image(systemName: isExpressivePickerPresented ? "keyboard" : "face.smiling")
                .font(.body.weight(.semibold))
                .foregroundStyle(isExpressivePickerPresented ? KordiTheme.agentViolet : .secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isPreparingAttachments)
        .accessibilityLabel(isExpressivePickerPresented ? "Hide emoji and media picker" : "Open emoji and media picker")
        .accessibilityHint("Shows emoji, stickers, and GIFs")
    }

    private func insertEmoji(_ emoji: String) {
        let replacement = replacingComposerText(
            text,
            selection: textSelection,
            with: emoji
        )
        text = replacement.text
        textSelection = replacement.selection
    }

    private func dismissExpressivePicker() {
        isExpressivePickerPresented = false
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
            Button(action: onChooseMeme) {
                Label("Meme from Photos", systemImage: "text.bubble")
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
        .simultaneousGesture(
            TapGesture().onEnded {
                dismissExpressivePicker()
            }
        )
        .disabled(isSending || isPreparingAttachments)
        .accessibilityLabel("Add photo or file")
    }

    private var sendButton: some View {
        Button {
            dismissExpressivePicker()
            onSend()
        } label: {
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
        .accessibilityHint(memeValidationError ?? "Sends the message")
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
        VStack(alignment: .leading, spacing: 8) {
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
                            if attachment.kind == .image {
                                Button {
                                    toggleMeme(attachment.id)
                                } label: {
                                    Text(attachment.subtype == .meme ? "Meme" : "Mark meme")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(attachment.subtype == .meme ? KordiTheme.signalBlue : .secondary)
                                        .padding(.horizontal, 7)
                                        .frame(minHeight: 28)
                                        .background(
                                            attachment.subtype == .meme
                                                ? KordiTheme.signalBlue.opacity(0.12)
                                                : Color(uiColor: .tertiarySystemFill),
                                            in: Capsule()
                                        )
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(
                                    attachment.subtype == .meme
                                        ? "Remove meme details from \(attachment.name)"
                                        : "Mark \(attachment.name) as a meme"
                                )
                            }
                            Button {
                                attachments.removeAll { $0.id == attachment.id }
                                if photoAttachmentCount < 2 {
                                    photoGrouping = .combined
                                }
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

            ForEach($attachments) { $attachment in
                if attachment.subtype == .meme {
                    memeEditor(attachment: $attachment)
                }
            }

            if let memeValidationError {
                Text(memeValidationError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityLabel("Meme attachment error: \(memeValidationError)")
            }

            if photoAttachmentCount > 1 {
                Button {
                    photoGrouping = photoGrouping == .combined ? .separate : .combined
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: photoGrouping == .combined ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(photoGrouping == .combined ? KordiTheme.signalBlue : .secondary)
                        Text("Send photos as one grouped message")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(photoGrouping == .combined ? "On" : "Off")
                .accessibilityAddTraits(photoGrouping == .combined ? .isSelected : [])
            }
        }
    }

    private var photoAttachmentCount: Int {
        attachments.lazy.filter { $0.kind == .image }.count
    }

    private var canSend: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && memeValidationError == nil
    }

    private var memeValidationError: String? {
        MemeAttachmentPolicy.draftError(for: attachments)
    }

    private func toggleMeme(_ id: String) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        if attachments[index].subtype == .meme {
            attachments[index].subtype = nil
            attachments[index].altText = nil
            attachments[index].memeRightsConfirmed = false
        } else {
            attachments[index].subtype = .meme
            attachments[index].altText = ""
            attachments[index].memeRightsConfirmed = false
        }
    }

    private func memeEditor(attachment: Binding<PendingAttachment>) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Meme details")
                .font(.caption.weight(.semibold))
            TextField(
                "Describe visible text and the joke",
                text: Binding(
                    get: { attachment.wrappedValue.altText ?? "" },
                    set: { value in
                        attachment.wrappedValue.altText = String(
                            value.prefix(MemeAttachmentPolicy.maximumAltTextCharacters)
                        )
                    }
                ),
                axis: .vertical
            )
            .lineLimit(2...4)
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel("Alt text for \(attachment.wrappedValue.name)")

            Toggle(
                "I confirm I have permission or another legal right to share this meme.",
                isOn: Binding(
                    get: { attachment.wrappedValue.memeRightsConfirmed },
                    set: { attachment.wrappedValue.memeRightsConfirmed = $0 }
                )
            )
            .font(.caption)
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.25), lineWidth: 0.5)
        }
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
        textSelection = ComposerTextSelection(
            location: (text as NSString).length,
            length: 0
        )
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

private struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: ComposerTextSelection
    @Binding var isFocused: Bool
    let accessibilityLabel: String

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.isScrollEnabled = false
        textView.textContainerInset = UIEdgeInsets(top: 11, left: 5, bottom: 11, right: 5)
        textView.textContainer.lineFragmentPadding = 0
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.accessibilityLabel = accessibilityLabel
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        textView.accessibilityLabel = accessibilityLabel

        if textView.markedTextRange == nil, textView.text != text {
            textView.text = text
        }
        if textView.markedTextRange == nil {
            let utf16Count = (textView.text as NSString).length
            let location = min(max(selection.location, 0), utf16Count)
            let length = min(max(selection.length, 0), utf16Count - location)
            let selectedRange = NSRange(location: location, length: length)
            if textView.selectedRange != selectedRange {
                textView.selectedRange = selectedRange
            }
        }

        if isFocused, !textView.isFirstResponder {
            textView.becomeFirstResponder()
        } else if !isFocused, textView.isFirstResponder {
            textView.resignFirstResponder()
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let fittingSize = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        let lineHeight = uiView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        let insets = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let minimumHeight = lineHeight + insets
        let maximumHeight = lineHeight * 6 + insets
        return CGSize(
            width: width,
            height: min(max(fittingSize.height, minimumHeight), maximumHeight)
        )
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView

        init(parent: ComposerTextView) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            updateFocus(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            updateFocus(false)
        }

        func textViewDidChange(_ textView: UITextView) {
            guard textView.markedTextRange == nil else { return }
            let updatedText = textView.text ?? ""
            let updatedSelection = ComposerTextSelection(
                location: textView.selectedRange.location,
                length: textView.selectedRange.length
            )
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.parent.text != updatedText {
                    self.parent.text = updatedText
                }
                if self.parent.selection != updatedSelection {
                    self.parent.selection = updatedSelection
                }
            }
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard textView.markedTextRange == nil else { return }
            let updatedSelection = ComposerTextSelection(
                location: textView.selectedRange.location,
                length: textView.selectedRange.length
            )
            DispatchQueue.main.async { [weak self] in
                guard let self, self.parent.selection != updatedSelection else { return }
                self.parent.selection = updatedSelection
            }
        }

        private func updateFocus(_ focused: Bool) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.parent.isFocused != focused else { return }
                self.parent.isFocused = focused
            }
        }
    }
}
