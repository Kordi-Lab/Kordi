import Foundation

enum SessionDetailTab: String, Identifiable {
    case members = "Members"
    case memory = "Memory"
    case media = "Media"
    case files = "Files"
    case todo = "Todo"
    case groups = "Groups"

    var id: Self { self }
}

enum SessionDetailPresentationContext: Equatable {
    case conversation
    case groupParticipantProfile

    static func authorProfile(
        sourceConversation: ConversationSummary,
        destination: ConversationSummary
    ) -> Self {
        sourceConversation.kind == .group && destination.kind == .person
            ? .groupParticipantProfile
            : .conversation
    }

    var opensConversationOnChat: Bool {
        self == .groupParticipantProfile
    }
}
