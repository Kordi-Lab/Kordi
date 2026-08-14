/*
 THESIS: Contacts, conversations, and a concise activity digest are the three mobile destinations; account settings stay one tap away without competing with page actions.
 OWN-WORLD: Native grouped canvases, Signal Blue actions, Agent Violet identity, circular avatars, continuous list rows, and explicit state labels.
 STORY: Sign in, switch among Contacts, Chats, and Digest, open the right conversation, and reach account settings from the persistent bottom-right avatar.
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
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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
        completionHandler([.banner, .sound])
    }
}

@main
struct KordiApp: App {
    @UIApplicationDelegateAdaptor(KordiAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @StateObject private var callCoordinator = KordiCallCoordinator()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(callCoordinator)
                .tint(KordiTheme.signalBlue)
                .preferredColorScheme(preferredColorScheme)
                .fullScreenCover(isPresented: $callCoordinator.isCallScreenPresented) {
                    KordiCallView(room: callCoordinator.room)
                        .environmentObject(callCoordinator)
                }
                .task {
                    callCoordinator.configure(model: model)
                    await model.start()
                    callCoordinator.configure(model: model)
                    callCoordinator.receive(callSnapshots: Array(model.callsByConversationID.values))
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: .kordiDidRegisterForRemoteNotifications)
                ) { notification in
                    guard let token = notification.object as? String else { return }
                    Task { await model.registerNotificationPushToken(token) }
                }
                .onReceive(model.$callsByConversationID) { calls in
                    callCoordinator.receive(callSnapshots: Array(calls.values))
                }
                .onReceive(model.$account) { account in
                    guard account != nil else { return }
                    callCoordinator.configure(model: model)
                }
                .onChange(of: scenePhase) {
                    switch scenePhase {
                    case .active:
                        callCoordinator.showCallScreen()
                        Task { await model.appDidBecomeActive() }
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
            || ProcessInfo.processInfo.arguments.contains("--preview-agent-model")
            || ProcessInfo.processInfo.arguments.contains("--preview-contact-model")
            || ProcessInfo.processInfo.arguments.contains("--preview-contact-chat")
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
        VStack(spacing: 14) {
            KordiMark(size: 58)
            ProgressView("Connecting to Kordi")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection: MainTab = {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-digest-tab") {
            return .digest
        } else if ProcessInfo.processInfo.arguments.contains("--preview-contacts-tab") {
            return .contacts
        }
#endif
        return .chats
    }()
    @State private var chatsPath = NavigationPath()
    @State private var contactsPath = NavigationPath()
    @State private var digestPath = NavigationPath()
    @State private var showAccount = false
    @State private var accountTabImage: UIImage?

    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                modernTabView
            } else {
                legacyTabView
            }
        }
        .sheet(isPresented: $showAccount) {
            AccountSheet()
        }
        .task(id: accountTabImageIdentity) {
            await refreshAccountTabImage()
        }
        .sensoryFeedback(.selection, trigger: selection)
#if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--preview-digest-tab") {
                selection = .digest
            } else if ProcessInfo.processInfo.arguments.contains("--preview-contacts-tab") {
                selection = .contacts
            } else if ProcessInfo.processInfo.arguments.contains("--preview-chats-tab") {
                selection = .chats
            }
        }
#endif
    }

    @available(iOS 18.0, *)
    private var modernTabView: some View {
        TabView(selection: tabSelection) {
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

            Tab(value: MainTab.digest) {
                digestRoot
            } label: {
                Label(MainTab.digest.rawValue, systemImage: MainTab.digest.symbol)
            }

            Tab(value: MainTab.account) {
                Color.clear
            } label: {
                accountTabLabel
            }
        }
    }

    private var legacyTabView: some View {
        TabView(selection: tabSelection) {
            contactsRoot
                .tabItem { Label(MainTab.contacts.rawValue, systemImage: MainTab.contacts.symbol) }
                .badge(pendingIncomingRequestCount)
                .tag(MainTab.contacts)

            chatsRoot
                .tabItem { Label(MainTab.chats.rawValue, systemImage: MainTab.chats.symbol) }
                .tag(MainTab.chats)

            digestRoot
                .tabItem { Label(MainTab.digest.rawValue, systemImage: MainTab.digest.symbol) }
                .tag(MainTab.digest)

            Color.clear
                .tabItem { accountTabLabel }
                .tag(MainTab.account)
        }
    }

    private var tabSelection: Binding<MainTab> {
        Binding(
            get: { selection },
            set: { requestedTab in
                let resolution = MainTabSelectionPolicy.resolve(
                    current: selection,
                    requested: requestedTab
                )
                selection = resolution.selectedTab
                showAccount = resolution.presentsAccount
            }
        )
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
                onOpenConversation: { chatsPath.append($0) }
            )
        }
        .kordiTabBarVisibility(isRoot: chatsPath.isEmpty)
    }

    private var digestRoot: some View {
        NavigationStack(path: $digestPath) {
            DigestView()
        }
        .kordiTabBarVisibility(isRoot: digestPath.isEmpty)
    }

    private var accountTabLabel: some View {
        Image(uiImage: accountTabImage ?? AccountTabAvatarRenderer.image(
            name: model.account?.preferredName ?? "Me",
            sourceImage: nil
        ))
        .renderingMode(.original)
        .accessibilityLabel("Account settings")
    }

    private var accountTabImageIdentity: String {
        [
            model.account?.accountId ?? "",
            model.account?.preferredName ?? "Me",
            model.account?.avatarUrl ?? "",
        ].joined(separator: "|")
    }

    private func refreshAccountTabImage() async {
        let sourceImage: UIImage?
        if let source = AvatarImageLoader.normalizedSource(model.account?.avatarUrl) {
            sourceImage = await AvatarImageLoader.image(from: source)
        } else {
            sourceImage = nil
        }
        guard !Task.isCancelled else { return }
        accountTabImage = AccountTabAvatarRenderer.image(
            name: model.account?.preferredName ?? "Me",
            sourceImage: sourceImage
        )
    }

    private var pendingIncomingRequestCount: Int {
        model.contactRequests.lazy.filter { $0.isIncoming && $0.status == "pending" }.count
    }
}

private enum AccountTabAvatarRenderer {
    private static let size = CGSize(width: 28, height: 28)

    static func image(name: String, sourceImage: UIImage?) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 2
        let renderer = UIGraphicsImageRenderer(size: size, format: format)

        return renderer.image { rendererContext in
            let context = rendererContext.cgContext
            let bounds = CGRect(origin: .zero, size: size)
            context.addEllipse(in: bounds)
            context.clip()

            if let sourceImage {
                sourceImage.draw(in: aspectFillRect(for: sourceImage.size, inside: bounds))
            } else {
                let palette = CloudAvatarFallback.palette(for: name)
                UIColor(palette.background).setFill()
                context.fill(bounds)

                let initials = CloudAvatarFallback.initials(for: name)
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
                    .foregroundColor: UIColor(palette.foreground),
                ]
                let textSize = initials.size(withAttributes: attributes)
                initials.draw(
                    at: CGPoint(
                        x: (bounds.width - textSize.width) / 2,
                        y: (bounds.height - textSize.height) / 2
                    ),
                    withAttributes: attributes
                )
            }

            context.resetClip()
            context.setStrokeColor(UIColor.separator.withAlphaComponent(0.22).cgColor)
            context.setLineWidth(1)
            context.strokeEllipse(in: bounds.insetBy(dx: 0.5, dy: 0.5))
        }
        .withRenderingMode(.alwaysOriginal)
    }

    private static func aspectFillRect(for imageSize: CGSize, inside bounds: CGRect) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0 else { return bounds }
        let scale = max(bounds.width / imageSize.width, bounds.height / imageSize.height)
        let scaledSize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(
            x: bounds.midX - scaledSize.width / 2,
            y: bounds.midY - scaledSize.height / 2,
            width: scaledSize.width,
            height: scaledSize.height
        )
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
    case digest = "Digest"
    case account = "Account"

    static let contentTabs: [MainTab] = [.contacts, .chats, .digest]

    var id: Self { self }

    var symbol: String {
        switch self {
        case .contacts:
            "person.2"
        case .chats:
            "bubble.left.and.bubble.right"
        case .digest:
            "list.bullet.clipboard"
        case .account:
            "person.crop.circle"
        }
    }
}

struct MainTabSelectionResolution: Equatable {
    let selectedTab: MainTab
    let presentsAccount: Bool
}

enum MainTabSelectionPolicy {
    static func resolve(
        current: MainTab,
        requested: MainTab
    ) -> MainTabSelectionResolution {
        guard requested == .account else {
            return MainTabSelectionResolution(
                selectedTab: requested,
                presentsAccount: false
            )
        }
        return MainTabSelectionResolution(
            selectedTab: current,
            presentsAccount: true
        )
    }
}

#Preview("App · Mobile destinations") {
    MainTabView()
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}
