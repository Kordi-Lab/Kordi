import SwiftUI

enum MainNavigationRoute: Hashable {
    case conversation(ConversationSummary)
    case message(KordiMessageNotificationRoute)
    case sessionDetails(ConversationSummary)
    case newChat(NewChatMode)
    case archived(ChatChannel)
}

struct MainNavigationDestination: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.kordiChatTheme) private var chatTheme
    @Binding var path: [MainNavigationRoute]
    let route: MainNavigationRoute
    let selectedTab: MainTab

    var body: some View {
        NavigationStack {
            screen
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", systemImage: "chevron.left") {
                            if !path.isEmpty { path.removeLast() }
                        }
                        .labelStyle(.iconOnly)
                    }
                }
        }
        .background {
            switch route {
            case .conversation, .message:
                KordiChatWallpaper(theme: chatTheme).ignoresSafeArea()
            default:
                Color.clear
            }
        }
    }

    @ViewBuilder private var screen: some View {
        switch route {
        case .conversation(let conversation):
            ConversationView(conversation: conversation, onOpenSessionDetails: openSessionDetails)
                .task {
                    if selectedTab == .contacts {
                        _ = await model.restoreConversationIfNeeded(conversation)
                    }
                }
        case .message(let route):
            ConversationView(conversation: route.conversation, initialMessageID: route.messageID,
                onOpenSessionDetails: openSessionDetails)
        case .sessionDetails(let conversation):
            SessionDetailView(conversation: conversation) {
                if path.last == route { path.removeLast() }
            }
        case .newChat(.addContact):
            AddContactSearchView(onRequestSent: { if !path.isEmpty { path.removeLast() } })
                .navigationTitle(NewChatMode.addContact.navigationTitle)
                .navigationBarTitleDisplayMode(.inline)
        case .newChat(let mode):
            NewChatView(mode: mode) { path.append(.conversation($0)) }
        case .archived(let channel):
            ArchivedChatsView(channel: channel, onOpenConversation: { path.append(.conversation($0)) })
        }
    }

    private func openSessionDetails(_ conversation: ConversationSummary) {
        if case .sessionDetails(let current)? = path.last,
           current.sessionId == conversation.sessionId { return }
        path.append(.sessionDetails(conversation))
    }
}
