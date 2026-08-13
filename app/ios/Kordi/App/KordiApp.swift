/*
 THESIS: Contact chats, the people directory, and agent work become three compact iPhone destinations without losing ownership or routing context.
 OWN-WORLD: Native grouped canvases, Signal Blue actions, Agent Violet identity, circular avatars, continuous list rows, and explicit state labels.
 STORY: Sign in, switch among Chats, Contacts, and Factory, open the right conversation, send text, and understand delivery or execution state.
 FIRST VIEWPORT: Search and a continuous chat timeline sit above a compact floating destination bar; agent sessions remain available from Factory.
 FORM: Native navigation stacks with a compact floating destination bar and continuous lists; assigned surface structure, seed a5fd657b. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
 */
import SwiftUI

@main
struct KordiApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(KordiTheme.signalBlue)
                .preferredColorScheme(preferredColorScheme)
                .task { await model.start() }
                .onChange(of: scenePhase) {
                    switch scenePhase {
                    case .active:
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
            || ProcessInfo.processInfo.arguments.contains("--preview-group-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-release-chat")),
           let conversation = model.conversations.first(where: {
               if ProcessInfo.processInfo.arguments.contains("--preview-group-release-chat") {
                   return $0.id == "group:mobile-release"
               }
               if ProcessInfo.processInfo.arguments.contains("--preview-group-chat") {
                   return $0.id == "group:mobile"
               }
               if ProcessInfo.processInfo.arguments.contains("--preview-contact-model")
                    || ProcessInfo.processInfo.arguments.contains("--preview-contact-chat") {
                   return $0.id == "person:acct_maya"
               }
               return $0.id == (ProcessInfo.processInfo.arguments.contains("--preview-agent-model")
                   ? "agent:research"
                   : "agent:my-kordi")
           }) {
            NavigationStack {
                ConversationView(conversation: conversation)
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
        if ProcessInfo.processInfo.arguments.contains("--preview-factory-tab") {
            return .factory
        } else if ProcessInfo.processInfo.arguments.contains("--preview-contacts-tab") {
            return .contacts
        }
#endif
        return .chats
    }()
    @State private var chatsPath = NavigationPath()
    @State private var contactsPath = NavigationPath()
    @State private var factoryPath = NavigationPath()

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack(path: $chatsPath) {
                ChatHomeView(
                    onOpenConversation: { chatsPath.append($0) }
                )
            }
            .kordiTabBarVisibility(isRoot: chatsPath.isEmpty)
            .tabItem { Label(MainTab.chats.rawValue, systemImage: MainTab.chats.symbol) }
            .tag(MainTab.chats)

            NavigationStack(path: $contactsPath) {
                ContactsView()
            }
            .kordiTabBarVisibility(isRoot: contactsPath.isEmpty)
            .tabItem { Label(MainTab.contacts.rawValue, systemImage: MainTab.contacts.symbol) }
            .badge(pendingIncomingRequestCount)
            .tag(MainTab.contacts)

            NavigationStack(path: $factoryPath) {
                FactoryView()
            }
            .kordiTabBarVisibility(isRoot: factoryPath.isEmpty)
            .tabItem { Label(MainTab.factory.rawValue, systemImage: MainTab.factory.symbol) }
            .tag(MainTab.factory)
        }
        .sensoryFeedback(.selection, trigger: selection)
#if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--preview-factory-tab") {
                selection = .factory
            } else if ProcessInfo.processInfo.arguments.contains("--preview-contacts-tab") {
                selection = .contacts
            } else if ProcessInfo.processInfo.arguments.contains("--preview-chats-tab") {
                selection = .chats
            }
        }
#endif
    }

    private var pendingIncomingRequestCount: Int {
        model.contactRequests.lazy.filter { $0.isIncoming && $0.status == "pending" }.count
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

private enum MainTab: String, CaseIterable, Identifiable {
    case chats = "Chats"
    case contacts = "Contacts"
    case factory = "Factory"

    var id: Self { self }

    var symbol: String {
        switch self {
        case .chats:
            "bubble.left.and.bubble.right"
        case .contacts:
            "person.2"
        case .factory:
            "sparkles.rectangle.stack"
        }
    }
}

#Preview("App · Contact and Agent pages") {
    MainTabView()
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}
