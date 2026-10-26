import SwiftUI
import UIKit

/// Presents full-screen chat content, such as the photo picker and the image
/// viewer, from its own hosting controller. As a SwiftUI cover of the chat,
/// that content was rebuilt with fresh state whenever the chat updated under
/// it: the picker flashed and dropped its selection, and the viewer jumped
/// back to the first photo.
@MainActor
enum ConversationModalPresenter {
    /// `ownerID` ties the modal to the chat that opened it; the chat closes it
    /// when it goes away (see `dismiss(ownedBy:)`).
    static func present<Content: View>(
        ownerID: String,
        transparent: Bool = false,
        transition: UIModalTransitionStyle = .coverVertical,
        interfaceStyle: UIUserInterfaceStyle = .unspecified,
        statusBarStyle: UIStatusBarStyle = .default,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: (_ close: @escaping () -> Void) -> Content
    ) {
        guard let presenter = topViewController(), !(presenter is ConversationModalHostingController) else { return }
        let closer = Closer()
        let host = ConversationModalHostingController(rootView: AnyView(content(closer.close)))
        host.ownerID = ownerID
        host.onDismiss = onDismiss
        host.statusBarStyle = statusBarStyle
        host.overrideUserInterfaceStyle = interfaceStyle
        // Over full screen keeps the chat in the window: its appear and
        // disappear handlers leave the draft alone, and a transparent
        // backdrop shows the chat while the content is dragged away.
        host.modalPresentationStyle = .overFullScreen
        host.modalTransitionStyle = transition
        host.modalPresentationCapturesStatusBarAppearance = true
        if transparent { host.view.backgroundColor = .clear }
        closer.controller = host
        presenter.present(host, animated: true)
    }

    /// Closes a modal opened by the given chat, for example when navigation
    /// replaces the chat underneath it.
    static func dismiss(ownedBy ownerID: String) {
        guard let host = presentedHost(), host.ownerID == ownerID else { return }
        host.dismiss(animated: false)
    }

    /// Makes room for app-level presentations such as the call screen.
    static func dismissAll() {
        presentedHost()?.dismiss(animated: false)
    }

    private static func presentedHost() -> ConversationModalHostingController? {
        var current = keyWindow()?.rootViewController
        while let presented = current?.presentedViewController {
            if let host = presented as? ConversationModalHostingController { return host }
            current = presented
        }
        return nil
    }

    private static func topViewController() -> UIViewController? {
        var top = keyWindow()?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
    }

    @MainActor
    private final class Closer {
        weak var controller: UIViewController?

        func close() {
            controller?.dismiss(animated: true)
        }
    }
}

final class ConversationModalHostingController: UIHostingController<AnyView> {
    var ownerID: String?
    var statusBarStyle: UIStatusBarStyle = .default
    /// Runs once the modal has closed, however it was closed.
    var onDismiss: (() -> Void)?

    override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed else { return }
        onDismiss?()
        onDismiss = nil
    }
}
