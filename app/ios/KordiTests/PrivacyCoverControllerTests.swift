import UIKit
import XCTest
@testable import Kordi

@MainActor
final class PrivacyCoverControllerTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suiteName = "kordi.tests.privacy-cover.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
    }

    func testCoverStateAfterEachSceneEvent() {
        typealias Controller = PrivacyCoverController
        XCTAssertTrue(Controller.isCovered(after: .willDeactivate, enabled: true, suspended: false))
        XCTAssertTrue(Controller.isCovered(after: .didEnterBackground, enabled: true, suspended: false))
        XCTAssertFalse(Controller.isCovered(after: .didActivate, enabled: true, suspended: false))

        for event in [PrivacyCoverEvent.willDeactivate, .didEnterBackground, .didActivate] {
            XCTAssertFalse(Controller.isCovered(after: event, enabled: false, suspended: false))
            XCTAssertFalse(Controller.isCovered(after: event, enabled: false, suspended: true))
        }

        // A suspension keeps a visible inactive scene usable, but leaving the
        // app still covers it.
        XCTAssertFalse(Controller.isCovered(after: .willDeactivate, enabled: true, suspended: true))
        XCTAssertTrue(Controller.isCovered(after: .didEnterBackground, enabled: true, suspended: true))
        XCTAssertFalse(Controller.isCovered(after: .didActivate, enabled: true, suspended: true))
    }

    func testCoverIsOnUnlessTurnedOffAndSuspensionsNest() {
        let controller = PrivacyCoverController(defaults: defaults)
        XCTAssertEqual(PrivacyCoverController.storageKey, "kordi.privacy.hideInAppSwitcher")
        XCTAssertTrue(controller.isEnabled)
        defaults.set(false, forKey: PrivacyCoverController.storageKey)
        XCTAssertFalse(controller.isEnabled)

        XCTAssertFalse(controller.isSuspended)
        controller.suspend()
        controller.suspend()
        controller.resume()
        XCTAssertTrue(controller.isSuspended)
        controller.resume()
        controller.resume()
        XCTAssertFalse(controller.isSuspended)
    }

    func testSceneNotificationsShowHideAndReleaseTheCoverWindow() throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "The hosted test app has a window scene"
        )
        let center = NotificationCenter()
        let controller = PrivacyCoverController(defaults: defaults)
        controller.install(center: center)
        defer { controller.uninstall() }

        center.post(name: UIScene.willDeactivateNotification, object: scene)
        let window = try XCTUnwrap(controller.coverWindow(for: scene))
        XCTAssertFalse(window.isHidden)
        XCTAssertFalse(window.isKeyWindow)
        XCTAssertEqual(window.windowLevel, .alert + 1)
        XCTAssertTrue(window.accessibilityElementsHidden)
        XCTAssertTrue(window.windowScene === scene)

        center.post(name: UIScene.didActivateNotification, object: scene)
        XCTAssertTrue(window.isHidden)
        XCTAssertEqual(controller.cachedWindowCount, 1)

        center.post(name: UIScene.didEnterBackgroundNotification, object: scene)
        XCTAssertTrue(controller.coverWindow(for: scene) === window, "The window is reused")
        XCTAssertFalse(window.isHidden)

        center.post(name: UIScene.didDisconnectNotification, object: scene)
        XCTAssertTrue(window.isHidden)
        XCTAssertNil(controller.coverWindow(for: scene))
        XCTAssertEqual(controller.cachedWindowCount, 0)
    }

    func testDisabledCoverAndSuspendedDeactivationCreateNoWindow() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let center = NotificationCenter()
        let controller = PrivacyCoverController(defaults: defaults)
        controller.install(center: center)
        defer { controller.uninstall() }

        controller.suspend()
        center.post(name: UIScene.willDeactivateNotification, object: scene)
        XCTAssertNil(controller.coverWindow(for: scene))
        controller.resume()

        defaults.set(false, forKey: PrivacyCoverController.storageKey)
        center.post(name: UIScene.willDeactivateNotification, object: scene)
        center.post(name: UIScene.didEnterBackgroundNotification, object: scene)
        XCTAssertNil(controller.coverWindow(for: scene))
    }

    func testAppDelegateInstallsTheSharedCover() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let app = try String(contentsOf: directory.appendingPathComponent("Kordi/App/KordiApp.swift"), encoding: .utf8)
        let launch = try XCTUnwrap(app.range(of: "didFinishLaunchingWithOptions"))
        let install = try XCTUnwrap(app.range(of: "PrivacyCoverController.shared.install()"))
        XCTAssertLessThan(launch.lowerBound, install.lowerBound)

        let source = try String(
            contentsOf: directory.appendingPathComponent("Kordi/App/PrivacyCoverController.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(source.contains("makeKeyAndVisible"))
        XCTAssertFalse(source.contains("makeKey()"))
    }
}
