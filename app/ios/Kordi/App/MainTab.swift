import Foundation

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
