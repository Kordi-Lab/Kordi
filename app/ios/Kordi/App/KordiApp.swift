/*
 THESIS: Contacts, human chats, agent sessions, and a concise activity digest are first-class mobile destinations; account settings stay one tap away without competing with page actions.
 OWN-WORLD: Native grouped canvases, Signal Blue actions, Agent Violet identity, circular avatars, continuous list rows, and explicit state labels.
 STORY: Sign in, switch among Contacts, Chats, Agents, and Digest, open the right conversation, and reach account settings from the persistent bottom-right avatar.
 FIRST VIEWPORT: Each root page sits above one stable destination bar whose account avatar occupies the final position.
 FORM: Native navigation stacks with a compact destination bar and continuous lists; assigned surface structure, seed a5fd657b.
 */
import SwiftUI
import UIKit
import UserNotifications

extension Notification.Name {
    static let kordiDidRegisterForRemoteNotifications = Notification.Name(
        "KordiDidRegisterForRemoteNotifications"
    )
}

final class KordiAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor weak var notificationCoordinator: KordiNotificationCoordinator?
    private var coldLaunchNotificationPayload: [AnyHashable: Any]?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        coldLaunchNotificationPayload = launchOptions?[.remoteNotification] as? [AnyHashable: Any]
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(
            name: .kordiDidRegisterForRemoteNotifications,
            object: token
        )
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor [weak self] in
            let options = self?.notificationCoordinator?.presentationOptions(for: notification)
                ?? [.banner, .sound, .badge]
            completionHandler(options)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor [weak self] in
            self?.notificationCoordinator?.handleNotificationResponse(response.notification)
            completionHandler()
        }
    }

    @MainActor
    func attachNotificationCoordinator(_ coordinator: KordiNotificationCoordinator) {
        notificationCoordinator = coordinator
        if let coldLaunchNotificationPayload {
            self.coldLaunchNotificationPayload = nil
            coordinator.handleColdLaunchPayload(coldLaunchNotificationPayload)
        }
    }
}

@main
struct KordiApp: App {
    @UIApplicationDelegateAdaptor(KordiAppDelegate.self) private var appDelegate
    @StateObject private var model: AppModel
    @StateObject private var callCoordinator: KordiCallCoordinator
    @StateObject private var notificationCoordinator: KordiNotificationCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @AppStorage(KordiChatTheme.storageKey) private var chatThemeRawValue = KordiChatTheme.quiet.rawValue

    init() {
        let model = AppModel()
        let callCoordinator = KordiCallCoordinator()
        let notificationCoordinator = KordiNotificationCoordinator()
        callCoordinator.configure(model: model)
        notificationCoordinator.configure(model: model)
        _model = StateObject(wrappedValue: model)
        _callCoordinator = StateObject(wrappedValue: callCoordinator)
        _notificationCoordinator = StateObject(wrappedValue: notificationCoordinator)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(callCoordinator)
                .environmentObject(notificationCoordinator)
                .environment(\.kordiChatTheme, selectedChatTheme)
                .tint(KordiTheme.signalBlue)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if showsPreviewThemeControls {
                        PreviewThemeControls(
                            appearanceRawValue: $appearanceRawValue,
                            chatThemeRawValue: $chatThemeRawValue
                        )
                    }
                }
                .preferredColorScheme(preferredColorScheme)
                .fullScreenCover(isPresented: $callCoordinator.isCallScreenPresented) {
                    KordiCallView(room: callCoordinator.room)
                        .environmentObject(callCoordinator)
                }
                .task {
                    appDelegate.attachNotificationCoordinator(notificationCoordinator)
                    callCoordinator.configure(model: model)
                    notificationCoordinator.configure(model: model)
                    await model.start()
                    callCoordinator.configure(model: model)
                    notificationCoordinator.accountDidChange()
                    notificationCoordinator.synchronizeBadge()
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: .kordiDidRegisterForRemoteNotifications)
                ) { notification in
                    guard let token = notification.object as? String else { return }
                    notificationCoordinator.registerPushToken(token)
                }
                .onReceive(model.$callsByConversationID) { calls in
                    callCoordinator.receive(callSnapshots: Array(calls.values))
                }
                .onReceive(model.$latestCallSnapshot.compactMap { $0 }.filter { $0.state == .ended }) { call in
                    callCoordinator.receive(callSnapshots: [call])
                }
                .onReceive(model.$account) { account in
                    if account != nil {
                        callCoordinator.configure(model: model)
                    }
                    notificationCoordinator.accountDidChange()
                }
                .onReceive(model.$conversations) { _ in
                    notificationCoordinator.synchronizeBadge()
                    notificationCoordinator.retryPendingRoute()
                }
                .onChange(of: scenePhase) {
                    switch scenePhase {
                    case .active:
                        callCoordinator.showCallScreen()
                        Task { await model.appDidBecomeActive() }
                        Task {
                            await notificationCoordinator.refreshAuthorizationState(
                                registerIfAllowed: true
                            )
                        }
                        notificationCoordinator.synchronizeBadge()
                    case .background:
                        model.appDidEnterBackground()
                    case .inactive:
                        break
                    @unknown default:
                        break
                    }
                }
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch AppAppearance(rawValue: appearanceRawValue) ?? .system {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    private var selectedChatTheme: KordiChatTheme {
        KordiChatTheme(rawValue: chatThemeRawValue) ?? .quiet
    }

    private var showsPreviewThemeControls: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("--preview-theme-controls")
#else
        false
#endif
    }
}

private struct PreviewThemeControls: View {
    @Binding var appearanceRawValue: String
    @Binding var chatThemeRawValue: String

    var body: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(AppAppearance.allCases) { appearance in
                    Button {
                        appearanceRawValue = appearance.rawValue
                    } label: {
                        Label(appearance.label, systemImage: appearance.systemImage)
                    }
                }
            } label: {
                Label(selectedAppearance.label, systemImage: selectedAppearance.systemImage)
            }
            Menu {
                ForEach(KordiChatTheme.allCases) { theme in
                    Button(theme.label) {
                        chatThemeRawValue = theme.rawValue
                    }
                }
            } label: {
                Label(selectedChatTheme.label, systemImage: selectedChatTheme.systemImage)
            }
        }
        .font(.caption.weight(.semibold))
        .buttonStyle(.bordered)
        .controlSize(.small)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
        .accessibilityElement(children: .contain)
    }

    private var selectedAppearance: AppAppearance {
        AppAppearance(rawValue: appearanceRawValue) ?? .system
    }

    private var selectedChatTheme: KordiChatTheme {
        KordiChatTheme(rawValue: chatThemeRawValue) ?? .quiet
    }
}

private struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator

    @ViewBuilder
    var body: some View {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-contacts") {
            NavigationStack {
                ContactsView()
            }
        } else if ProcessInfo.processInfo.arguments.contains("--preview-appearance") {
            AppearanceSettingsPreview()
        } else if ProcessInfo.processInfo.arguments.contains("--preview-profile") {
            ProfileSettingsPreview()
        } else if ProcessInfo.processInfo.arguments.contains("--preview-devices") {
            ActiveSessionsPreview()
        } else if ProcessInfo.processInfo.arguments.contains("--preview-account") {
            AccountSheet()
        } else if ProcessInfo.processInfo.arguments.contains("--preview-authentication") {
            AccountAuthenticationPreview()
        } else if ProcessInfo.processInfo.arguments.contains("--preview-authentication-detail") {
            AccountAuthenticationDetailPreview(providerID: "openai")
        } else if (ProcessInfo.processInfo.arguments.contains("--preview-markdown")
            || ProcessInfo.processInfo.arguments.contains("--preview-tool-failure")
            || ProcessInfo.processInfo.arguments.contains("--preview-agent-model")
            || ProcessInfo.processInfo.arguments.contains("--preview-contact-model")
            || ProcessInfo.processInfo.arguments.contains("--preview-contact-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-bubble-width")
            || ProcessInfo.processInfo.arguments.contains("--preview-call-activity")
            || ProcessInfo.processInfo.arguments.contains("--preview-direct-call")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-call")
            || ProcessInfo.processInfo.arguments.contains("--preview-media")
            || ProcessInfo.processInfo.arguments.contains("--preview-media-messages")
            || ProcessInfo.processInfo.arguments.contains("--preview-media-expanded")
            || ProcessInfo.processInfo.arguments.contains("--preview-media-separated")
            || ProcessInfo.processInfo.arguments.contains("--preview-photo-send")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-detail")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-invite")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-release-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-companion-panel")
            || ProcessInfo.processInfo.arguments.contains("--preview-companion-return")),
           let conversation = model.conversations.first(where: {
               if ProcessInfo.processInfo.arguments.contains("--preview-group-release-chat") {
                   return $0.id == "group:mobile-release"
               }
               if ProcessInfo.processInfo.arguments.contains("--preview-group-chat")
                    || ProcessInfo.processInfo.arguments.contains("--preview-group-detail")
                    || ProcessInfo.processInfo.arguments.contains("--preview-group-invite")
                    || ProcessInfo.processInfo.arguments.contains("--preview-group-call") {
                   return $0.id == "group:mobile"
               }
               if ProcessInfo.processInfo.arguments.contains("--preview-contact-model")
                    || ProcessInfo.processInfo.arguments.contains("--preview-contact-chat")
                    || ProcessInfo.processInfo.arguments.contains("--preview-bubble-width")
                    || ProcessInfo.processInfo.arguments.contains("--preview-call-activity")
                    || ProcessInfo.processInfo.arguments.contains("--preview-direct-call")
                    || ProcessInfo.processInfo.arguments.contains("--preview-media")
                    || ProcessInfo.processInfo.arguments.contains("--preview-media-messages")
                    || ProcessInfo.processInfo.arguments.contains("--preview-media-expanded")
                    || ProcessInfo.processInfo.arguments.contains("--preview-media-separated")
                    || ProcessInfo.processInfo.arguments.contains("--preview-photo-send")
                    || ProcessInfo.processInfo.arguments.contains("--preview-companion-panel")
                    || ProcessInfo.processInfo.arguments.contains("--preview-companion-return") {
                   return $0.id == "person:acct_maya"
               }
               return $0.id == (ProcessInfo.processInfo.arguments.contains("--preview-agent-model")
                   ? "agent:research"
                   : "agent:my-kordi")
           }) {
            NavigationStack {
                if ProcessInfo.processInfo.arguments.contains("--preview-group-detail") {
                    SessionDetailView(conversation: conversation)
                } else if ProcessInfo.processInfo.arguments.contains("--preview-group-invite"),
                          let space = GroupSpaceCatalog.build(
                              conversations: model.conversations,
                              ownAccountId: model.account?.accountId ?? ""
                          ).first(where: { $0.sessions.contains(where: { $0.id == conversation.id }) }) {
                    GroupInvitePreviewHost(conversation: conversation, space: space)
                } else {
                    ConversationView(conversation: conversation)
                }
            }
            .task {
                if ProcessInfo.processInfo.arguments.contains("--preview-direct-call") {
                    callCoordinator.configure(model: model)
                    await callCoordinator.start(conversation: conversation, kind: .voice)
                } else if ProcessInfo.processInfo.arguments.contains("--preview-group-call") {
                    callCoordinator.configure(model: model)
                    await callCoordinator.start(conversation: conversation, kind: .video)
                }
            }
        } else {
            appPhase
        }
#else
        appPhase
#endif
    }

    @ViewBuilder
    private var appPhase: some View {
        switch model.phase {
        case .launching:
            LaunchingView()
        case .signedOut:
            LoginView()
        case .signedIn:
            MainTabView()
        }
    }
}

#if DEBUG
private struct GroupInvitePreviewHost: View {
    let conversation: ConversationSummary
    let space: GroupSpaceSummary
    @State private var showsInviteSheet = false

    var body: some View {
        SessionDetailView(conversation: conversation)
            .sheet(isPresented: $showsInviteSheet) {
                GroupMemberInviteSheet(space: space)
            }
            .task {
                await Task.yield()
                showsInviteSheet = true
            }
    }
}
#endif

private struct LaunchingView: View {
    var body: some View {
        ZStack {
            KordiMark(size: 58, colorRelay: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connecting to Kordi")
    }
}

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var notificationCoordinator: KordiNotificationCoordinator
    @State private var selection: MainTab = {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-digest-tab") {
            return .digest
        } else if ProcessInfo.processInfo.arguments.contains("--preview-contacts-tab") {
            return .contacts
        } else if ProcessInfo.processInfo.arguments.contains("--preview-agent-page") {
            return .agents
        }
#endif
        return .chats
    }()
    @State private var chatsPath = NavigationPath()
    @State private var agentsPath = NavigationPath()
    @State private var contactsPath = NavigationPath()
    @State private var digestPath = NavigationPath()
    @State private var accountPath = NavigationPath()

    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                modernTabView
            } else {
                legacyTabView
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
        .task(id: notificationCoordinator.pendingMessageRoute) {
            guard let route = notificationCoordinator.pendingMessageRoute else { return }
            let destination = MainTab.destination(for: route.conversation.kind)
            selection = destination
            if destination == .agents {
                agentsPath = NavigationPath()
                agentsPath.append(route)
            } else {
                chatsPath = NavigationPath()
                chatsPath.append(route)
            }
            notificationCoordinator.consumePendingRoute()
        }
#if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--preview-digest-tab") {
                selection = .digest
            } else if ProcessInfo.processInfo.arguments.contains("--preview-contacts-tab") {
                selection = .contacts
            } else if ProcessInfo.processInfo.arguments.contains("--preview-agent-page") {
                selection = .agents
            } else if ProcessInfo.processInfo.arguments.contains("--preview-chats-tab") {
                selection = .chats
            }
        }
#endif
    }

    @available(iOS 18.0, *)
    private var modernTabView: some View {
        TabView(selection: $selection) {
            Tab(value: MainTab.contacts) {
                contactsRoot
            } label: {
                Label(MainTab.contacts.rawValue, systemImage: MainTab.contacts.symbol)
            }
            .badge(pendingIncomingRequestCount)

            Tab(value: MainTab.chats) {
                chatsRoot
            } label: {
                Label(MainTab.chats.rawValue, systemImage: MainTab.chats.symbol)
            }
            .badge(unreadTabCounts.chats)

            Tab(value: MainTab.agents) {
                agentsRoot
            } label: {
                Label(MainTab.agents.rawValue, systemImage: MainTab.agents.symbol)
            }
            .badge(unreadTabCounts.agents)

            Tab(value: MainTab.digest) {
                digestRoot
            } label: {
                Label(MainTab.digest.rawValue, systemImage: MainTab.digest.symbol)
            }

            Tab(value: MainTab.account) {
                accountRoot
            } label: {
                accountTabLabel
            }
        }
    }

    private var legacyTabView: some View {
        TabView(selection: $selection) {
            contactsRoot
                .tabItem { Label(MainTab.contacts.rawValue, systemImage: MainTab.contacts.symbol) }
                .badge(pendingIncomingRequestCount)
                .tag(MainTab.contacts)

            chatsRoot
                .tabItem { Label(MainTab.chats.rawValue, systemImage: MainTab.chats.symbol) }
                .badge(unreadTabCounts.chats)
                .tag(MainTab.chats)

            agentsRoot
                .tabItem { Label(MainTab.agents.rawValue, systemImage: MainTab.agents.symbol) }
                .badge(unreadTabCounts.agents)
                .tag(MainTab.agents)

            digestRoot
                .tabItem { Label(MainTab.digest.rawValue, systemImage: MainTab.digest.symbol) }
                .tag(MainTab.digest)

            accountRoot
                .tabItem { accountTabLabel }
                .tag(MainTab.account)
        }
    }

    private var contactsRoot: some View {
        NavigationStack(path: $contactsPath) {
            ContactsView()
        }
        .kordiTabBarVisibility(isRoot: contactsPath.isEmpty)
    }

    private var chatsRoot: some View {
        NavigationStack(path: $chatsPath) {
            ChatHomeView(
                channel: .contact,
                onOpenConversation: { chatsPath.append($0) },
                onOpenNewChat: { chatsPath.append($0) }
            )
        }
        .kordiTabBarVisibility(isRoot: chatsPath.isEmpty)
    }

    private var agentsRoot: some View {
        NavigationStack(path: $agentsPath) {
            ChatHomeView(
                channel: .agent,
                onOpenConversation: { agentsPath.append($0) },
                onOpenNewChat: { agentsPath.append($0) }
            )
        }
        .kordiTabBarVisibility(isRoot: agentsPath.isEmpty)
    }

    private var digestRoot: some View {
        NavigationStack(path: $digestPath) {
            DigestView()
        }
        .kordiTabBarVisibility(isRoot: digestPath.isEmpty)
    }

    private var accountRoot: some View {
        NavigationStack(path: $accountPath) {
            AccountSheet(embeddedInNavigationStack: true)
        }
        .kordiTabBarVisibility(isRoot: accountPath.isEmpty)
    }

    private var accountTabLabel: some View {
        Label(MainTab.account.rawValue, systemImage: MainTab.account.symbol)
    }

    private var pendingIncomingRequestCount: Int {
        model.contactRequests.lazy.filter { $0.isIncoming && $0.status == "pending" }.count
    }

    private var unreadTabCounts: MainTabUnreadCounts {
        MainTabUnreadCounts.build(conversations: model.conversations)
    }
}

struct MainTabUnreadCounts: Equatable {
    let chats: Int
    let agents: Int

    static func build(conversations: [ConversationSummary]) -> MainTabUnreadCounts {
        let people = conversations.lazy.filter {
            $0.kind == .person && $0.unreadCount > 0
        }.count
        let groups = Set(conversations.lazy.filter {
            $0.kind == .group
                && $0.forkedFromSessionId == nil
                && $0.unreadCount > 0
        }.map { $0.groupSpaceId?.nonEmpty ?? $0.sessionId }).count
        let agents = conversations.lazy.filter {
            $0.kind == .agent && !$0.isAgentLaunchTemplate && $0.unreadCount > 0
        }.count
        return MainTabUnreadCounts(chats: people + groups, agents: agents)
    }
}

private extension View {
    @ViewBuilder
    func kordiTabBarVisibility(isRoot: Bool) -> some View {
        if #available(iOS 18.0, *) {
            toolbarVisibility(isRoot ? .visible : .hidden, for: .tabBar)
        } else {
            toolbar(isRoot ? .visible : .hidden, for: .tabBar)
        }
    }
}

enum MainTab: String, CaseIterable, Identifiable {
    case contacts = "Contacts"
    case chats = "Chats"
    case agents = "Agents"
    case digest = "Digest"
    case account = "Account"

    static let contentTabs: [MainTab] = [.contacts, .chats, .agents, .digest, .account]

    var id: Self { self }

    var symbol: String {
        switch self {
        case .contacts:
            "person.2"
        case .chats:
            "bubble.left.and.bubble.right"
        case .agents:
            "sparkles"
        case .digest:
            "list.bullet.clipboard"
        case .account:
            "person"
        }
    }

    static func destination(for conversationKind: ConversationKind) -> MainTab {
        conversationKind == .agent ? .agents : .chats
    }
}

#Preview("App · Mobile destinations") {
    MainTabView()
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}
