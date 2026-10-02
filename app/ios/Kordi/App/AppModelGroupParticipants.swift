import Foundation

extension AppModel {
    func groupParticipantsIncludingSelf(
        _ conversation: ConversationSummary,
        account: CloudAccount
    ) -> [CloudGroupParticipant] {
        hydratedGroupParticipants(conversation, account: account)
    }

    func hydratedGroupParticipants(
        _ conversation: ConversationSummary,
        account: CloudAccount
    ) -> [CloudGroupParticipant] {
        var byAccountID = Dictionary(uniqueKeysWithValues: conversation.groupParticipants.map { ($0.accountId, $0) })
        for contact in contacts {
            guard let participant = byAccountID[contact.accountId] else { continue }
            byAccountID[contact.accountId] = CloudGroupParticipant(
                accountId: participant.accountId,
                displayName: contact.preferredName,
                avatarUrl: contact.avatarUrl?.nonEmpty ?? participant.avatarUrl,
                agentId: contact.defaultAgent?.agentId ?? participant.agentId,
                agentDisplayName: contact.defaultAgent?.displayName ?? participant.agentDisplayName,
                agentAvatarUrl: contact.defaultAgent?.avatar.imageSource ?? participant.agentAvatarUrl,
                role: participant.role,
                joinedAt: participant.joinedAt
            )
        }
        byAccountID[account.accountId] = CloudGroupParticipant(
            accountId: account.accountId,
            displayName: account.preferredName,
            avatarUrl: account.avatar.imageSource,
            agentId: account.defaultAgent?.agentId,
            agentDisplayName: account.defaultAgent?.displayName,
            agentAvatarUrl: account.defaultAgent?.avatar.imageSource,
            role: byAccountID[account.accountId]?.role.nonEmpty ?? "self",
            joinedAt: byAccountID[account.accountId]?.joinedAt
        )
        return byAccountID.values.sorted(by: CloudGroupParticipant.canonicalPrecedes)
    }

    nonisolated static func groupControlTitle(kind: String, displayTitle: String, sharedTitle: String?) -> String? {
        // Only an explicit channel rename may publish the displayed title.
        // Historical member-private labels must never become shared channel names.
        kind == "session-title-update" ? displayTitle.nonEmpty : sharedTitle.nonEmpty
    }

}
