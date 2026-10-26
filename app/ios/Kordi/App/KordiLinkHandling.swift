import SwiftUI

extension View {
    /// Handles in-app links: Connectors settings links, shared document
    /// links (`kordi://document/<token>`, `https://kordi.ai/d/<token>`) and
    /// Grounding pairing links (`kordi://common-ground/pair/<code>`), from
    /// tapped links and from `onOpenURL`.
    func kordiLinkHandling(openConnectors: @escaping (ConnectorsSettingsLink) -> Void) -> some View {
        modifier(KordiLinkHandling(openConnectors: openConnectors))
    }
}

private struct KordiLinkHandling: ViewModifier {
    let openConnectors: (ConnectorsSettingsLink) -> Void
    @State private var documentLink: SharedDocumentLink?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                handle(url) ? .handled : .systemAction
            })
            .onOpenURL { url in _ = handle(url) }
            .fullScreenCover(item: $documentLink) { link in
                SharedDocumentLinkReader(link: link)
            }
    }

    private func handle(_ url: URL) -> Bool {
        if let link = SharedDocumentLink.parse(url) {
            documentLink = link
            return true
        }
        if let link = ConnectorsSettingsLink.parse(url) {
            openConnectors(link)
            return true
        }
        if let link = CommonGroundPairLink.parse(url) {
            CommonGroundPairLinkInbox.shared.code = link.code
            return true
        }
        return false
    }
}

/// Opens Grounding on the main stack when a pairing link or a tapped
/// Nearby alert arrives; Home takes the code and pairs, Grounding opens the
/// nearby person.
struct CommonGroundPairLinkRouting: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var inbox = CommonGroundPairLinkInbox.shared
    @ObservedObject private var nearbyAlerts = CommonGroundNearbyAlertInbox.shared
    @Binding var path: [MainNavigationRoute]

    func body(content: Content) -> some View {
        // Also runs at launch and once Grounding becomes available.
        content
            .task(id: model.isCommonGroundAvailable ? inbox.code : nil) {
                if inbox.code != nil { openGrounding() }
            }
            .task(id: model.isCommonGroundAvailable ? nearbyAlerts.accountId : nil) {
                if nearbyAlerts.accountId != nil { openGrounding() }
            }
    }

    private func openGrounding() {
        guard model.isCommonGroundAvailable else { return }
        if let index = path.lastIndex(of: .commonGround) {
            path.removeSubrange((index + 1)...)
        } else {
            path.append(.commonGround)
        }
    }
}

/// The reader for an opened link, loaded through the public route.
private struct SharedDocumentLinkReader: View {
    @Environment(\.dismiss) private var dismiss
    let link: SharedDocumentLink

    var body: some View {
        NavigationStack {
            DocumentReaderScreen(request: DocumentReaderRequest(link: link))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
    }
}
