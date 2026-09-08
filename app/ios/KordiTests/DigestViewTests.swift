import XCTest
import Testing
import SwiftUI
import UIKit
@testable import Kordi

@MainActor
private final class SessionTabProbe: ObservableObject {
    @Published var path: [MainNavigationRoute] = []
    @Published var selection = MainTab.chats
    @Published var isPresented = false
    @Published var phase = "Loading conversation"
    @Published var appearanceCount = 0
    @Published var bannerFrame = CGRect.zero
}

private struct SessionTabProbeView: View {
    @ObservedObject var state: SessionTabProbe
    var baseline = false
    var model: AppModel? = nil
    var hasTopAccessory = false

    @ViewBuilder
    var body: some View {
        if baseline { tabs }
        else {
            MainNavigationHost(path: $state.path) { tabs } destination: { route in
                if let model {
                    MainNavigationDestination(path: $state.path, route: route, selectedTab: state.selection)
                        .environmentObject(model).environmentObject(KordiNotificationCoordinator()).environmentObject(KordiCallCoordinator())
                } else { session }
            }
            .ignoresSafeArea(.container, edges: hasTopAccessory ? .bottom : .vertical)
        }
    }

    private var tabs: some View {
            Group {
                if #available(iOS 18.0, *) {
                    TabView(selection: $state.selection) {
                        ForEach(MainTab.allCases, id: \.self) { tab in
                            Tab(value: tab) { root(tab) } label: { Label(tab.rawValue, systemImage: tab.symbol) }
                        }
                    }
                } else {
                    TabView(selection: $state.selection) {
                        ForEach(MainTab.allCases, id: \.self) { tab in
                            root(tab).tabItem { Label(tab.rawValue, systemImage: tab.symbol) }.tag(tab)
                        }
                    }
                }
            }
    }

    @ViewBuilder private func root(_ tab: MainTab) -> some View {
        if tab == .chats { list }
        else { NavigationStack { Text(tab.rawValue) } }
    }

    private var list: some View {
        NavigationStack {
            if let model {
                ChatHomeView(channel: .contact, onOpenConversation: { state.path.append(.conversation($0)) })
                    .environmentObject(model).environmentObject(KordiNotificationCoordinator()).environmentObject(KordiCallCoordinator())
            } else {
            Text("Chat list")
                .navigationTitle("Chats")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("New") {} } }
            }
        }
    }

    private var session: some View {
        NavigationStack {
            sessionContent
                .navigationDestination(isPresented: $state.isPresented) { sessionContent }
        }
    }

    private var sessionContent: some View {
        Group {
            if state.phase == "Loading conversation" { ProgressView(state.phase) }
            else { Text(state.phase) }
        }
        .toolbar(.visible, for: .navigationBar)
        .onAppear { state.appearanceCount += 1 }
    }
}

private struct GroupDetailNavigationProbe: View {
    @ObservedObject var state: SessionTabProbe
    @ObservedObject var model: AppModel
    let notifications = KordiNotificationCoordinator()
    let calls = KordiCallCoordinator()

    var body: some View {
        MainNavigationHost(path: $state.path) {
            SessionTabProbeView(state: state, baseline: true, model: model)
        } destination: { route in
            MainNavigationDestination(path: $state.path, route: route, selectedTab: .chats)
                .environmentObject(model).environmentObject(notifications).environmentObject(calls)
        }
        .ignoresSafeArea(.container, edges: .vertical)
    }
}

@MainActor @Test
func groupDetailsReturnRestoresTheSameConversationHeaderGeometry() async throws {
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previous = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    window.frame = scene.coordinateSpace.bounds
    window.overrideUserInterfaceStyle = .light
    defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
    let state = SessionTabProbe(), model = AppModel(previewMode: true)
    let group = try #require(model.conversations.first { $0.kind == .group })
    let host = UIHostingController(rootView: GroupDetailNavigationProbe(state: state, model: model))
    window.rootViewController = host; window.makeKeyAndVisible()
    host.view.frame = window.bounds; host.view.layoutIfNeeded()
    func navigation(in controller: UIViewController) -> UINavigationController? {
        if let navigation = controller as? UINavigationController { return navigation }
        return controller.children.lazy.compactMap { navigation(in: $0) }.first
    }
    func frame(_ view: UIView) -> CGRect { view.convert(view.bounds, to: window) }
    func presentationFrame(_ view: UIView) -> CGRect {
        let layer = view.layer.presentation() ?? view.layer
        return layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer)
    }
    func snapshot(_ name: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image {
            _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        Attachment.record(try #require(image.pngData()), named: name + ".png")
    }
    try await Task.sleep(for: .milliseconds(500))
    let outer = try #require(navigation(in: host))
    state.path = [.conversation(group)]
    try await Task.sleep(for: .seconds(1))
    for _ in 0..<30 where outer.transitionCoordinator != nil { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(150))
    let outerDestination = try #require(outer.topViewController)
    let inner = try #require(navigation(in: outerDestination))
    let conversationController = try #require(inner.topViewController)
    func chromeState() -> String {
        let bar = inner.navigationBar
        let title = conversationController.navigationItem.titleView
        return "safe area: \(conversationController.view.safeAreaInsets); bar hidden: \(inner.isNavigationBarHidden); bar attached: \(bar.window != nil); bar alpha: \(bar.alpha); presentation: \(String(describing: bar.layer.presentation()?.frame)); opacity: \(String(describing: bar.layer.presentation()?.opacity)); title attached: \(title?.window != nil); title alpha: \(String(describing: title?.alpha))"
    }
    let beforeBar = frame(inner.navigationBar)
    let beforeTitle = conversationController.navigationItem.titleView.map(frame)
    let beforePage = presentationFrame(outerDestination.view)
    let beforeChrome = chromeState()
    try snapshot("group-before-details")
    #expect(outer.isNavigationBarHidden && !inner.isNavigationBarHidden)
    #expect(conversationController.navigationItem.title == group.displayName)
    let items = conversationController.navigationItem.trailingItemGroups.flatMap(\.barButtonItems)
        + (conversationController.navigationItem.rightBarButtonItems ?? [])
    Attachment.record(items.map {
        "title=\($0.title ?? "nil"); label=\($0.accessibilityLabel ?? "nil"); action=\($0.action.map(NSStringFromSelector) ?? "nil"); custom=\(String(describing: $0.customView.map { type(of: $0) }))"
    }.joined(separator: "\n"), named: "group-info-actions.txt")
    let info = try #require(items.first { $0.accessibilityLabel == "Open info for \(group.displayName)" } ?? items.last)
    let action = try #require(info.action)
    #expect(UIApplication.shared.sendAction(action, to: info.target, from: info, for: nil))
    for _ in 0..<30 where outer.viewControllers.count != 3 { try await Task.sleep(for: .milliseconds(50)) }
    #expect(outer.viewControllers.count == 3, "The real info action must push a separate details page")
    try await Task.sleep(for: .milliseconds(500))
    for _ in 0..<30 where outer.transitionCoordinator != nil { try await Task.sleep(for: .milliseconds(50)) }
    let detailsController = try #require(outer.topViewController)
    let detailsNavigation = try #require(navigation(in: detailsController))
    try snapshot("actual-group-details")
    #expect(detailsNavigation.isNavigationBarHidden, "The detail page retains its existing custom back control")
    #expect(!inner.isNavigationBarHidden && inner.viewControllers.count == 1)
    #expect(outer.isNavigationBarHidden && state.path.count == 2)
    model.objectWillChange.send()
    try await Task.sleep(for: .milliseconds(50))
    outer.popViewController(animated: true)
    for _ in 0..<30 where outer.viewControllers.count != 2 { try await Task.sleep(for: .milliseconds(10)) }
    try await Task.sleep(for: .milliseconds(80))
    let transitionBar = frame(inner.navigationBar)
    let transitionTitle = inner.topViewController?.navigationItem.titleView.map(frame)
    let movingTitleView = try #require(inner.topViewController?.navigationItem.titleView)
    let movingTitle = presentationFrame(movingTitleView)
    let movingPage = presentationFrame(outerDestination.view)
    let initialTitleFrame = try #require(beforeTitle)
    let pageDelta = CGPoint(x: movingPage.minX - beforePage.minX, y: movingPage.minY - beforePage.minY)
    let titleDelta = CGPoint(x: movingTitle.minX - initialTitleFrame.minX, y: movingTitle.minY - initialTitleFrame.minY)
    let transitionChrome = chromeState()
    try snapshot("group-detail-return-transition")
    #expect(abs(pageDelta.x) > 1 || abs(pageDelta.y) > 1, "The check must sample actual page motion")
    #expect(abs(titleDelta.x - pageDelta.x) <= 2 && abs(titleDelta.y - pageDelta.y) <= 2,
        "The session title must move with its chat page, not animate on a separate bar")
    try await Task.sleep(for: .milliseconds(650))
    host.view.layoutIfNeeded()
    let afterBar = frame(inner.navigationBar)
    let afterTitle = inner.topViewController?.navigationItem.titleView.map(frame)
    try snapshot("group-after-details")
    Attachment.record("before bar: \(beforeBar); title: \(String(describing: beforeTitle)); page: \(beforePage); \(beforeChrome)\ntransition bar: \(transitionBar); title: \(String(describing: transitionTitle)); page: \(movingPage); page delta: \(pageDelta); title delta: \(titleDelta); \(transitionChrome)\nafter bar: \(afterBar); title: \(String(describing: afterTitle)); \(chromeState())", named: "group-detail-return-geometry.txt")
    #expect(outer.topViewController === outerDestination && outer.viewControllers.count == 2 && state.path.count == 1)
    #expect(inner.topViewController === conversationController && inner.viewControllers.count == 1)
    #expect(outer.isNavigationBarHidden && !inner.isNavigationBarHidden)
    #expect(inner.topViewController?.navigationItem.title == group.displayName)
    #expect(abs(afterBar.minY - beforeBar.minY) <= 1 && abs(afterBar.height - beforeBar.height) <= 1)
    let initialTitle = try #require(beforeTitle)
    let returnedTitle = try #require(afterTitle)
    #expect(abs(returnedTitle.midX - initialTitle.midX) <= 1 && abs(returnedTitle.midY - initialTitle.midY) <= 1)
}

@MainActor
@Test
func sessionsHaveNoMainTabBarInTheirNavigationHierarchy() async throws {
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousWindow = scene.windows.first(where: \.isKeyWindow)
    let state = SessionTabProbe()
    let window = UIWindow(windowScene: scene)
    window.frame = scene.coordinateSpace.bounds
    window.overrideUserInterfaceStyle = .light
    defer { window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKeyAndVisible() }
    let controller = UIHostingController(rootView: SessionTabProbeView(state: state))
    window.rootViewController = controller
    window.makeKeyAndVisible()
    controller.view.frame = window.bounds
    controller.view.layoutIfNeeded()

    func child<T: UIViewController>(_ type: T.Type, in parent: UIViewController) -> T? {
        if let result = parent as? T { return result }
        return parent.children.lazy.compactMap { child(type, in: $0) }.first
    }

    func tabBar(in view: UIView) -> UITabBar? {
        if let bar = view as? UITabBar { return bar }
        return view.subviews.lazy.compactMap { tabBar(in: $0) }.first
    }
    func hasTrailingAction(_ navigation: UINavigationController) -> Bool {
        guard let item = navigation.topViewController?.navigationItem else { return false }
        return !item.trailingItemGroups.flatMap(\.barButtonItems).isEmpty || item.rightBarButtonItems?.isEmpty == false
    }
    for _ in 0..<40 where tabBar(in: window) == nil { try await Task.sleep(for: .milliseconds(50)) }
    let navigation = try #require(child(UINavigationController.self, in: controller))
    let tabs = try #require(child(UITabBarController.self, in: controller))
    for _ in 0..<40 where tabs.selectedViewController.flatMap({ child(UINavigationController.self, in: $0) }) == nil {
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
    }
    let rootNavigation = try #require(tabs.selectedViewController.flatMap { child(UINavigationController.self, in: $0) })
    #expect(tabBar(in: try #require(navigation.topViewController).view) != nil)
    try await Task.sleep(for: .milliseconds(100))
    let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
    let rootImage = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    Attachment.record(try #require(rootImage.pngData()), named: "root-toolbar.png")
    #expect(rootNavigation.topViewController?.navigationItem.title == "Chats")
    #expect(hasTrailingAction(rootNavigation))
    #expect(!rootNavigation.isNavigationBarHidden)
    let conversation = ConversationSummary(
        id: "fixture", kind: .person, peerAccountId: "fixture-peer", agentId: nil,
        ownerDisplayName: nil, displayName: "Fixture", lastMessage: "", lastActivityAt: .distantPast,
        unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "fixture-session"
    )
    state.path.append(.conversation(conversation))
    for _ in 0..<40 where navigation.viewControllers.count != 2 || state.appearanceCount != 1 { try await Task.sleep(for: .milliseconds(50)) }
    #expect(navigation.viewControllers.count == 2, "The fixture must actually push the destination")
    #expect(state.appearanceCount == 1, "The pushed view must be session content, not an unresolved-route placeholder")
    let outerDestination = try #require(navigation.topViewController)
    let sessionNavigation = try #require(child(UINavigationController.self, in: outerDestination))
    #expect(!sessionNavigation.isNavigationBarHidden)
    for phase in ["Loading conversation", "Couldn't load messages", "Conversation ready"] {
        state.phase = phase
        try await Task.sleep(for: .milliseconds(100))
        let destination = try #require(navigation.topViewController)
        #expect(tabBar(in: destination.view) == nil, "A session must not contain the main tab bar")
        var ancestor: UIViewController? = destination
        while let current = ancestor {
            #expect(!(current is UITabBarController), "A session must not be hosted inside the main tabs")
            ancestor = current.parent
        }
    }
    state.isPresented = true
    for _ in 0..<40 where sessionNavigation.viewControllers.count != 2 { try await Task.sleep(for: .milliseconds(50)) }
    #expect(sessionNavigation.viewControllers.count == 2, "A thread-like destination must stay in the session-owned stack")
    #expect(navigation.viewControllers.count == 2)
    #expect(tabBar(in: try #require(sessionNavigation.topViewController).view) == nil)
    state.isPresented = false
    for _ in 0..<40 where sessionNavigation.viewControllers.count != 1 { try await Task.sleep(for: .milliseconds(50)) }
    state.path = []
    for _ in 0..<40 where navigation.viewControllers.count != 1 { try await Task.sleep(for: .milliseconds(50)) }
    #expect(navigation.viewControllers.count == 1)
    #expect(rootNavigation.topViewController?.navigationItem.title == "Chats")
    #expect(hasTrailingAction(rootNavigation))
    #expect(!rootNavigation.isNavigationBarHidden)
    #expect(tabBar(in: try #require(navigation.topViewController).view) != nil, "Returning to the list must restore the main tabs")
    for notification in [false, true] {
        let expectedAppearances = state.appearanceCount + 1
        if notification { state.path.append(.message(KordiMessageNotificationRoute(conversation: conversation, messageID: "fixture-message"))) }
        else { state.path.append(.conversation(conversation)) }
        for _ in 0..<40 where navigation.viewControllers.count != 2 || state.appearanceCount != expectedAppearances { try await Task.sleep(for: .milliseconds(50)) }
        #expect(navigation.viewControllers.count == 2, "Typed routes must reach the outer navigation stack")
        #expect(state.appearanceCount == expectedAppearances, "The typed route must render its actual session")
        #expect(tabBar(in: try #require(navigation.topViewController).view) == nil)
        navigation.popViewController(animated: false)
        for _ in 0..<40 where navigation.viewControllers.count != 1 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(navigation.viewControllers.count == 1)
        for _ in 0..<40 where !state.path.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
        #expect(state.path.isEmpty, "Native back must reconcile the bound route array")
    }
}

@Test
func mainTabsAreOnlyTheRootOfSessionNavigation() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    func source(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }
    let app = try source("Kordi/App/KordiApp.swift")
    let start = try #require(app.range(of: "struct MainTabView:"))
    let end = try #require(app.range(of: "struct MainTabUnreadCounts:"))
    let main = app[start.lowerBound..<end.lowerBound]
    #expect(main.components(separatedBy: "MainNavigationHost(path: $path)").count - 1 == 1)
    #expect(main.contains("@State private var path: [MainNavigationRoute] = []"))
    #expect(main.contains(".ignoresSafeArea(.container, edges: hasTopAccessory ? .bottom : .vertical)"))
    #expect(app.contains("RootView(hasTopAccessory: showsPreviewThemeControls || callCoordinator.isMinimized)"))
    #expect(app.contains("MainTabView(hasTopAccessory: hasTopAccessory)"))
    #expect(!app.contains("kordiTabBarVisibility"))
    #expect(!main.contains("MainTabContentHost"))
    #expect(main.contains("ContactsView(onOpenConversation: { path.append(.conversation($0)) })"))
    #expect(main.contains("MainNavigationDestination(path: $path, route: route, selectedTab: selection)"))
    let destinations = try source("Kordi/App/MainNavigationDestinations.swift")
    for route in ["conversation(ConversationSummary)", "message(KordiMessageNotificationRoute)", "newChat(NewChatMode)", "archived(ChatChannel)"] {
        #expect(destinations.contains("case \(route)"))
    }
    for path in ["ConversationView.swift", "AgentSubsessionView.swift", "SessionDetailSheet.swift", "CompanionChatPanel.swift"] {
        let view = try source("Kordi/Features/Conversation/\(path)")
        #expect(!view.contains("kordiTabBarVisibility"))
        #expect(!view.contains("for: .navigationBar, .tabBar"))
    }
}

@MainActor @Test
func actualPushedScreensKeepOneBarAndOriginalRootGeometry() async throws {
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previous = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene); window.frame = scene.coordinateSpace.bounds
    window.overrideUserInterfaceStyle = .light
    defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
    let state = SessionTabProbe(), model = AppModel(previewMode: true)
    func views<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
    }
    func controllers(_ item: UIViewController) -> [UINavigationController] {
        ((item as? UINavigationController).map { [$0] } ?? []) + item.children.flatMap(controllers)
    }
    func visible(_ view: UIView) -> Bool {
        guard view.window != nil else { return false }
        var rect = view.convert(view.bounds, to: window), node: UIView? = view
        while let current = node {
            if current.isHidden || current.alpha == 0 { return false }
            if current.clipsToBounds { rect = rect.intersection(current.convert(current.bounds, to: window)) }
            node = current.superview
        }
        return !rect.isEmpty && window.bounds.intersects(rect)
    }
    func snapshot(_ name: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        Attachment.record(try #require(image.pngData()), named: name + ".png")
    }
    func show(baseline: Bool, banner: Bool = false) async throws -> UIViewController {
        let host = UIHostingController(rootView: SessionTabProbeView(state: state, baseline: baseline, model: model, hasTopAccessory: banner)
            .safeAreaInset(edge: .top, spacing: 0) {
                if banner { Text("Active call").frame(maxWidth: .infinity).frame(height: 50).background(.thinMaterial)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { state.bannerFrame = $0 } }
            })
        window.rootViewController = host; window.makeKeyAndVisible()
        host.view.frame = window.bounds; host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(750)); return host
    }
    _ = try await show(baseline: true)
    try snapshot("pre-navigation-root")
    let oldBar = try #require(views(UINavigationBar.self, in: window).first(where: visible))
    let oldTab = try #require(views(UITabBar.self, in: window).first(where: visible))
    let oldBarFrame = oldBar.convert(oldBar.bounds, to: window), oldTabFrame = oldTab.convert(oldTab.bounds, to: window)
    let host = try await show(baseline: false)
    let outer = try #require(controllers(host).first)
    try snapshot("current-native-root")
    let newBar = try #require(views(UINavigationBar.self, in: window).first(where: visible))
    let newTab = try #require(views(UITabBar.self, in: window).first(where: visible))
    let newBarFrame = newBar.convert(newBar.bounds, to: window), newTabFrame = newTab.convert(newTab.bounds, to: window)
    Attachment.record("old bar: \(oldBarFrame); new bar: \(newBarFrame); old tabs: \(oldTabFrame); new tabs: \(newTabFrame)", named: "root-geometry.txt")
    #expect(abs(newBarFrame.height - oldBarFrame.height) <= 1)
    #expect(abs(newTabFrame.minY - oldTabFrame.minY) <= 1)
    let group = try #require(model.conversations.first { $0.kind == .group })
    for route in [MainNavigationRoute.conversation(group), .archived(.contact)] {
        state.path = [route]
        try await Task.sleep(for: .seconds(1))
        #expect(outer.viewControllers.count == 2)
        outer.setNavigationBarHidden(false, animated: false)
        model.objectWillChange.send()
        try await Task.sleep(for: .milliseconds(250))
        #expect(outer.isNavigationBarHidden, "SwiftUI updates must not reveal the transition-only bar")
        let top = try #require(outer.topViewController)
        #expect(views(UINavigationBar.self, in: top.view).filter(visible).count == 1, "The active destination must own exactly one visible bar")
        #expect(views(UITabBar.self, in: top.view).isEmpty)
        if case .archived = route {
            let inner = try #require(controllers(top).first)
            #expect(inner.topViewController?.navigationItem.largeTitleDisplayMode == .never)
            let frame = inner.navigationBar.convert(inner.navigationBar.bounds, to: window)
            Attachment.record("archive bar: \(frame); window safe area: \(window.safeAreaInsets); bounds: \(window.bounds)", named: "archive-geometry.txt")
            #expect(frame.minY >= window.safeAreaInsets.top - 1, "The archive header must stay below the status safe area")
            try snapshot("actual-pushed-archive")
        } else {
            let bar = try #require(views(UINavigationBar.self, in: top.view).first(where: visible))
            let materials = views(UIVisualEffectView.self, in: bar).filter { $0.bounds.width >= bar.bounds.width * 0.9 }.map { $0.convert($0.bounds, to: window) }
            Attachment.record("native frame: \(outer.view.convert(outer.view.bounds, to: window)); bar: \(bar.convert(bar.bounds, to: window)); material frames: \(materials)", named: "top-material-geometry.txt")
            #expect(outer.view.convert(outer.view.bounds, to: window).minY <= 1)
            #expect(materials.contains { $0.minY <= 1 && $0.maxY >= bar.convert(bar.bounds, to: window).maxY - 1 }, "Native navigation material must cover the status area without an extra overlay")
            try snapshot("actual-pushed-group")
        }
        state.path = []; try await Task.sleep(for: .milliseconds(500))
    }
    let bannerHost = try await show(baseline: false, banner: true)
    let bannerOuter = try #require(controllers(bannerHost).first)
    state.path = [.conversation(group)]; try await Task.sleep(for: .seconds(1))
    let bannerTop = try #require(bannerOuter.topViewController)
    let bannerBar = try #require(views(UINavigationBar.self, in: bannerTop.view).first(where: visible))
    let bannerBarFrame = bannerBar.convert(bannerBar.bounds, to: window)
    Attachment.record("banner: \(state.bannerFrame); bar: \(bannerBarFrame)", named: "call-banner-geometry.txt")
    #expect(state.bannerFrame.height == 50 && bannerBarFrame.minY >= state.bannerFrame.maxY)
    #expect(bannerOuter.isNavigationBarHidden && views(UINavigationBar.self, in: bannerTop.view).filter(visible).count == 1)
    try snapshot("actual-group-with-call-banner")
}

@MainActor
@Test
func digestSeriesCancellationUsesTheModelScopeAndRetainsReview() throws {
    let json = #"{"id":"proposal","title":"Review","text":"A contextual request.","kind":"possible","sourceIds":["reply"],"calendarAction":"delete","calendarScope":"series","existingSeriesId":"owned-series"}"#
    let item = try JSONDecoder().decode(RollingDigestItem.self, from: Data(json.utf8))
    let first = DigestCalendarEvent(id: "digest-proposal", title: "Review", startAt: "2026-09-08T12:00:00Z", revision: 1, seriesId: "owned-series")
    var second = first; second.id = "second"; second.startAt = "2026-09-15T12:00:00Z"
    var other = first; other.id = "other"; other.seriesId = "different-series"
    #expect(item.calendarReviewSeries(events: [other,second,first])?.map(\.id) == [first.id,second.id])
    #expect(try item.calendarReviewEvent(events: [first,second], sources: [], timezone: "UTC").id == first.id)
    #expect(item.calendarReviewLabel(events: [first,second]) == "Review cancellation")
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    #expect(DigestDate.pendingCandidates([item], events: [first,second], on: try #require(DigestDate.parse(second.startAt)), calendar: calendar).count == 1)
    #expect(item.calendarProposalAvailable(events: [first,second]))
    #expect(!item.calendarProposalAvailable(events: []))
    var draft = first; draft.revision = 0
    #expect(!item.calendarProposalAvailable(events: [draft]))
    #expect(DigestDate.pendingCandidates([item], events: [], on: try #require(DigestDate.parse(first.startAt)), calendar: calendar).isEmpty)
}

@MainActor
@Test
func digestEventDatesDefaultToThirtyMinutesAndPreserveDuration() throws {
    let start = try #require(DigestDate.parse("2026-09-09T23:45:00+03:00"))
    let next = start.addingTimeInterval(86400)
    #expect(DigestDate.shiftedEnd(from: start, to: start, end: nil, allDay: false) == start.addingTimeInterval(1800))
    #expect(DigestDate.shiftedEnd(from: start, to: next, end: start.addingTimeInterval(-60), allDay: false) == next.addingTimeInterval(1800))
    #expect(DigestDate.shiftedEnd(from: start, to: next, end: start.addingTimeInterval(3600), allDay: false) == next.addingTimeInterval(3600))
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
    let springDay = try #require(DigestDate.parse("2026-03-08T00:00:00-05:00"))
    #expect(DigestDate.shiftedEnd(from: springDay, to: springDay, end: nil, allDay: true, calendar: calendar) == DigestDate.parse("2026-03-09T00:00:00-04:00"))
}

@MainActor
@Test
func digestAutomaticDatesRejectStaleAndCancelledPreviews() async {
    let preview = DigestSeriesPreview()
    let first = DigestCalendarEvent(id: "first", title: "Review", startAt: "2099-09-08T12:00:00Z")
    let second = DigestCalendarEvent(id: "second", title: "Review", startAt: "2099-09-09T12:00:00Z")
    let cancelled = Task { await preview.update(first, accountId: "viewer") { [$0] } }
    cancelled.cancel()
    await cancelled.value
    #expect(!preview.isReady(for: first, accountId: "viewer"))
    await preview.update(second, accountId: "viewer") { [$0] }
    #expect(preview.isReady(for: second, accountId: "viewer"))
    #expect(!preview.isReady(for: first, accountId: "viewer"))
    #expect(!preview.isReady(for: second, accountId: "another-account"))
    await preview.update(second, accountId: "viewer") { _ in throw DigestCalendarError(message: "Network unavailable") }
    #expect(preview.error != nil && !preview.isReady(for: second, accountId: "viewer"))
    await preview.update(second, accountId: "viewer") { [$0] }
    #expect(preview.isReady(for: second, accountId: "viewer"))
    await preview.update(nil, accountId: "viewer") { _ in Issue.record("An empty request must not be fetched"); return [] }
    #expect(preview.events.isEmpty && !preview.isReady(for: second, accountId: "viewer"))
}

@MainActor
@Test
func digestCalendarReviewPreservesIdentityAndLinksAcrossTimezones() throws {
    let raw = #"{"id":"move","title":"Review","text":"Move later","kind":"possible","sourceIds":[],"calendarAction":"update","existingEventId":"meeting","existingEventRevision":4,"startAt":"2026-09-08T13:00:00Z"}"#
    var item = try JSONDecoder().decode(RollingDigestItem.self, from: Data(raw.utf8))
    let event = DigestCalendarEvent(id: "meeting", title: "Review", startAt: "2026-09-08T15:00:00+03:00", endAt: "2026-09-08T15:30:00+03:00", reminderAt: "2026-09-08T14:50:00+03:00", revision: 4, links: ["https://example.zoom.us/j/123"], timezone: "Asia/Riyadh")
    let updated = try item.calendarReviewEvent(events: [event], sources: [], timezone: "America/New_York")
    #expect(updated.id == "meeting" && updated.revision == 4)
    #expect(updated.endAt == "2026-09-08T13:30:00Z")
    #expect(updated.reminderAt == "2026-09-08T12:50:00Z")
    #expect(updated.timezone == "Asia/Riyadh" && updated.links == event.links)
    #expect(throws: (any Error).self) { try item.calendarReviewEvent(events: [], sources: [], timezone: "UTC") }
    item.calendarAction = "delete"
    #expect(try item.calendarReviewEvent(events: [event], sources: [], timezone: "UTC") == event)
    #expect(item.calendarReviewLabel(events: [event]) == "Review cancellation")
    let urls = KordiMarkdownParser.externalURLs(in: "[Zoom](https://example.zoom.us/j/123) **https://example.com/agenda** `https://code.example` [Unsafe](javascript:alert(1))")
    #expect(urls.map(\.absoluteString) == ["https://example.zoom.us/j/123", "https://example.com/agenda"])
    for zone in ["America/Los_Angeles", "Asia/Tokyo"] {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try #require(TimeZone(identifier: zone))
        let day = try #require(DigestDate.parse("2026-09-08T12:00:00Z"))
        var allDay = event; allDay.allDay = true; allDay.startAt = "2026-09-08T00:00:00Z"; allDay.endAt = nil
        #expect(DigestDate.event(allDay, occursOn: day, calendar: calendar))
    }
}

final class DigestViewTests: XCTestCase {
    @MainActor
    func testDeviceCalendarImportAcceptsInstantsAndContinuesPastInvalidRanges() async throws {
        let point = DigestCalendarEvent(id: "point", title: "Point event", startAt: "2026-09-06T12:00:00Z", endAt: "2026-09-06T15:00:00+03:00")
        XCTAssertNil(try point.normalizedForSave().endAt)
        var allDay = point; allDay.allDay = true
        XCTAssertNil(try allDay.normalizedForSave().endAt)
        var invalid = point; invalid.id = "invalid"; invalid.endAt = "2026-09-06T11:00:00Z"
        var later = point; later.id = "later"; later.endAt = "2026-09-06T13:00:00Z"
        var saved: [DigestCalendarEvent] = []
        let first = try await importDigestCalendarEvents([point, invalid, later, point], existing: []) { saved.append($0) }
        XCTAssertEqual(first.imported, 2); XCTAssertEqual(first.duplicates, 1); XCTAssertEqual(first.skipped.count, 1)
        XCTAssertEqual(saved.map(\.id), ["point", "later"])
        let retry = try await importDigestCalendarEvents([point, later], existing: saved) { _ in XCTFail("Duplicate was submitted") }
        XCTAssertEqual(retry.imported, 0); XCTAssertEqual(retry.duplicates, 2)
    }
    @MainActor
    func testRemindersRejectAnAccountThatHasSignedOut() async {
        do {
            _ = try await DigestCalendarService.syncReminders(accountId: "signed-out", events: [], isCurrentAccount: { false })
            XCTFail("A signed-out account must not reach the notification center")
        } catch { XCTAssertTrue(error is CancellationError) }
    }
    func testMainDestinationsIncludeAgentsWithoutFactory() {
        XCTAssertEqual(MainTab.contentTabs, [.contacts, .chats, .agents, .digest, .account])
        XCTAssertEqual(MainTab.contentTabs, MainTab.allCases)
        XCTAssertEqual(MainTab.account.symbol, "person")
    }
    func testConversationKindsRouteToTheirDedicatedTabs() {
        XCTAssertEqual(MainTab.destination(for: .agent), .agents)
        XCTAssertEqual(MainTab.destination(for: .person), .chats)
        XCTAssertEqual(MainTab.destination(for: .group), .chats)
    }
    func testMonthGridIncludesAdjacentDatesAndLeapDay() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let september = try XCTUnwrap(DigestDate.parse("2026-09-10T00:00:00Z"))
        let dates = DigestDate.monthDays(containing: september, calendar: calendar)
        XCTAssertEqual(dates.count, 42)
        XCTAssertEqual(DigestDate.key(try XCTUnwrap(dates.first), calendar: calendar), "2026-08-30")
        XCTAssertEqual(DigestDate.key(try XCTUnwrap(dates.last), calendar: calendar), "2026-10-10")
        let february = try XCTUnwrap(DigestDate.parse("2028-02-01T00:00:00Z"))
        XCTAssertTrue(DigestDate.monthDays(containing: february, calendar: calendar).contains { DigestDate.key($0, calendar: calendar) == "2028-02-29" })
    }
    func testAllDayEndIsExclusiveAndTimedEventsCanCrossMidnight() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let day = try XCTUnwrap(DigestDate.parse("2026-09-11T12:00:00Z"))
        let event = DigestCalendarEvent(id: "event", title: "Planning", startAt: "2026-09-10T00:00:00Z", endAt: "2026-09-12T00:00:00Z", allDay: true)
        XCTAssertTrue(DigestDate.event(event, occursOn: day, calendar: calendar))
        XCTAssertFalse(DigestDate.event(event, occursOn: try XCTUnwrap(DigestDate.parse("2026-09-12T12:00:00Z")), calendar: calendar))
        let singleDay = DigestCalendarEvent(id: "single", title: "Holiday", startAt: "2026-09-11T00:00:00Z", allDay: true)
        XCTAssertTrue(DigestDate.event(singleDay, occursOn: day, calendar: calendar))
        XCTAssertFalse(DigestDate.event(singleDay, occursOn: try XCTUnwrap(DigestDate.parse("2026-09-12T12:00:00Z")), calendar: calendar))
        let overnight = DigestCalendarEvent(id: "night", title: "Handoff", startAt: "2026-09-10T23:30:00Z", endAt: "2026-09-11T00:30:00Z")
        XCTAssertTrue(DigestDate.event(overnight, occursOn: day, calendar: calendar))
    }
    func testRollingContractKeepsUnknownOwnershipAndExactSources() throws {
        let json = #"{"accountId":"viewer","snapshot":{"claims":[],"commitments":[{"id":"followup","title":"Review draft","text":"No owner agreed","kind":"possible","sourceIds":["message"]}],"suggestions":[],"calendarCandidates":[]},"sources":[{"id":"message","conversationId":"conversation","sessionId":"session","sessionTitle":"Planning","senderAccountId":"author","senderName":"Alex","text":"Could someone review this?","createdAt":"2026-09-07T09:00:00Z","version":1}],"partial":false,"revision":1,"updatedAt":"2026-09-07T09:01:00Z","status":"ready","feedback":[]}"#
        let response = try JSONDecoder().decode(RollingDigestResponse.self, from: Data(json.utf8))
        let task = try XCTUnwrap(response.snapshot?.commitments.first)
        XCTAssertNil(task.ownerAccountId); XCTAssertNil(task.dueAt)
        XCTAssertEqual(task.sourceIds, ["message"])
        XCTAssertEqual(response.sources.first?.text, "Could someone review this?")
    }
    func testPendingCalendarMentionsUseLocalDatesAndDisappearAfterConfirmation() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 3 * 3600))
        let json = #"[{"id":"review","title":"Design review","text":"","kind":"possible","sourceIds":["message"],"startAt":"2026-09-06T22:00:00Z"},{"id":"unknown","title":"Office hours","text":"","kind":"possible","sourceIds":["message"]}]"#
        let candidates = try JSONDecoder().decode([RollingDigestItem].self, from: Data(json.utf8))
        let day = try XCTUnwrap(DigestDate.parse("2026-09-07T09:00:00+03:00"))
        XCTAssertEqual(DigestDate.pendingCandidates(candidates, events: [], on: day, calendar: calendar).map(\.id), ["review"])
        let confirmed = DigestCalendarEvent(id: "digest-review", title: "Design review", startAt: "2026-09-06T22:00:00Z")
        XCTAssertTrue(DigestDate.pendingCandidates(candidates, events: [confirmed], on: day, calendar: calendar).isEmpty)
        XCTAssertTrue(DigestDate.event(confirmed, occursOn: day, calendar: calendar))
    }
    func testICSImportExpandsRecurrenceWithoutActivatingAlarms() throws {
        let text = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:review\nDTSTAMP:20260901T000000Z\nDTSTART:20260909T120000Z\nDTEND:20260909T123000Z\nRRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20260916T120000Z\nSUMMARY:Review\nEND:VEVENT\nEND:VCALENDAR"
        let first = try DigestICSImporter.parse(text, from: "2026-09-01", to: "2026-10-01")
        let second = try DigestICSImporter.parse(text, from: "2026-09-01", to: "2026-10-01")
        XCTAssertEqual(first.events.count, 2)
        XCTAssertEqual(first.events.map(\.id), second.events.map(\.id))
        XCTAssertTrue(first.events.allSatisfy { $0.reminderAt == nil })
    }
}

@MainActor
@Test(arguments: [false, true])
func digestDismissalKeepsBriefAndSuggestionRestorationSeparate(hideSuggestion: Bool) throws {
    let suggestionFeedback = hideSuggestion ? #",{"id":"suggestion","status":"dismissed"}"# : ""
    let json = """
    {"accountId":"viewer","snapshot":{
      "claims":[{"id":"brief","title":"Hidden brief","text":"","kind":"progress","sourceIds":[]},
        {"id":"visible","title":"Visible brief","text":"","kind":"progress","sourceIds":[]}],
      "commitments":[],"calendarCandidates":[],
      "suggestions":[{"id":"suggestion","title":"Suggestion","text":"","kind":"possible","sourceIds":[]},
        {"id":"task","title":"Converted task","text":"","kind":"possible","sourceIds":[]}]},
      "sources":[],"partial":true,"revision":1,"updatedAt":"2026-09-07T09:00:00Z","status":"ready",
      "feedback":[{"id":"brief","status":"dismissed"},{"id":"old-item","status":"dismissed"},
        {"id":"task","status":"task"}\(suggestionFeedback)]}
    """
    let response = try JSONDecoder().decode(RollingDigestResponse.self, from: Data(json.utf8))
    #expect(response.visibleClaims.map(\.id) == ["visible"])
    #expect(response.dismissedSuggestions.map(\.id) == (hideSuggestion ? ["suggestion"] : []))
    #expect(response.visibleSuggestions.map(\.id) == (hideSuggestion ? ["task"] : ["suggestion", "task"]))
    #expect(response.snapshot?.claims.count == 2)
    #expect(response.partial)
}
