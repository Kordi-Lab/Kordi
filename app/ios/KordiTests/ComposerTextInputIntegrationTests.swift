import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
private final class ComposerInputState: ObservableObject {
    @Published var text = "hello world"
    @Published var selection = ComposerTextSelection(location: 11, length: 0)
    @Published var focused = false
    @Published var picker = false
    @Published var height: CGFloat = 44
    @Published var revision = 0
    var holdSelection = false
    var reportedSelection: ComposerTextSelection?
    var highlights: [ComposerMentionText.Highlight] = []
}

private struct ComposerInputHost: View {
    @ObservedObject var state: ComposerInputState
    let model: AppModel
    var body: some View {
        ComposerTextView(model: model, text: $state.text,
            selection: Binding(get: { state.selection }, set: {
                state.reportedSelection = $0
                if !state.holdSelection { state.selection = $0 }
            }), mentionHighlights: state.highlights,
            isFocused: $state.focused, isExpressivePickerPresented: $state.picker,
            keyboardFocusRequest: 0, expressivePickerHeight: 300, isSending: false,
            onInsertEmoji: { _ in }, onSendExpressiveMedia: { _ in },
            onRequestExpressiveMediaImport: { _ in }, measuredHeight: $state.height,
            draftButtonThreshold: 100, accessibilityLabel: "Message revision \(state.revision)")
            .frame(width: 320, height: state.height)
    }
}

@MainActor
private final class ComposerStorageObserver: NSObject, NSTextStorageDelegate {
    var editCount = 0
    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorage.EditActions,
                     range editedRange: NSRange, changeInLength delta: Int) {
        editCount += 1
    }
}

@MainActor
final class ComposerTextInputIntegrationTests: XCTestCase {
    private func withEditor(text: String = "hello world", highlights: [ComposerMentionText.Highlight] = [],
                            perform: (ComposerInputState, UITextView) async throws -> Void) async throws {
        let state = ComposerInputState()
        state.text = text
        state.selection = ComposerTextSelection(location: (text as NSString).length, length: 0)
        state.highlights = highlights
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), previewMode: true)
        let controller = UIHostingController(rootView: ComposerInputHost(state: state, model: model))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previous?.makeKeyAndVisible()
        }
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        func editor(in view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        try await perform(state, XCTUnwrap(editor(in: controller.view)))
    }

    func testUnrelatedUpdatesDoNotRewriteNativeTextStorage() async throws {
        try await withEditor { state, editor in
            let observer = ComposerStorageObserver()
            editor.textStorage.delegate = observer
            defer { editor.textStorage.delegate = nil }
            for _ in 0..<3 {
                state.revision += 1
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertEqual(observer.editCount, 0, "An unrelated update must not invalidate native corrections or selection")
        }
    }

    func testNativeWordSelectionSurvivesAnOlderBindingSnapshot() async throws {
        try await withEditor { state, editor in
            state.holdSelection = true
            editor.selectedRange = NSRange(location: 0, length: 5)
            editor.delegate?.textViewDidChangeSelection?(editor)
            state.revision += 1
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(editor.selectedRange, NSRange(location: 0, length: 5), "UIKit owns an in-progress word selection")
            XCTAssertEqual(state.reportedSelection, ComposerTextSelection(location: 0, length: 5))
            state.holdSelection = false
            state.selection = try XCTUnwrap(state.reportedSelection)
            editor.insertText("Hi")
            editor.delegate?.textViewDidChange?(editor)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(state.text, "Hi world")
            XCTAssertEqual(editor.text, "Hi world")
        }
    }

    func testMentionAtStartDoesNotRebuildTheEditorOnSelectionUpdates() async throws {
        try await withEditor(text: "@Kordi hello", highlights: [.init(range: NSRange(location: 0, length: 6), kind: .agent)]) { state, editor in
            let nativeAttribute = NSAttributedString.Key("SyntheticNativeInputAttribute")
            editor.textStorage.addAttribute(nativeAttribute, value: true, range: NSRange(location: 7, length: 5))
            let observer = ComposerStorageObserver()
            editor.textStorage.delegate = observer
            defer { editor.textStorage.delegate = nil }
            state.revision += 1
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(editor.textStorage.attribute(nativeAttribute, at: 7, effectiveRange: nil) as? Bool, true)
            XCTAssertEqual(observer.editCount, 0, "A highlighted first word must not look like a font change")
        }
    }

    func testCorrectionReplacementAndSubsequentWordSelectionStayInSync() async throws {
        try await withEditor(text: "teh world") { state, editor in
            editor.selectedRange = NSRange(location: 0, length: 3)
            editor.insertText("the")
            editor.delegate?.textViewDidChange?(editor)
            state.revision += 1
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(editor.text, "the world")
            XCTAssertEqual(state.text, "the world")
            editor.selectedRange = NSRange(location: 4, length: 5)
            editor.delegate?.textViewDidChangeSelection?(editor)
            state.revision += 1
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(editor.selectedRange, NSRange(location: 4, length: 5))
            XCTAssertEqual(state.selection, ComposerTextSelection(location: 4, length: 5))
        }
    }

    func testExternalDraftAndSelectionChangesStillReachTheNativeEditor() async throws {
        try await withEditor { state, editor in
            state.text = "Replace this word"
            state.selection = ComposerTextSelection(location: 8, length: 4)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(editor.text, "Replace this word")
            XCTAssertEqual(editor.selectedRange, NSRange(location: 8, length: 4))
            editor.insertText("that")
            editor.delegate?.textViewDidChange?(editor)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(state.text, "Replace that word")
        }
    }

    func testEmojiInsertionPreservesRawSelectionAndFollowingTyping() async throws {
        try await withEditor { state, editor in
            let token = ":blob:blobwave:"
            state.text = "A \(token) Z"
            state.selection = ComposerTextSelection(location: 2 + token.utf16.count, length: 0)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(editor.text, "A \u{FFFC} Z")
            XCTAssertEqual(editor.selectedRange, NSRange(location: 3, length: 0))
            editor.insertText("!")
            editor.delegate?.textViewDidChange?(editor)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(state.text, "A \(token)! Z")
            XCTAssertEqual(editor.selectedRange, NSRange(location: 4, length: 0))
        }
    }

    func testMarkedTextSurvivesUnrelatedUpdatesUntilCommitted() async throws {
        try await withEditor(text: "") { state, editor in
            editor.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0))
            editor.delegate?.textViewDidChange?(editor)
            state.revision += 1
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertNotNil(editor.markedTextRange)
            XCTAssertEqual(editor.text, "ni")
            XCTAssertEqual(state.text, "")
            editor.unmarkText()
            editor.delegate?.textViewDidChange?(editor)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertNil(editor.markedTextRange)
            XCTAssertEqual(state.text, "ni")
        }
    }
}
