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

enum ComposerMentionPickerLayout {
    static func height(
        targetCount: Int,
        rowHeight: CGFloat,
        chromeHeight: CGFloat,
        maximumHeight: CGFloat
    ) -> CGFloat {
        min(
            maximumHeight,
            chromeHeight + CGFloat(max(0, targetCount)) * rowHeight
        )
    }
}

enum ComposerFocusReconciliation {
    static func shouldApply(
        focused: Bool,
        textViewIsFirstResponder: Bool,
        currentFocus: Bool
    ) -> Bool {
        (focused || !textViewIsFirstResponder) && currentFocus != focused
    }
}

enum ComposerInputSurfaceMotion {
    static let duration = Duration.milliseconds(280)
    static let animation = Animation.smooth(duration: 0.28)

    static func delayBeforePresentingPicker(
        keyboardIsFocused: Bool,
        reduceMotion: Bool
    ) -> Duration {
        keyboardIsFocused && !reduceMotion ? duration : .zero
    }
}

enum ComposerTextFieldLayout {
    static func usesExpandedLayout(
        hasLineBreak: Bool,
        textWidth: CGFloat,
        compactTextWidth: CGFloat
    ) -> Bool {
        hasLineBreak || (compactTextWidth > 0 && textWidth > compactTextWidth)
    }
}

struct ComposerView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
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
    @State private var composerContentHeight: CGFloat = 0
    @State private var messageFieldWidth: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var composerControlHeight: CGFloat = 50
    @ScaledMetric(relativeTo: .body) private var mentionPickerMaxHeight: CGFloat = 264
    @ScaledMetric(relativeTo: .body) private var mentionPickerRowHeight: CGFloat = 46
    @ScaledMetric(relativeTo: .caption) private var mentionPickerChromeHeight: CGFloat = 36

    var body: some View {
        composerContainer
            .padding(.top, 9)
            .padding(.bottom, isExpressivePickerPresented ? 0 : 9)
            .background {
                if #available(iOS 26.0, *) {
                    Color.clear
                } else {
                    Rectangle().fill(.bar)
                }
            }
            .animation(inputSurfaceAnimation, value: showsMentionPicker)
            .animation(.snappy(duration: 0.2), value: attachments.count)
            .animation(.snappy(duration: 0.2), value: replySource?.sourceMessageId)
    }

    @ViewBuilder
    private var composerContainer: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) {
                composerContent
            }
        } else {
            composerContent
        }
    }

    private var composerContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let replySource {
                replyPreview(replySource)
                    .padding(.horizontal, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if !attachments.isEmpty {
                attachmentTray
                    .padding(.horizontal, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            inputSurfaceAssembly
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            composerContentHeight = height
        }
        .overlay(alignment: .bottom) {
            if showsMentionPicker {
                mentionPicker
                    .padding(.horizontal, 10)
                    .offset(y: -composerContentHeight - 8)
                    .transition(mentionPickerTransition)
                    .zIndex(10)
            }
        }
    }

    private var inputSurfaceAssembly: some View {
        VStack(alignment: .leading, spacing: 8) {
            inputSurface
                .padding(.horizontal, 10)

            if isExpressivePickerPresented {
                ExpressiveMediaPicker(
                    isSending: isSending,
                    onInsertEmoji: insertEmoji,
                    onSendMedia: onSendExpressiveMedia
                )
                .transition(expressivePickerTransition)
            }
        }
        .animation(inputSurfaceAnimation, value: isExpressivePickerPresented)
    }

    private var inputSurface: some View {
        HStack(alignment: .bottom, spacing: 8) {
            attachmentMenu
            messageFieldSurface
                .layoutPriority(1)
            sendButton
        }
    }

    @ViewBuilder
    private var messageFieldSurface: some View {
        if #available(iOS 26.0, *) {
            messageFieldContent
                .glassEffect(.regular, in: .rect(cornerRadius: messageFieldCornerRadius))
        } else {
            messageFieldContent
                .background(
                    .ultraThinMaterial,
                    in: RoundedRectangle(
                        cornerRadius: messageFieldCornerRadius,
                        style: .continuous
                    )
                )
                .overlay {
                    RoundedRectangle(
                        cornerRadius: messageFieldCornerRadius,
                        style: .continuous
                    )
                        .stroke(Color(uiColor: .separator).opacity(0.32), lineWidth: 0.5)
                }
        }
    }

    private var messageFieldContent: some View {
        messageFieldLayout
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            .frame(minHeight: composerControlHeight)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { width in
                messageFieldWidth = width
            }
            .animation(.snappy(duration: 0.2), value: usesExpandedMessageFieldLayout)
    }

    @ViewBuilder
    private var messageFieldLayout: some View {
        if usesExpandedMessageFieldLayout {
            VStack(spacing: 0) {
                messageEditor
                HStack(spacing: 0) {
                    modelMenuButton
                    Spacer(minLength: 0)
                    expressivePickerButton
                }
                .frame(height: 44)
            }
        } else {
            HStack(alignment: .bottom, spacing: 0) {
                modelMenuButton
                messageEditor
                expressivePickerButton
            }
        }
    }

    private var modelMenuButton: some View {
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
        .padding(.trailing, -8)
        .accessibilityLabel("Change session model")
        .accessibilityHint("Opens provider, model, and thinking level settings for this session")
    }

    private var messageEditor: some View {
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
            .accessibilityHidden(isExpressivePickerPresented)
            .onChange(of: isFocused) { _, isFocused in
                if isFocused { dismissExpressivePicker() }
            }
            .onChange(of: text) { _, newValue in
                if let selectedMention,
                   !newValue.localizedCaseInsensitiveContains(selectedMention.mentionText) {
                    self.selectedMention = nil
                }
            }
        }
        .overlay {
            if isExpressivePickerPresented {
                Button(action: showKeyboard) {
                    Color.clear
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show keyboard")
            }
        }
    }

    private var usesExpandedMessageFieldLayout: Bool {
        ComposerTextFieldLayout.usesExpandedLayout(
            hasLineBreak: text.contains("\n"),
            textWidth: (text as NSString).size(withAttributes: [
                .font: UIFont.preferredFont(forTextStyle: .body)
            ]).width,
            compactTextWidth: messageFieldWidth - 96
        )
    }

    private var messageFieldCornerRadius: CGFloat {
        usesExpandedMessageFieldLayout ? 28 : composerControlHeight / 2
    }

    private var expressivePickerButton: some View {
        Button {
            if isExpressivePickerPresented {
                showKeyboard()
            } else {
                showExpressivePicker()
            }
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
        withAnimation(inputSurfaceAnimation) {
            isExpressivePickerPresented = false
        }
    }

    private func showExpressivePicker() {
        let transitionDuration = ComposerInputSurfaceMotion.delayBeforePresentingPicker(
            keyboardIsFocused: isFocused,
            reduceMotion: reduceMotion
        )
        isFocused = false
        Task { @MainActor in
            try? await Task.sleep(for: transitionDuration)
            guard !isFocused, !isExpressivePickerPresented else { return }
            withAnimation(inputSurfaceAnimation) {
                isExpressivePickerPresented = true
            }
        }
    }

    private func showKeyboard() {
        dismissExpressivePicker()
        let transitionDuration = reduceMotion ? Duration.zero : ComposerInputSurfaceMotion.duration
        Task { @MainActor in
            try? await Task.sleep(for: transitionDuration)
            guard !isExpressivePickerPresented else { return }
            isFocused = true
        }
    }

    private var inputSurfaceAnimation: Animation? {
        reduceMotion ? nil : ComposerInputSurfaceMotion.animation
    }

    private var expressivePickerTransition: AnyTransition {
        reduceMotion
            ? .identity
            : .move(edge: .bottom)
    }

    private var mentionPickerTransition: AnyTransition {
        reduceMotion
            ? .identity
            : .scale(scale: 0.92, anchor: .bottom)
                .combined(with: .move(edge: .bottom))
                .combined(with: .opacity)
    }

    @ViewBuilder
    private var attachmentMenu: some View {
        if #available(iOS 26.0, *) {
            attachmentMenuContent
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
        } else {
            attachmentMenuContent
                .buttonStyle(.plain)
                .background(.ultraThinMaterial, in: Circle())
                .overlay {
                    Circle()
                        .stroke(Color(uiColor: .separator).opacity(0.25), lineWidth: 0.5)
                }
        }
    }

    private var attachmentMenuContent: some View {
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
                    Image(systemName: "paperclip")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: composerControlHeight, height: composerControlHeight)
            .contentShape(Rectangle())
        }
        .contentShape(Rectangle())
        .simultaneousGesture(
            TapGesture().onEnded {
                dismissExpressivePicker()
            }
        )
        .disabled(isSending || isPreparingAttachments)
        .accessibilityLabel("Add photo or file")
    }

    @ViewBuilder
    private var sendButton: some View {
        if #available(iOS 26.0, *) {
            sendButtonContent
                .buttonStyle(.plain)
                .glassEffect(
                    .regular
                        .tint(canSend ? KordiTheme.signalBlue : Color(uiColor: .tertiarySystemFill))
                        .interactive(),
                    in: .circle
                )
        } else {
            sendButtonContent
                .buttonStyle(.plain)
                .background(
                    canSend ? KordiTheme.signalBlue : Color(uiColor: .tertiarySystemFill),
                    in: Circle()
                )
        }
    }

    private var sendButtonContent: some View {
        Button {
            dismissExpressivePicker()
            onSend()
        } label: {
            Group {
                if isSending {
                    ProgressView().tint(.white).controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(canSend ? .white : .secondary)
                }
            }
            .frame(width: composerControlHeight, height: composerControlHeight)
            .contentShape(Circle())
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

            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(filteredMentionTargets) { target in
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
                                    .accessibilityHidden(true)
                            }
                            .frame(minHeight: 44)
                            .padding(.horizontal, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(mentionAccessibilityLabel(target))
                        .accessibilityHint("Inserts this mention")
                    }
                }
            }
            .scrollIndicators(filteredMentionTargets.count > 5 ? .visible : .hidden)
        }
        .padding(.bottom, 6)
        .frame(height: mentionPickerHeight)
        .frame(maxWidth: .infinity)
        .modifier(MentionPickerSurfaceModifier())
    }

    private var showsMentionPicker: Bool {
        isFocused && !isExpressivePickerPresented && !filteredMentionTargets.isEmpty
    }

    private var mentionPickerHeight: CGFloat {
        ComposerMentionPickerLayout.height(
            targetCount: filteredMentionTargets.count,
            rowHeight: mentionPickerRowHeight,
            chromeHeight: mentionPickerChromeHeight,
            maximumHeight: verticalSizeClass == .compact
                ? min(mentionPickerMaxHeight, 188)
                : mentionPickerMaxHeight
        )
    }

    private struct MentionPickerSurfaceModifier: ViewModifier {
        @ViewBuilder
        func body(content: Content) -> some View {
            if #available(iOS 26.0, *) {
                content
                    .glassEffect(.regular, in: .rect(cornerRadius: 22))
            } else {
                content
                    .background(
                        .regularMaterial,
                        in: RoundedRectangle(cornerRadius: 22, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(Color(uiColor: .separator).opacity(0.25), lineWidth: 0.5)
                    }
            }
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

    private func mentionAccessibilityLabel(_ target: ComposerMentionTarget) -> String {
        if target.kind == .agent {
            return "\(target.displayName), \(agentMentionSubtitle(target))"
        }
        return "\(target.displayName), person"
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
        textView.showsVerticalScrollIndicator = false
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
        let maximumHeight = lineHeight * 4 + insets
        uiView.isScrollEnabled = fittingSize.height > maximumHeight
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
            updateFocus(true, textView: textView)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            updateFocus(false, textView: textView)
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

        private func updateFocus(_ focused: Bool, textView: UITextView) {
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      ComposerFocusReconciliation.shouldApply(
                        focused: focused,
                        textViewIsFirstResponder: textView.isFirstResponder,
                        currentFocus: self.parent.isFocused
                      ) else { return }
                self.parent.isFocused = focused
            }
        }
    }
}
