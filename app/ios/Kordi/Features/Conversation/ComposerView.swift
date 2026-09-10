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

    static func resolvedHeight(isEmpty: Bool, measuredHeight: CGFloat, lineHeight: CGFloat, insets: CGFloat) -> CGFloat {
        isEmpty ? max(44, lineHeight + insets) : measuredHeight
    }

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
    @State private var isVoicePressing = false
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
                    onPressingChanged: updateVoicePressing,
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
                if editingMessage == nil && conversation.subsessionId == nil {
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
                            if conversation.subsessionId == nil { expressivePickerButton }
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
            HStack(spacing: 8) {
                Image(systemName: isVoicePressing ? "waveform" : "mic.fill")
                    .font(.body.weight(.semibold))
                    .frame(width: 18)
                    .symbolEffect(.variableColor, isActive: isVoicePressing && !reduceMotion)
                    .accessibilityHidden(true)
                Text(isVoicePressing ? "Keep holding…" : "Hold to Talk")
                    .font(.body.weight(.semibold))
            }
            .foregroundStyle(isVoicePressing ? KordiTheme.signalBlue : .primary)
            .frame(maxWidth: .infinity, minHeight: composerControlHeight)
            .padding(.trailing, sendButtonDiameter + 8)
            .background {
                Capsule()
                    .fill(KordiTheme.signalBlue.opacity(isVoicePressing ? 0.14 : 0))
                    .padding(.vertical, 4)
                    .padding(.trailing, sendButtonDiameter + 8)
            }
            .scaleEffect(
                reduceMotion || !isVoicePressing ? 1 : 0.985,
                anchor: .center
            )
            .animation(
                reduceMotion
                    ? nil
                    : isVoicePressing
                        ? .easeOut(duration: 0.08)
                        : .spring(response: 0.22, dampingFraction: 0.78),
                value: isVoicePressing
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(isSending || isPreparingAttachments)
        .sensoryFeedback(.impact(weight: .light), trigger: isVoicePressing) { oldValue, newValue in
            !oldValue && newValue
        }
        .accessibilityLabel("Hold to Talk")
        .accessibilityValue(isVoicePressing ? "Pressed" : "Ready")
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
        .frame(height: resolvedMessageEditorHeight)
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
        // The sent message and empty composer must share the same final layout.
        reduceMotion || text.isEmpty ? nil : .smooth(duration: 0.18)
    }

    private var resolvedMessageEditorHeight: CGFloat {
        ComposerTextViewLayout.resolvedHeight(
            isEmpty: text.isEmpty,
            measuredHeight: messageEditorHeight,
            lineHeight: UIFont.preferredFont(forTextStyle: .body).lineHeight,
            insets: 22
        )
    }

    private var messageFieldCornerRadius: CGFloat {
        composerControlHeight / 2
    }

    private var messageFieldHeight: CGFloat {
        ComposerMessageFieldLayout.surfaceHeight(
            editorHeight: resolvedMessageEditorHeight,
            controlHeight: composerControlHeight,
            verticalPadding: 3
        )
    }

    private var showsDraftPaneButton: Bool {
        editingMessage == nil && ComposerDraftPaneLayout.showsExpandButton(
            editorHeight: resolvedMessageEditorHeight,
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
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .buttonSizing(.flexible)
                .frame(width: composerControlHeight, height: composerControlHeight)
        } else {
            attachmentMenuContent
                .buttonStyle(.plain)
                .frame(width: composerControlHeight, height: composerControlHeight)
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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                        : isVoiceInputMode ? "keyboard" : canSend || conversation.subsessionId != nil ? "arrow.up" : "mic.fill")
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
                || (conversation.subsessionId != nil && !canSend)
                || (editingMessage != nil && !canSend)
        )
        .accessibilityLabel(
            editingMessage != nil
                ? "Save message edit"
                : isVoiceInputMode
                ? "Switch to text input"
                : canSend || conversation.subsessionId != nil ? "Send message" : "Switch to voice input"
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

    private func updateVoicePressing(_ isPressing: Bool) {
        guard isVoiceInputMode, !isSending, !isPreparingAttachments else {
            self.isVoicePressing = false
            return
        }
        self.isVoicePressing = isPressing
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
        ComposerMentionPicker(items: mentionMenuItems, currentAccountID: model.account?.accountId,
            onSelect: acceptMentionItem, peopleTitle: conversation.subsessionId == nil ? "Contacts" : "Members")
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
