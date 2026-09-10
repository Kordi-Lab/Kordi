import SwiftUI
import UIKit

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
        coordinator.isApplyingModelUpdate = true
        defer { coordinator.isApplyingModelUpdate = false }
        textView.accessibilityLabel = accessibilityLabel
        textView.accessibilityValue = BlobEmojiComposerText.plainText(text)
        let font = UIFont.preferredFont(forTextStyle: .body)
        let fontChanged = coordinator.renderedFont != font
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
        let selectionChanged = coordinator.lastObservedBindingSelection != selection
        let shouldApplySelection = selectionChanged && coordinator.latestEditorSelection != selection
        coordinator.lastObservedBindingSelection = selection

        if !hasMarkedText, coordinator.isComposingText {
            DispatchQueue.main.async { [weak textView] in
                guard let textView,
                      textView.markedTextRange == nil,
                      coordinator.isComposingText else { return }
                coordinator.finishComposition(in: textView)
            }
        }
        let editorText = BlobEmojiComposerText.rawText(textView.attributedText)
        let editorSelection = BlobEmojiComposerText.rawSelection(forRendered: textView.selectedRange, in: editorText)
        var restoredSelection: NSRange?
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
           (shouldApplyBinding || needsTokenRendering || fontChanged),
           editorText != text || needsTokenRendering || fontChanged {
            let replacementText = shouldApplyBinding ? text : editorText
            restoredSelection = shouldApplyBinding || shouldApplySelection
                ? NSRange(location: selection.location, length: selection.length) : editorSelection
            textView.attributedText = ComposerMentionText.attributedString(
                replacementText,
                font: font,
                highlights: mentionHighlights
            )
            textView.invalidateIntrinsicContentSize()
            coordinator.latestEditorText = replacementText
            coordinator.renderedFont = font
            BlobEmojiComposerText.resetTypingAttributes(of: textView, font: font)
        }
        if !hasMarkedText,
           !coordinator.isComposingText,
           BlobEmojiComposerText.rawText(textView.attributedText) == text {
            ComposerMentionText.applyHighlights(
                to: textView,
                rawText: text,
                highlights: mentionHighlights,
                font: font
            )
            // UIKit owns selection while typing, correcting, and dragging handles.
            // Only an external selection change or a text transform can move it.
            if let rawSelection = restoredSelection ?? (shouldApplySelection
                ? NSRange(location: selection.location, length: selection.length) : nil) {
                let rendered = BlobEmojiComposerText.renderedSelection(forRaw: rawSelection, in: text)
                if textView.selectedRange != rendered { textView.selectedRange = rendered }
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
        var isApplyingModelUpdate = false
        var lastObservedBindingText: String?
        var latestEditorText: String?
        var lastObservedBindingSelection: ComposerTextSelection?
        var latestEditorSelection: ComposerTextSelection?
        var renderedFont: UIFont?
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
            guard !isApplyingModelUpdate else { return }
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
            guard !isApplyingModelUpdate else { return }
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
            latestEditorSelection = updatedSelection
            // UIKit can notify selection before it commits a replacement word.
            // Publish its range with the matching text in textViewDidChange.
            if updatedText == parent.text, parent.selection != updatedSelection {
                parent.selection = updatedSelection
            }
            BlobEmojiComposerText.resetTypingAttributes(of: textView, font: renderedFont)
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
            latestEditorSelection = updatedSelection
            if parent.text != updatedText {
                parent.text = updatedText
            }
            if parent.selection != updatedSelection {
                parent.selection = updatedSelection
            }
        }
    }
}

