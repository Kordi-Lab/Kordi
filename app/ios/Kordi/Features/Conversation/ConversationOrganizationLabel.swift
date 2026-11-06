import Foundation

/// The quiet status line under a group's title: the team organization name,
/// when the group belongs to one, before the participant count.
enum ConversationOrganizationLabel {
    static func groupStatus(for conversation: ConversationSummary) -> String {
        // A group may have only its creator. An unknown list keeps the old floor of two.
        let count = conversation.groupParticipants.count
        let participants = count == 1 ? "1 participant" : "\(max(2, count)) participants"
        guard let organization = conversation.organizationName.nonEmpty else {
            return participants
        }
        return "\(organization) · \(participants)"
    }
}
