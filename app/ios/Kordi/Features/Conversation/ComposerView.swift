import PhotosUI
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

enum ComposerFocusReconciliation {
    static func shouldApply(
        focused: Bool,
        textViewIsFirstResponder: Bool,
        currentFocus: Bool
    ) -> Bool {
        (focused || !textViewIsFirstResponder) && currentFocus != focused
    }
}

enum ComposerTextReconciliation {
    static func shouldApplyBindingText(
        bindingChanged: Bool,
        bindingMatchesLatestEditorText: Bool,
        hasMarkedText: Bool,
        isComposingText: Bool
    ) -> Bool {
        bindingChanged
            && !bindingMatchesLatestEditorText
            && !hasMarkedText
            && !isComposingText
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
    let editingMessage: ChatMessage?
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
    let onChooseFiles: () -> Void
    let onSendExpressiveMedia: (PendingAttachment) async -> Void
    let onSend: () -> Void
    let onSendVoice: () -> Void
    let onCancelEdit: () -> Void
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
    @State private var expressiveMediaImportRequest: ExpressiveMediaImportRequest?
    @State private var isShowingExpressiveMediaPhotoPicker = false
    @State private var selectedExpressiveMediaPhotos: [PhotosPickerItem] = []
    @ScaledMetric(relativeTo: .body) private var composerControlHeight: CGFloat = 50
    @ScaledMetric(relativeTo: .body) private var sendButtonDiameter: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var draftPaneExpansionThreshold: CGFloat = 84
    @ScaledMetric(relativeTo: .body) private var mentionPickerMaxHeight: CGFloat = 264
    @ScaledMetric(relativeTo: .body) private var mentionPickerRowHeight: CGFloat = 46
    @ScaledMetric(relativeTo: .caption) private var mentionPickerChromeHeight: CGFloat = 44

    var body: some View {
        composerContainer
            .overlay(alignment: .bottomTrailing) {
                VoiceRecordingGestureCapture(
                    isEnabled: isVoiceInputMode
                        && editingMessage == nil
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
            .animation(.snappy(duration: 0.2), value: editingMessage?.id)
            .onChange(of: editingMessage?.id) { _, messageId in
                guard messageId != nil else { return }
                isVoiceInputMode = false
                dismissExpressivePicker()
                dismissAgentModelPicker()
                isFocused = true
            }
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
            .photosPicker(
                isPresented: $isShowingExpressiveMediaPhotoPicker,
                selection: $selectedExpressiveMediaPhotos,
                maxSelectionCount: PendingAttachmentLoader.maximumAttachmentCount,
                matching: .images,
                preferredItemEncoding: .current
            )
            .onChange(of: selectedExpressiveMediaPhotos) { _, items in
                guard !items.isEmpty else { return }
                selectedExpressiveMediaPhotos = []
                finishExpressiveMediaImport(items)
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
            if let editingMessage {
                editPreview(editingMessage)
                    .padding(.horizontal, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let replySource {
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
                if editingMessage == nil {
                    attachmentMenu
                }
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
                        if editingMessage == nil {
                            expressivePickerButton
                        }
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
            mentionHighlights: mentionHighlights,
            isFocused: $isFocused,
            isExpressivePickerPresented: $isExpressivePickerPresented,
            keyboardFocusRequest: keyboardFocusRequest,
            expressivePickerHeight: expressivePickerHeight,
            isSending: isSending,
            onInsertEmoji: insertEmoji,
            onSendExpressiveMedia: onSendExpressiveMedia,
            onRequestExpressiveMediaImport: requestExpressiveMediaImport,
            measuredHeight: $messageEditorHeight,
            draftButtonThreshold: draftPaneExpansionThreshold,
            accessibilityLabel: editingMessage == nil
                ? "Message \(destinationName)"
                : "Edit message"
        )
        .frame(height: messageEditorHeight)
        .padding(.horizontal, 8)
        .accessibilityLabel(editingMessage == nil ? "Message \(destinationName)" : "Edit message")
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
        editingMessage == nil && ComposerDraftPaneLayout.showsExpandButton(
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

    private func requestExpressiveMediaImport(_ request: ExpressiveMediaImportRequest) {
        expressiveMediaImportRequest = request
        isShowingExpressiveMediaPhotoPicker = true
    }

    private func finishExpressiveMediaImport(_ items: [PhotosPickerItem]) {
        let completion = expressiveMediaImportRequest?.completion
        expressiveMediaImportRequest = nil
        completion?(items)
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
        .accessibilityLabel("Add photo, video, or file")
    }

    private var sendButton: some View {
        Button {
            dismissExpressivePicker()
            dismissAgentModelPicker()
            if editingMessage != nil {
                if canSend { onSend() }
            } else if isVoiceInputMode {
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
                    Image(systemName: editingMessage != nil
                        ? "checkmark"
                        : isVoiceInputMode ? "keyboard" : canSend ? "arrow.up" : "mic.fill")
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
        .disabled(
            isSending
                || isPreparingAttachments
                || (editingMessage != nil && !canSend)
        )
        .accessibilityLabel(
            editingMessage != nil
                ? "Save message edit"
                : isVoiceInputMode
                ? "Switch to text input"
                : canSend ? "Send message" : "Switch to voice input"
        )
        .accessibilityHint(
            editingMessage != nil
                ? "Updates this message"
                : memeValidationError
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
        ComposerMentionPicker(items: mentionMenuItems, onSelect: acceptMentionItem)
        .frame(height: mentionPickerHeight)
        .frame(maxWidth: .infinity)
        .modifier(ComposerFloatingPanelSurfaceModifier())
    }

    private var showsMentionPicker: Bool {
        editingMessage == nil
            && isFocused
            && !isExpressivePickerPresented
            && !isAgentModelPickerPresented
            && !mentionMenuItems.isEmpty
    }

    private var mentionPickerHeight: CGFloat {
        ComposerMentionPickerLayout.height(
            targetCount: mentionMenuItems.count,
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
                BlobEmojiPreviewText(
                    text: source.textPreview.nonEmpty ?? attachmentCountText(source.attachmentCount)
                )
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

    private func editPreview(_ message: ChatMessage) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "pencil")
                .font(.caption.weight(.semibold))
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Edit message")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
                BlobEmojiPreviewText(text: message.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onCancelEdit) {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Cancel message edit")
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .padding(.vertical, 2)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
    }

    private var attachmentTray: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        HStack(spacing: 8) {
                            Image(systemName: attachment.kind == .image
                                  ? "photo.fill"
                                  : attachment.isMP4Video ? "play.rectangle.fill" : "doc.fill")
                                .foregroundStyle(
                                    attachment.kind == .image || attachment.isMP4Video
                                        ? KordiTheme.signalBlue
                                        : .secondary
                                )
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
                                attachment.discardOwnedFile()
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
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let editingMessage {
            return !normalized.isEmpty
                && normalized != editingMessage.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return (!normalized.isEmpty || !attachments.isEmpty) && memeValidationError == nil
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

    private var mentionQuery: ComposerMentionQuery? {
        ComposerMentionQuery.current(in: text, selection: textSelection)
    }

    private var mentionMenuItems: [ComposerMentionMenuItem] {
        ComposerMentionMenuCatalog.items(for: mentionQuery, targets: mentionTargets)
    }

    private var mentionHighlights: [ComposerMentionText.Highlight] {
        ComposerMentionText.highlights(
            in: text,
            activeQuery: mentionQuery,
            menuIsPresented: showsMentionPicker,
            selectedTarget: selectedMention
        )
    }

    private func acceptMentionItem(_ item: ComposerMentionMenuItem) {
        guard let mentionQuery else { return }
        let replacement = ComposerMentionInsertion.replacing(
            text,
            query: mentionQuery,
            with: item
        )
        text = replacement.text
        textSelection = replacement.selection
        if case .target(let target) = item.kind {
            selectedMention = target
        } else {
            selectedMention = nil
        }
        if item.kind == .pickFile {
            isFocused = false
            onChooseFiles()
        } else {
            isFocused = true
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

final class BlobEmojiComposerUITextView: UITextView {
    override func copy(_ sender: Any?) {
        let raw = BlobEmojiComposerText.rawText(attributedText)
        let selection = BlobEmojiComposerText.rawSelection(
            forRendered: selectedRange,
            in: raw
        )
        UIPasteboard.general.string = (raw as NSString).substring(with: NSRange(
            location: selection.location,
            length: selection.length
        ))
    }

    override func cut(_ sender: Any?) {
        copy(sender)
        replaceSelectedText(textRange(from: selectedRange), with: "")
    }

    override func paste(_ sender: Any?) {
        guard let value = UIPasteboard.general.string else {
            super.paste(sender)
            return
        }
        replaceSelectedText(textRange(from: selectedRange), with: value)
    }

    private func textRange(from range: NSRange) -> UITextRange? {
        guard let start = position(from: beginningOfDocument, offset: range.location),
              let end = position(from: start, offset: range.length) else { return nil }
        return textRange(from: start, to: end)
    }

    private func replaceSelectedText(_ range: UITextRange?, with text: String) {
        guard let range else { return }
        replace(range, withText: text)
        delegate?.textViewDidChange?(self)
    }
}

struct ComposerTextView: UIViewRepresentable {
    let model: AppModel
    @Binding var text: String
    @Binding var selection: ComposerTextSelection
    var mentionHighlights: [ComposerMentionText.Highlight] = []
    @Binding var isFocused: Bool
    @Binding var isExpressivePickerPresented: Bool
    let keyboardFocusRequest: Int
    let expressivePickerHeight: CGFloat
    let isSending: Bool
    let onInsertEmoji: (String) -> Void
    let onSendExpressiveMedia: (PendingAttachment) async -> Void
    let onRequestExpressiveMediaImport: (ExpressiveMediaImportRequest) -> Void
    @Binding var measuredHeight: CGFloat
    let draftButtonThreshold: CGFloat
    let accessibilityLabel: String

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = BlobEmojiComposerUITextView()
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
        let coordinator = context.coordinator
        coordinator.parent = self
        textView.accessibilityLabel = accessibilityLabel
        textView.accessibilityValue = BlobEmojiComposerText.plainText(text)
        let font = UIFont.preferredFont(forTextStyle: .body)
        let renderedFont = textView.attributedText.length > 0
            ? textView.attributedText.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
            : font
        textView.font = font
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

        let hasMarkedText = textView.markedTextRange != nil
        let bindingChanged = coordinator.lastObservedBindingText != text
        let bindingMatchesLatestEditorText = coordinator.latestEditorText == text
        coordinator.lastObservedBindingText = text

        if !hasMarkedText, coordinator.isComposingText {
            DispatchQueue.main.async { [weak textView] in
                guard let textView,
                      textView.markedTextRange == nil,
                      coordinator.isComposingText else { return }
                coordinator.finishComposition(in: textView)
            }
        }
        let editorText = BlobEmojiComposerText.rawText(textView.attributedText)
        let needsTokenRendering = !hasMarkedText
            && !coordinator.isComposingText
            && BlobEmojiComposerText.containsUnrenderedToken(textView.attributedText)
        let shouldApplyBinding = ComposerTextReconciliation.shouldApplyBindingText(
            bindingChanged: bindingChanged,
            bindingMatchesLatestEditorText: bindingMatchesLatestEditorText,
            hasMarkedText: hasMarkedText,
            isComposingText: coordinator.isComposingText
        )
        if !hasMarkedText,
           !coordinator.isComposingText,
           (shouldApplyBinding || needsTokenRendering || renderedFont != font),
           editorText != text || needsTokenRendering || renderedFont != font {
            textView.attributedText = ComposerMentionText.attributedString(
                text,
                font: font,
                highlights: mentionHighlights
            )
            textView.invalidateIntrinsicContentSize()
            coordinator.latestEditorText = text
            BlobEmojiComposerText.resetTypingAttributes(of: textView)
        }
        if !hasMarkedText,
           !coordinator.isComposingText,
           BlobEmojiComposerText.rawText(textView.attributedText) == text {
            ComposerMentionText.applyHighlights(
                to: textView,
                rawText: text,
                highlights: mentionHighlights
            )
            let selectedRange = BlobEmojiComposerText.renderedSelection(
                forRaw: NSRange(location: selection.location, length: selection.length),
                in: text
            )
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
        var isComposingText = false
        var lastObservedBindingText: String?
        var latestEditorText: String?
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
                allowsSearch: false,
                onRequestImport: parent.onRequestExpressiveMediaImport
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
            latestEditorText = BlobEmojiComposerText.rawText(textView.attributedText)
            if textView.markedTextRange != nil {
                isComposingText = true
                return
            }
            isComposingText = false
            parent.updateHeight(of: textView)
            commitEditorState(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            if textView.markedTextRange != nil {
                isComposingText = true
                return
            }
            if isComposingText {
                finishComposition(in: textView)
                return
            }
            let updatedText = BlobEmojiComposerText.rawText(textView.attributedText)
            let rawSelection = BlobEmojiComposerText.rawSelection(
                forRendered: textView.selectedRange,
                in: updatedText
            )
            let updatedSelection = ComposerTextSelection(
                location: rawSelection.location,
                length: rawSelection.length
            )
            if parent.selection != updatedSelection {
                parent.selection = updatedSelection
            }
            BlobEmojiComposerText.resetTypingAttributes(of: textView)
        }

        func finishComposition(in textView: UITextView) {
            isComposingText = false
            parent.updateHeight(of: textView)
            commitEditorState(textView)
        }

        private func commitEditorState(_ textView: UITextView) {
            let updatedText = BlobEmojiComposerText.rawText(textView.attributedText)
            latestEditorText = updatedText
            let rawSelection = BlobEmojiComposerText.rawSelection(
                forRendered: textView.selectedRange,
                in: updatedText
            )
            let updatedSelection = ComposerTextSelection(
                location: rawSelection.location,
                length: rawSelection.length
            )
            if parent.text != updatedText {
                parent.text = updatedText
            }
            if parent.selection != updatedSelection {
                parent.selection = updatedSelection
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
