import ObjectiveC
import SwiftUI
import WebKit

/// The document editor page (the Mac's Tiptap editor, bundled in
/// `DocumentEditor/`) in a web view that only talks to `session`.
struct DocumentEditorWebView: UIViewRepresentable {
    let session: DocumentEditorSession

    static var pageURL: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "DocumentEditor")
    }

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: documentEditorMessageHandler)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.keyboardDismissMode = .interactive
        webView.allowsLinkPreview = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        Self.hideFormAccessory(in: webView)
        context.coordinator.attach(webView)
        if let page = Self.pageURL {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else {
            session.handle(.error("Could not open the editor."))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    /// The editor's toolbar replaces WebKit's previous, next and done bar
    /// above the keyboard: the web content view gets a subclass whose
    /// accessory view is empty.
    private static func hideFormAccessory(in webView: WKWebView) {
        guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }) else { return }
        let name = "KordiDocumentEditorContentView"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let created = objc_allocateClassPair(type(of: content), name, 0) {
            let selector = #selector(getter: UIResponder.inputAccessoryView)
            let empty: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            if let method = class_getInstanceMethod(UIResponder.self, selector) {
                class_addMethod(created, selector, imp_implementationWithBlock(empty), method_getTypeEncoding(method))
            }
            objc_registerClassPair(created)
            subclass = created
        }
        if let subclass { object_setClass(content, subclass) }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: documentEditorMessageHandler)
        webView.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private let session: DocumentEditorSession
        private weak var webView: WKWebView?

        init(session: DocumentEditorSession) {
            self.session = session
        }

        func attach(_ webView: WKWebView) {
            self.webView = webView
            session.evaluate = { [weak webView] script in
                webView?.evaluateJavaScript(script, completionHandler: nil)
            }
            session.closePage = { [weak webView] in
                guard let webView else { return }
                _ = try? await webView.callAsyncJavaScript(
                    "await window.kordiEditor?.close();", arguments: [:], in: nil, contentWorld: .page
                )
            }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the bundled page, in the main frame, speaks for the editor.
            guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
                  let parsed = DocumentEditorMessage(body: message.body) else { return }
            session.handle(parsed)
        }

        /// The page stays on its bundled file; links open nowhere from here.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.isFileURL == true && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            session.handle(.error("The editor stopped. Close it and open it again."))
        }
    }
}
