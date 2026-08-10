/*
 THESIS: The macOS Contact/Agent chat model becomes two native iPhone pages without losing ownership or routing context.
 OWN-WORLD: Native grouped canvases, Signal Blue actions, Agent Violet identity, circular avatars, continuous list rows, and explicit state labels.
 STORY: Sign in, switch between Contact and Agent chats, open the right conversation, send text, and understand delivery or execution state.
 FIRST VIEWPORT: Native large Chats title, search, and the desktop-mirroring Contact/Agent segmented pager; shared agents remain nested under their owner contact.
 FORM: Native segmented pages with continuous lists; assigned surface structure, seed a5fd657b. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
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
            || ProcessInfo.processInfo.arguments.contains("--preview-group-chat")),
           let conversation = model.conversations.first(where: {
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
    var body: some View {
        TabView {
            NavigationStack {
                ChatHomeView()
            }
            .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }

            NavigationStack {
                ContactsView()
            }
            .tabItem { Label("Contacts", systemImage: "person.2") }
        }
    }
}

#Preview("App · Contact and Agent pages") {
    MainTabView()
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}
