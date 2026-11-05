import Foundation

/// The quiet status line under a group's title: the team organization name,
/// when the group belongs to one, before the participant count.
enum ConversationOrganizationLabel {
    static func groupStatus(for conversation: ConversationSummary) -> String {
        let participants = "\(max(2, conversation.groupParticipants.count)) participants"
        guard let organization = conversation.organizationName.nonEmpty else {
            return participants
        }
        return "\(organization) · \(participants)"
    }
}
