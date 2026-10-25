import SwiftUI
import UIKit

/// Presents full-screen chat content, such as the photo picker and the image
/// viewer, from its own hosting controller. As a SwiftUI cover of the chat,
/// that content was rebuilt with fresh state whenever the chat updated under
/// it: the picker flashed and dropped its selection, and the viewer jumped
/// back to the first photo.
@MainActor
enum ConversationModalPresenter {
    static func present<Content: View>(
        transparent: Bool = false,
        transition: UIModalTransitionStyle = .coverVertical,
        statusBarStyle: UIStatusBarStyle = .default,
        @ViewBuilder content: (_ close: @escaping () -> Void) -> Content
    ) {
        guard let presenter = topViewController(), !(presenter is ConversationModalHostingController) else { return }
        let closer = Closer()
        let host = ConversationModalHostingController(rootView: AnyView(content(closer.close)))
        host.statusBarStyle = statusBarStyle
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

    private static func topViewController() -> UIViewController? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        var top = window?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
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
    var statusBarStyle: UIStatusBarStyle = .default

    override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }
}
