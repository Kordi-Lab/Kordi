import SwiftUI
import UIKit

// This controller owns transitions only; hosted SwiftUI stacks own navigation bars.
private final class MainTransitionNavigationController: UINavigationController {
    override func setNavigationBarHidden(_ hidden: Bool, animated: Bool) {
        super.setNavigationBarHidden(true, animated: false)
    }
}

@MainActor
struct MainNavigationHost<Root: View, Destination: View>: View {
    @Binding var path: [MainNavigationRoute]
    let root: Root
    let destination: (MainNavigationRoute) -> Destination

    init(
        path: Binding<[MainNavigationRoute]>,
        @ViewBuilder root: () -> Root,
        @ViewBuilder destination: @escaping (MainNavigationRoute) -> Destination
    ) {
        _path = path
        self.root = root()
        self.destination = destination
    }

    var body: some View {
        MainNavigationControllerHost(path: $path, root: root, destination: destination)
            // The hosted screen owns keyboard avoidance. Resizing this outer
            // container as well exposes its background ahead of the keyboard.
            .ignoresSafeArea(.all, edges: .bottom)
    }
}

@MainActor
private struct MainNavigationControllerHost<Root: View, Destination: View>: UIViewControllerRepresentable {
    @Binding var path: [MainNavigationRoute]
    let root: Root
    let destination: (MainNavigationRoute) -> Destination

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = MainTransitionNavigationController(rootViewController: context.coordinator.rootController)
        controller.setNavigationBarHidden(true, animated: false)
        controller.delegate = context.coordinator
        controller.loadViewIfNeeded()
        controller.interactivePopGestureRecognizer?.delegate = context.coordinator
        context.coordinator.controller = controller
        return controller
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {
        context.coordinator.parent = self
        context.coordinator.reconcile()
    }

    @MainActor
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
        var parent: MainNavigationControllerHost
        let rootController: UIHostingController<Root>
        weak var controller: UINavigationController?
        private var routes: [MainNavigationRoute] = []
        private var destinations: [UIHostingController<Destination>] = []
        private var transitionPath: [MainNavigationRoute]?

        init(_ parent: MainNavigationControllerHost) {
            self.parent = parent
            rootController = UIHostingController(rootView: parent.root)
        }

        func reconcile() {
            guard let controller, transitionPath == nil else { return }
            rootController.rootView = parent.root
            let desired = parent.path
            let retained = zip(routes, desired).prefix { $0 == $1 }.count
            destinations = Array(destinations.prefix(retained))
            for (index, route) in desired.enumerated() {
                if index < retained {
                    destinations[index].rootView = parent.destination(route)
                } else {
                    destinations.append(UIHostingController(rootView: parent.destination(route)))
                }
            }
            routes = desired
            let stack: [UIViewController] = [rootController] + destinations
            guard !controller.viewControllers.elementsEqual(stack, by: { $0 === $1 }) else { return }
            controller.setViewControllers(stack, animated: controller.view.window != nil)
        }

        func navigationController(
            _ navigationController: UINavigationController,
            willShow viewController: UIViewController,
            animated: Bool
        ) {
            transitionPath = parent.path
        }

        func navigationController(
            _ navigationController: UINavigationController,
            didShow viewController: UIViewController,
            animated: Bool
        ) {
            let visibleCount = max(0, navigationController.viewControllers.count - 1)
            if visibleCount < routes.count, parent.path == transitionPath {
                routes = Array(routes.prefix(visibleCount))
                destinations = Array(destinations.prefix(visibleCount))
                parent.path = routes
            }
            transitionPath = nil
            reconcile()
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let controller, controller.viewControllers.count > 1,
                  transitionPath == nil, let top = controller.topViewController else { return false }
            return !containsPushedNavigation(top)
        }

        private func containsPushedNavigation(_ controller: UIViewController) -> Bool {
            if let navigation = controller as? UINavigationController,
               navigation.viewControllers.count > 1 { return true }
            return controller.children.contains(where: containsPushedNavigation)
        }
    }
}
