import SwiftUI
import WebKit

/// An HTML document from the raw route. Scripts are off, every navigation
/// after the initial load is cancelled, and remote loads are blocked, so the
/// file can only show its own markup, inline styles, and `data:` images.
struct DocumentHTMLView: UIViewRepresentable {
    let data: Data
    @Binding var contentHeight: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(contentHeight: $contentHeight) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        context.coordinator.observe(webView)
        context.coordinator.load(data, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.contentHeight = $contentHeight
        if context.coordinator.loadedData != data {
            context.coordinator.load(data, in: webView)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.sizeObservation = nil
        webView.navigationDelegate = nil
        webView.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var contentHeight: Binding<CGFloat>
        var loadedData: Data?
        var sizeObservation: NSKeyValueObservation?
        private var allowsNextNavigation = false

        init(contentHeight: Binding<CGFloat>) {
            self.contentHeight = contentHeight
        }

        func observe(_ webView: WKWebView) {
            sizeObservation = webView.scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, change in
                guard let height = change.newValue?.height, height > 0 else { return }
                Task { @MainActor [weak self] in
                    guard let self, abs(self.contentHeight.wrappedValue - height) > 1 else { return }
                    self.contentHeight.wrappedValue = height
                }
            }
        }

        func load(_ data: Data, in webView: WKWebView) {
            loadedData = data
            allowsNextNavigation = true
            Self.blockRemoteLoads(in: webView) {
                webView.load(data, mimeType: "text/html", characterEncodingName: "utf-8", baseURL: URL(string: "about:blank")!)
            }
        }

        /// Blocks every http and https request the page would make.
        private static func blockRemoteLoads(in webView: WKWebView, then load: @escaping () -> Void) {
            let rules = #"[{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}}]"#
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "kordi-document-offline",
                encodedContentRuleList: rules
            ) { list, _ in
                Task { @MainActor in
                    if let list { webView.configuration.userContentController.add(list) }
                    load()
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            preferences: WKWebpagePreferences,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
        ) {
            preferences.allowsContentJavaScript = false
            // Only the initial load of the document bytes is allowed.
            if allowsNextNavigation, navigationAction.targetFrame?.isMainFrame == true {
                allowsNextNavigation = false
                decisionHandler(.allow, preferences)
            } else {
                decisionHandler(.cancel, preferences)
            }
        }
    }
}
