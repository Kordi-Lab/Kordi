import SwiftUI
import UIKit

enum PrivacyCoverEvent: Equatable {
    case willDeactivate
    case didEnterBackground
    case didActivate
}

/// Covers each window scene with a blank screen while it is not active, so the
/// app switcher snapshot does not show conversations.
///
/// The cover is a separate window above alerts that is shown and hidden
/// synchronously inside the scene notification, and it never becomes the key
/// window. `suspend()` and `resume()` exist only for a flow that must keep the
/// scene inactive while it needs input; no flow uses them today.
@MainActor
final class PrivacyCoverController {
    static let shared = PrivacyCoverController()
    static let storageKey = "kordi.privacy.hideInAppSwitcher"

    private let defaults: UserDefaults
    private var observers: [NSObjectProtocol] = []
    private var observedCenter: NotificationCenter?
    private var suspensionCount = 0
    private var windows: [ObjectIdentifier: UIWindow] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isEnabled: Bool {
        defaults.object(forKey: Self.storageKey) as? Bool ?? true
    }

    var isSuspended: Bool { suspensionCount > 0 }

    /// Leaving the app always covers it when enabled. A suspension only keeps
    /// an inactive (still visible) scene uncovered.
    nonisolated static func isCovered(
        after event: PrivacyCoverEvent,
        enabled: Bool,
        suspended: Bool
    ) -> Bool {
        switch event {
        case .didActivate: false
        case .willDeactivate: enabled && !suspended
        case .didEnterBackground: enabled
        }
    }

    func install(center: NotificationCenter = .default) {
        guard observers.isEmpty else { return }
        observedCenter = center
        let events: [(Notification.Name, PrivacyCoverEvent)] = [
            (UIScene.willDeactivateNotification, .willDeactivate),
            (UIScene.didEnterBackgroundNotification, .didEnterBackground),
            (UIScene.didActivateNotification, .didActivate),
        ]
        observers = events.map { name, event in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    self?.handle(event, scene: notification.object as? UIScene)
                }
            }
        }
        observers.append(center.addObserver(
            forName: UIScene.didDisconnectNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                self?.dropWindow(for: notification.object as? UIScene)
            }
        })
    }

    func uninstall() {
        observers.forEach { observedCenter?.removeObserver($0) }
        observers = []
        observedCenter = nil
        windows.values.forEach { $0.isHidden = true }
        windows = [:]
    }

    func suspend() {
        suspensionCount += 1
    }

    func resume() {
        suspensionCount = max(0, suspensionCount - 1)
    }

    func handle(_ event: PrivacyCoverEvent, scene: UIScene?) {
        guard let scene = scene as? UIWindowScene else { return }
        if Self.isCovered(after: event, enabled: isEnabled, suspended: isSuspended) {
            show(in: scene)
        } else {
            windows[ObjectIdentifier(scene)]?.isHidden = true
        }
    }

    func coverWindow(for scene: UIScene) -> UIWindow? {
        windows[ObjectIdentifier(scene)]
    }

    var cachedWindowCount: Int { windows.count }

    private func show(in scene: UIWindowScene) {
        let key = ObjectIdentifier(scene)
        let window = windows[key] ?? makeWindow(for: scene)
        windows[key] = window
        window.overrideUserInterfaceStyle = interfaceStyle
        window.isHidden = false
    }

    private func dropWindow(for scene: UIScene?) {
        guard let scene else { return }
        windows.removeValue(forKey: ObjectIdentifier(scene))?.isHidden = true
    }

    private func makeWindow(for scene: UIWindowScene) -> UIWindow {
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.accessibilityElementsHidden = true
        let controller = UIHostingController(rootView: PrivacyCoverView())
        controller.view.backgroundColor = .systemBackground
        window.rootViewController = controller
        return window
    }

    private var interfaceStyle: UIUserInterfaceStyle {
        switch AppAppearance(rawValue: defaults.string(forKey: AppAppearance.storageKey) ?? "") {
        case .light: .light
        case .dark: .dark
        case .system, nil: .unspecified
        }
    }
}

private struct PrivacyCoverView: View {
    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()
            Image("KordiLaunchMark")
        }
        .accessibilityHidden(true)
    }
}
