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
}

enum ComposerKeyboardSurfaceLayout {
    static func contentHeight(
        keyboardFrame: CGRect,
        windowBounds: CGRect,
        bottomSafeAreaInset: CGFloat
    ) -> CGFloat? {
        let visibleFrame = windowBounds.intersection(keyboardFrame)
        guard !visibleFrame.isNull,
              visibleFrame.height > bottomSafeAreaInset else { return nil }
        return visibleFrame.height - bottomSafeAreaInset
    }

    static func fallbackHeight(verticalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        verticalSizeClass == .compact ? 226 : 300
    }
}

enum ComposerDraftPaneLayout {
    static func showsExpandButton(editorHeight: CGFloat, threshold: CGFloat) -> Bool {
        editorHeight >= threshold
    }
}

enum ComposerTextViewLayout {
    static let maximumLines: CGFloat = 6

    static func height(fittingHeight: CGFloat, lineHeight: CGFloat, insets: CGFloat) -> CGFloat {
        min(
            max(fittingHeight, max(44, lineHeight + insets)),
            lineHeight * maximumLines + insets
        )
    }

    static func stableHeight(
        minimumHeight: CGFloat,
        measure: (CGFloat) -> CGFloat
    ) -> CGFloat {
        var candidate = minimumHeight
        var visited = [candidate]
        for _ in 0..<8 {
            let next = measure(candidate)
            if abs(next - candidate) <= 0.5 {
                return next
            }
            if visited.contains(where: { abs($0 - next) <= 0.5 }) {
                return max(next, visited.max() ?? next)
            }
            visited.append(next)
            candidate = next
        }
        return visited.max() ?? candidate
    }
}

enum ComposerMessageFieldLayout {
    static func surfaceHeight(
        editorHeight: CGFloat,
        controlHeight: CGFloat,
        verticalPadding: CGFloat
    ) -> CGFloat {
        max(controlHeight, editorHeight + verticalPadding * 2)
    }
}

enum ComposerTextExclusionLayout {
    static func rects(
        containerWidth: CGFloat,
        contentHeight: CGFloat,
        showsDraftButton: Bool
    ) -> [CGRect] {
        let bottomWidth = min(88, containerWidth)
        let accessoryHeight = min(44, contentHeight)
        var rects = [CGRect(
            x: max(0, containerWidth - bottomWidth),
            y: max(0, contentHeight - accessoryHeight),
            width: bottomWidth,
            height: accessoryHeight
        )]
        if showsDraftButton {
            let topWidth = min(44, containerWidth)
            rects.append(CGRect(
                x: max(0, containerWidth - topWidth),
                y: 0,
                width: topWidth,
                height: accessoryHeight
            ))
        }
        return rects
    }
}

struct ComposerView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Binding var text: String
    @Binding var attachments: [PendingAttachment]
    @Binding var photoGrouping: PhotoSendGrouping
    @Binding var replySource: MessageActionSource?
    @Binding var selectedMention: ComposerMentionTarget?
    @Binding var isFocused: Bool
    @Binding var isExpressivePickerPresented: Bool
    @Binding var isAgentModelPickerPresented: Bool
    @Binding var voiceGestureIntent: VoiceRecordingGestureIntent
    let conversation: ConversationSummary
    let mentionTargets: [ComposerMentionTarget]
    let isSending: Bool
    let isPreparingAttachments: Bool
    let voiceRecorder: VoiceMessageRecorder
    let destinationName: String
    let cameraAvailable: Bool
    let onTakePhoto: () -> Void
    let onChoosePhotos: () -> Void
    let onChooseMeme: () -> Void
    let onChooseFiles: () -> Void
    let onSendExpressiveMedia: (PendingAttachment) async -> Void
    let onSend: () -> Void
    let onSendVoice: () -> Void
    @State private var textSelection = ComposerTextSelection(location: 0, length: 0)
    @State private var keyboardSurfaceHeight: CGFloat = 0
    @State private var composerContentHeight: CGFloat = 0
    @State private var messageEditorHeight: CGFloat = 44
    @State private var isDraftPanePresented = false
    @State private var keyboardFocusRequest = 0
    @State private var isVoiceInputMode = false
    @State private var voiceGestureActive = false
    @State private var voiceGestureEnded = false
    @State private var shortVoiceFeedback = 0
    @ScaledMetric(relativeTo: .body) private var composerControlHeight: CGFloat = 50
    @ScaledMetric(relativeTo: .body) private var sendButtonDiameter: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var draftPaneExpansionThreshold: CGFloat = 84
    @ScaledMetric(relativeTo: .body) private var mentionPickerMaxHeight: CGFloat = 264
    @ScaledMetric(relativeTo: .body) private var mentionPickerRowHeight: CGFloat = 46
    @ScaledMetric(relativeTo: .caption) private var mentionPickerChromeHeight: CGFloat = 36

    var body: some View {
        composerContainer
            .overlay(alignment: .bottomTrailing) {
                VoiceRecordingGestureCapture(
                    isEnabled: isVoiceInputMode
                        && !canSend
                        && !isSending
                        && !isPreparingAttachments
                        && voiceRecorder.phase != .failed
                        && !voiceRecorder.isLocked,
                    onBegan: beginVoiceRecordingGesture,
                    onChanged: updateVoiceRecordingGesture,
                    onEnded: endVoiceRecordingGesture,
                    onCancelled: cancelVoiceRecordingGesture
                )
                .frame(maxWidth: .infinity)
                .frame(height: composerControlHeight)
                .padding(.leading, composerControlHeight + 18)
                .padding(.trailing, sendButtonDiameter + 18)
            }
            .overlay(alignment: .bottom) {
                floatingPanelLayer
            }
            .padding(.top, 9)
            .padding(.bottom, 9)
            .background {
                if #available(iOS 26.0, *) {
                    Color.clear
                } else {
                    Rectangle().fill(.bar)
                }
            }
            .animation(.snappy(duration: 0.2), value: attachments.count)
            .animation(.snappy(duration: 0.2), value: replySource?.sourceMessageId)
            .sensoryFeedback(.error, trigger: shortVoiceFeedback)
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) {
                rememberKeyboardSurfaceHeight(from: $0)
            }
            .sheet(isPresented: $isDraftPanePresented, onDismiss: { isFocused = true }) {
                ComposerDraftPane(
                    model: model,
                    text: $text,
                    destinationName: destinationName,
                    pickerHeight: expressivePickerHeight,
                    canSend: canSend,
                    isSending: isSending,
                    isPreparingAttachments: isPreparingAttachments,
                    onSendExpressiveMedia: onSendExpressiveMedia,
                    onSend: onSend
                )
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
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
    }

    private var floatingPanelLayer: some View {
        ZStack(alignment: .bottom) {
            if isAgentModelPickerPresented {
                AgentModelPicker(
                    conversation: conversation,
                    onDismiss: dismissAgentModelPicker
                )
                .padding(.horizontal, 10)
                .offset(y: -composerContentHeight - 8)
                .transition(mentionPickerTransition)
                .zIndex(10)
            } else if showsMentionPicker {
                mentionPicker
                    .padding(.horizontal, 10)
                    .offset(y: -composerContentHeight - 8)
                    .transition(mentionPickerTransition)
                    .zIndex(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .animation(inputSurfaceAnimation, value: showsMentionPicker)
        .animation(inputSurfaceAnimation, value: isAgentModelPickerPresented)
    }

    private var inputSurfaceAssembly: some View {
        inputSurface
            .padding(.horizontal, 10)
            .sensoryFeedback(.selection, trigger: voiceGestureIntent) { _, newValue in
                newValue != .hold
            }
            .animation(voiceRecordingTransitionAnimation, value: voiceRecorder.isVisible)
    }

    @ViewBuilder
    private var inputSurface: some View {
        if voiceRecorder.isVisible {
            VoiceRecordingComposer(
                recorder: voiceRecorder,
                onCancel: voiceRecorder.cancel,
                onSend: finishVoiceRecordingAndSend
            )
            .transition(voiceRecordingSurfaceTransition)
        } else {
            HStack(alignment: .bottom, spacing: 8) {
                attachmentMenu
                messageFieldSurface
                    .layoutPriority(1)
            }
            .transition(voiceRecordingSurfaceTransition)
        }
    }

    private var voiceRecordingSurfaceTransition: AnyTransition {
        reduceMotion
            ? .identity
            : .scale(scale: 0.96, anchor: .bottomTrailing)
                .combined(with: .opacity)
    }

    private var voiceRecordingTransitionAnimation: Animation? {
        guard !reduceMotion else { return nil }
        return voiceRecorder.isVisible
            ? .smooth(duration: 0.24)
            : .easeOut(duration: 0.16)
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

    @ViewBuilder
    private var messageFieldContent: some View {
        if isVoiceInputMode {
            holdToTalkButton
                .overlay(alignment: .bottomTrailing) {
                    sendButton
                        .padding(.bottom, 3)
                }
        } else {
            messageEditor
                .padding(.horizontal, 4)
                .padding(.vertical, 3)
                .animation(messageFieldAnimation) { content in
                    content.frame(height: messageFieldHeight, alignment: .bottom)
                }
                .overlay(alignment: .bottomTrailing) {
                    HStack(spacing: 0) {
                        expressivePickerButton
                        sendButton
                    }
                    .padding(.bottom, 3)
                    .transaction { $0.disablesAnimations = true }
                }
                .overlay(alignment: .topTrailing) {
                    if showsDraftPaneButton {
                        draftPaneButton
                    }
                }
        }
    }

    private var holdToTalkButton: some View {
        Button {
            guard UIAccessibility.isVoiceOverRunning else { return }
            Task { await voiceRecorder.start() }
        } label: {
            Text("Hold to Talk")
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: composerControlHeight)
                .padding(.trailing, sendButtonDiameter + 8)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(isSending || isPreparingAttachments)
        .accessibilityLabel("Hold to Talk")
        .accessibilityHint("Hold to record. Recordings shorter than one second are discarded.")
    }

    private var messageEditor: some View {
        ComposerTextView(
            model: model,
            text: $text,
            selection: $textSelection,
            isFocused: $isFocused,
            isExpressivePickerPresented: $isExpressivePickerPresented,
            keyboardFocusRequest: keyboardFocusRequest,
            expressivePickerHeight: expressivePickerHeight,
            isSending: isSending,
            onInsertEmoji: insertEmoji,
            onSendExpressiveMedia: onSendExpressiveMedia,
            measuredHeight: $messageEditorHeight,
            draftButtonThreshold: draftPaneExpansionThreshold,
            accessibilityLabel: "Message \(destinationName)"
        )
        .frame(height: messageEditorHeight)
        .padding(.horizontal, 8)
        .accessibilityLabel("Message \(destinationName)")
        .onChange(of: isFocused) { _, isFocused in
            if isFocused, !isExpressivePickerPresented {
                dismissAgentModelPicker()
            }
        }
        .onChange(of: text) { _, newValue in
            if let selectedMention,
               !newValue.localizedCaseInsensitiveContains(selectedMention.mentionText) {
                self.selectedMention = nil
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

    private var messageFieldAnimation: Animation? {
        reduceMotion ? nil : .smooth(duration: 0.18)
    }

    private var messageFieldCornerRadius: CGFloat {
        composerControlHeight / 2
    }

    private var messageFieldHeight: CGFloat {
        ComposerMessageFieldLayout.surfaceHeight(
            editorHeight: messageEditorHeight,
            controlHeight: composerControlHeight,
            verticalPadding: 3
        )
    }

    private var showsDraftPaneButton: Bool {
        ComposerDraftPaneLayout.showsExpandButton(
            editorHeight: messageEditorHeight,
            threshold: draftPaneExpansionThreshold
        )
    }

    private var draftPaneButton: some View {
        Button {
            isFocused = false
            isDraftPanePresented = true
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open message draft")
        .accessibilityHint("Opens a larger editor for this message")
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
        isExpressivePickerPresented = false
    }

    private func showExpressivePicker() {
        dismissAgentModelPicker()
        isFocused = true
        isExpressivePickerPresented = true
        keyboardFocusRequest &+= 1
    }

    private func showKeyboard() {
        dismissExpressivePicker()
        dismissAgentModelPicker()
        isFocused = true
        keyboardFocusRequest &+= 1
    }

    private var inputSurfaceAnimation: Animation? {
        reduceMotion ? nil : ComposerInputSurfaceMotion.animation
    }

    private var expressivePickerHeight: CGFloat {
        keyboardSurfaceHeight > 0
            ? keyboardSurfaceHeight
            : ComposerKeyboardSurfaceLayout.fallbackHeight(verticalSizeClass: verticalSizeClass)
    }

    private func rememberKeyboardSurfaceHeight(from notification: Notification) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap(\.windows)
                .first(where: \.isKeyWindow),
              let height = ComposerKeyboardSurfaceLayout.contentHeight(
                keyboardFrame: window.convert(frame, from: nil),
                windowBounds: window.bounds,
                bottomSafeAreaInset: window.safeAreaInsets.bottom
              ) else { return }
        keyboardSurfaceHeight = height
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
            Button(action: showAgentModelPicker) {
                Label("Model and reasoning", systemImage: "slider.horizontal.3")
            }
            Divider()
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
                dismissAgentModelPicker()
            }
        )
        .disabled(isSending || isPreparingAttachments)
        .accessibilityLabel("Add photo or file")
    }

    private var sendButton: some View {
        Button {
            dismissExpressivePicker()
            dismissAgentModelPicker()
            if isVoiceInputMode {
                isVoiceInputMode = false
                showKeyboard()
            } else if canSend {
                onSend()
            } else {
                isFocused = false
                isVoiceInputMode = true
            }
        } label: {
            ZStack {
                Circle()
                    .fill(
                        canSend && !isVoiceInputMode
                            ? KordiTheme.signalBlue
                            : Color(uiColor: .tertiarySystemFill)
                    )
                if isSending {
                    ProgressView().tint(.white).controlSize(.small)
                } else {
                    Image(systemName: isVoiceInputMode ? "keyboard" : canSend ? "arrow.up" : "mic.fill")
                        .font(.body.weight(.bold))
                        .foregroundStyle(
                            canSend && !isVoiceInputMode
                                ? .white
                                : KordiTheme.signalBlue
                        )
                }
            }
            .frame(width: sendButtonDiameter, height: sendButtonDiameter)
            .frame(width: max(44, sendButtonDiameter), height: max(44, sendButtonDiameter))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(isSending || isPreparingAttachments)
        .accessibilityLabel(
            isVoiceInputMode
                ? "Switch to text input"
                : canSend ? "Send message" : "Switch to voice input"
        )
        .accessibilityHint(
            memeValidationError
                ?? (isVoiceInputMode
                    ? "Returns to the message field and opens the keyboard"
                    : canSend
                        ? "Sends the message"
                        : "Replaces the message field with a Hold to Talk button")
        )
    }

    private func beginVoiceRecordingGesture() {
        guard !isSending, !isPreparingAttachments, !voiceGestureActive else { return }
        voiceGestureActive = true
        voiceGestureEnded = false
        isFocused = false
        dismissExpressivePicker()
        dismissAgentModelPicker()
        Task {
            let started = await voiceRecorder.start(locked: false)
            if started, voiceGestureEnded {
                completeVoiceRecordingGesture()
            }
        }
    }

    private func updateVoiceRecordingGesture(_ translation: CGSize) {
        guard voiceGestureActive else { return }
        voiceGestureIntent = VoiceHoldToTalkTargetLayout.intent(for: translation)
    }

    private func endVoiceRecordingGesture(_ translation: CGSize) {
        guard voiceGestureActive else { return }
        voiceGestureIntent = VoiceHoldToTalkTargetLayout.intent(for: translation)
        voiceGestureActive = false
        voiceGestureEnded = true
        if voiceRecorder.phase == .recording || voiceRecorder.phase == .paused {
            completeVoiceRecordingGesture()
        }
    }

    private func cancelVoiceRecordingGesture() {
        guard voiceGestureActive else { return }
        voiceGestureActive = false
        voiceGestureEnded = false
        voiceGestureIntent = .hold
        voiceRecorder.cancel()
    }

    private func completeVoiceRecordingGesture() {
        voiceGestureEnded = false
        defer {
            voiceGestureIntent = .hold
        }
        switch voiceGestureIntent {
        case .cancel:
            voiceRecorder.cancel()
        case .convertToText:
            convertVoiceRecordingToText()
        case .hold:
            finishVoiceRecordingAndSend()
        }
    }

    private func finishVoiceRecordingAndSend() {
        guard voiceRecorder.stop(autoSend: true) else {
            rejectShortVoiceRecording()
            return
        }
        Task {
            guard await voiceRecorder.prepareForSend() != nil else { return }
            onSendVoice()
        }
    }

    private func convertVoiceRecordingToText() {
        guard voiceRecorder.stop() else {
            rejectShortVoiceRecording()
            return
        }
        Task {
            guard let transcript = await voiceRecorder.prepareTranscript() else {
                voiceRecorder.cancel()
                model.errorMessage = "No recognizable speech was found. Try again."
                return
            }
            text = transcript
            voiceRecorder.cancel()
            isVoiceInputMode = false
            showKeyboard()
        }
    }

    private func rejectShortVoiceRecording() {
        shortVoiceFeedback &+= 1
        UIAccessibility.post(
            notification: .announcement,
            argument: "Recording was shorter than one second and was discarded."
        )
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
                                if target.kind == .all {
                                    Image(systemName: "person.2.fill")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(KordiTheme.signalBlue)
                                        .frame(width: 30, height: 30)
                                        .background(KordiTheme.signalBlue.opacity(0.14), in: Circle())
                                        .accessibilityHidden(true)
                                } else {
                                    IdentityAvatar(
                                        name: target.displayName,
                                        imageSource: target.avatarSource,
                                        kind: target.kind == .agent ? .agent : .person,
                                        size: 30,
                                        seed: target.agentId ?? target.accountId
                                    )
                                }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(target.displayName)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text(mentionSubtitle(target))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: mentionIconName(target))
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
        .modifier(ComposerFloatingPanelSurfaceModifier())
    }

    private var showsMentionPicker: Bool {
        isFocused
            && !isExpressivePickerPresented
            && !isAgentModelPickerPresented
            && !filteredMentionTargets.isEmpty
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

    private func dismissAgentModelPicker() {
        isAgentModelPickerPresented = false
    }

    private func showAgentModelPicker() {
        dismissExpressivePicker()
        isFocused = false
        isAgentModelPickerPresented = true
    }

    private func replyPreview(_ source: MessageActionSource) -> some View {
        HStack(spacing: 10) {
            Capsule()
                .fill(KordiTheme.signalBlue)
                .frame(width: 3, height: 32)
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
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .padding(.vertical, 2)
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

    private func mentionSubtitle(_ target: ComposerMentionTarget) -> String {
        switch target.kind {
        case .all: "All people in this group"
        case .agent: agentMentionSubtitle(target)
        case .person: "Person"
        }
    }

    private func mentionIconName(_ target: ComposerMentionTarget) -> String {
        switch target.kind {
        case .all: "person.2.fill"
        case .agent: "sparkles"
        case .person: "at"
        }
    }

    private func mentionAccessibilityLabel(_ target: ComposerMentionTarget) -> String {
        switch target.kind {
        case .all:
            return "All people in this group"
        case .agent:
            return "\(target.displayName), \(agentMentionSubtitle(target))"
        case .person:
            return "\(target.displayName), person"
        }
    }

    private func attachmentCountText(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }
}

struct ComposerFloatingPanelSurfaceModifier: ViewModifier {
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

struct ComposerTextView: UIViewRepresentable {
    let model: AppModel
    @Binding var text: String
    @Binding var selection: ComposerTextSelection
    @Binding var isFocused: Bool
    @Binding var isExpressivePickerPresented: Bool
    let keyboardFocusRequest: Int
    let expressivePickerHeight: CGFloat
    let isSending: Bool
    let onInsertEmoji: (String) -> Void
    let onSendExpressiveMedia: (PendingAttachment) async -> Void
    @Binding var measuredHeight: CGFloat
    let draftButtonThreshold: CGFloat
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
        textView.clipsToBounds = true
        textView.textContainerInset = UIEdgeInsets(top: 11, left: 5, bottom: 11, right: 5)
        textView.textContainer.lineFragmentPadding = 0
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.accessibilityLabel = accessibilityLabel
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        textView.accessibilityLabel = accessibilityLabel
        updateExclusionPaths(of: textView, height: measuredHeight)

        let inputView = isExpressivePickerPresented
            ? context.coordinator.expressiveInputView(for: self)
            : nil
        if textView.inputView !== inputView {
            textView.inputView = inputView
            if textView.isFirstResponder {
                textView.reloadInputViews()
            }
        }

        if keyboardFocusRequest > 0,
           context.coordinator.lastHandledKeyboardFocusRequest != keyboardFocusRequest {
            let coordinator = context.coordinator
            coordinator.lastHandledKeyboardFocusRequest = keyboardFocusRequest
            DispatchQueue.main.async { [weak textView] in
                guard let textView else { return }
                textView.becomeFirstResponder()
            }
        }

        if textView.markedTextRange == nil, textView.text != text {
            textView.text = text
            textView.invalidateIntrinsicContentSize()
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

        if isFocused,
           !textView.isFirstResponder,
           !context.coordinator.isEndingEditing {
            textView.becomeFirstResponder()
        } else if !isFocused, textView.isFirstResponder {
            textView.resignFirstResponder()
        }

        updateHeight(of: textView)
    }

    private func updateHeight(of textView: UITextView) {
        guard textView.bounds.width > 0 else { return }
        let lineHeight = textView.font?.lineHeight
            ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        let insets = textView.textContainerInset.top + textView.textContainerInset.bottom
        let minimumHeight = max(44, lineHeight + insets)
        var fittingHeight: CGFloat = minimumHeight
        let nextHeight = ComposerTextViewLayout.stableHeight(
            minimumHeight: minimumHeight
        ) { candidate in
            updateExclusionPaths(of: textView, height: candidate)
            fittingHeight = textView.sizeThatFits(
                CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
            ).height
            return ComposerTextViewLayout.height(
                fittingHeight: fittingHeight,
                lineHeight: lineHeight,
                insets: insets
            )
        }
        updateExclusionPaths(of: textView, height: nextHeight)
        fittingHeight = textView.sizeThatFits(
            CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
        ).height
        let maximumHeight = lineHeight * ComposerTextViewLayout.maximumLines + insets
        textView.isScrollEnabled = fittingHeight > maximumHeight
        guard abs(measuredHeight - nextHeight) > 0.5 else { return }
        DispatchQueue.main.async { measuredHeight = nextHeight }
    }

    private func updateExclusionPaths(of textView: UITextView, height: CGFloat) {
        let insets = textView.textContainerInset
        let containerWidth = max(0, textView.bounds.width - insets.left - insets.right)
        let contentHeight = max(0, height - insets.top - insets.bottom)
        textView.textContainer.exclusionPaths = ComposerTextExclusionLayout.rects(
            containerWidth: containerWidth,
            contentHeight: contentHeight,
            showsDraftButton: height >= draftButtonThreshold
        ).map(UIBezierPath.init(rect:))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        var lastHandledKeyboardFocusRequest = 0
        var isEndingEditing = false
        private var hostedExpressiveInputView: ComposerExpressiveInputView?

        init(parent: ComposerTextView) {
            self.parent = parent
        }

        func expressiveInputView(for parent: ComposerTextView) -> ComposerExpressiveInputView {
            let rootView = ExpressiveMediaPicker(
                model: parent.model,
                height: parent.expressivePickerHeight,
                isSending: parent.isSending,
                onInsertEmoji: parent.onInsertEmoji,
                onSendMedia: parent.onSendExpressiveMedia,
                allowsSearch: false
            )
            if let hostedExpressiveInputView {
                hostedExpressiveInputView.update(
                    rootView: rootView,
                    height: parent.expressivePickerHeight
                )
                return hostedExpressiveInputView
            }
            let inputView = ComposerExpressiveInputView(
                rootView: rootView,
                height: parent.expressivePickerHeight
            )
            hostedExpressiveInputView = inputView
            return inputView
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            isEndingEditing = false
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            guard ComposerFocusReconciliation.shouldApply(
                focused: false,
                textViewIsFirstResponder: textView.isFirstResponder,
                currentFocus: parent.isFocused
            ) else {
                isEndingEditing = false
                return
            }
            isEndingEditing = true
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                defer { self.isEndingEditing = false }
                guard ComposerFocusReconciliation.shouldApply(
                    focused: false,
                    textViewIsFirstResponder: textView.isFirstResponder,
                    currentFocus: self.parent.isFocused
                ) else { return }
                self.parent.isFocused = false
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            guard textView.markedTextRange == nil else { return }
            parent.updateHeight(of: textView)
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
    }
}

final class ComposerExpressiveInputView: UIInputView {
    private let hostingController: UIHostingController<ExpressiveMediaPicker>
    private var preferredHeight: CGFloat

    init(rootView: ExpressiveMediaPicker, height: CGFloat) {
        hostingController = UIHostingController(rootView: rootView)
        preferredHeight = height
        super.init(
            frame: CGRect(x: 0, y: 0, width: 0, height: height),
            inputViewStyle: .keyboard
        )
        allowsSelfSizing = true
        backgroundColor = .systemGray6
        hostingController.view.backgroundColor = .clear
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hostingController.view)
        NSLayoutConstraint.activate([
            hostingController.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            hostingController.view.topAnchor.constraint(equalTo: topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: preferredHeight)
    }

    func update(rootView: ExpressiveMediaPicker, height: CGFloat) {
        hostingController.rootView = rootView
        guard preferredHeight != height else { return }
        preferredHeight = height
        invalidateIntrinsicContentSize()
    }
}

private struct ComposerDraftPane: View {
    @Environment(\.dismiss) private var dismiss
    let model: AppModel
    @Binding var text: String
    let destinationName: String
    let pickerHeight: CGFloat
    let canSend: Bool
    let isSending: Bool
    let isPreparingAttachments: Bool
    let onSendExpressiveMedia: (PendingAttachment) async -> Void
    let onSend: () -> Void
    @FocusState private var isFocused: Bool
    @State private var isExpressivePickerPresented = false
    @ScaledMetric(relativeTo: .body) private var sendButtonDiameter: CGFloat = 38

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextEditor(text: $text)
                    .focused($isFocused)
                    .font(.body)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                    .accessibilityLabel("Message \(destinationName)")
                    .onChange(of: isFocused) { _, isFocused in
                        if isFocused {
                            isExpressivePickerPresented = false
                        }
                    }

                HStack(spacing: 4) {
                    Spacer(minLength: 0)
                    expressivePickerButton
                    sendButton
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

                if isExpressivePickerPresented {
                    ExpressiveMediaPicker(
                        model: model,
                        height: pickerHeight,
                        isSending: isSending,
                        onInsertEmoji: { text.append($0) },
                        onSendMedia: onSendExpressiveMedia,
                        allowsSearch: true
                    )
                }
            }
            .navigationTitle("Message draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { isFocused = true }
    }

    private var expressivePickerButton: some View {
        Button {
            isExpressivePickerPresented.toggle()
            isFocused = !isExpressivePickerPresented
        } label: {
            Image(systemName: isExpressivePickerPresented ? "keyboard" : "face.smiling")
                .font(.body.weight(.semibold))
                .foregroundStyle(isExpressivePickerPresented ? KordiTheme.agentViolet : .secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isPreparingAttachments)
        .accessibilityLabel(isExpressivePickerPresented ? "Show keyboard" : "Open emoji and media picker")
    }

    private var sendButton: some View {
        Button {
            onSend()
            dismiss()
        } label: {
            ZStack {
                Circle()
                    .fill(canSend ? KordiTheme.signalBlue : Color(uiColor: .tertiarySystemFill))
                if isSending {
                    ProgressView().tint(.white).controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(canSend ? .white : .secondary)
                }
            }
            .frame(width: sendButtonDiameter, height: sendButtonDiameter)
            .frame(width: max(44, sendButtonDiameter), height: max(44, sendButtonDiameter))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend || isSending || isPreparingAttachments)
        .accessibilityLabel("Send message")
    }
}
