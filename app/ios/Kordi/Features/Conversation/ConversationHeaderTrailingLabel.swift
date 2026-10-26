import SwiftUI

/// The trailing header control's label: the agent's avatar with the online
/// dot in a personal session (#2091), the ellipsis everywhere else. Both open
/// the session details.
struct ConversationHeaderTrailingLabel: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let conversation: ConversationSummary

    static func hidesSharedBackground(for conversation: ConversationSummary) -> Bool {
        conversation.personalAgentId != nil
    }

    var body: some View {
        Group {
            if conversation.personalAgentId != nil {
                PersonalAgentAvatar(conversation: conversation, size: 32, ringColor: chatTheme.canvas)
            } else {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
            }
        }
        .frame(width: 44, height: 44)
    }
}
