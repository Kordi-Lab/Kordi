import Foundation

enum ComposerMentionTargetCatalog {
    static func ownerAccountIDs(
        for conversation: ConversationSummary,
        currentAccountID: String
    ) -> [String] {
        let ownerAccountIDs: [String]
        switch conversation.kind {
        case .group:
            ownerAccountIDs = [currentAccountID] + conversation.groupParticipants.map(\.accountId)
        case .person:
            ownerAccountIDs = [currentAccountID, conversation.peerAccountId]
        case .agent:
            ownerAccountIDs = [conversation.peerAccountId]
        }

        return Array(Set(ownerAccountIDs.compactMap(\.nonEmpty))).sorted()
    }

    static func targets(
        account: CloudAccount,
        conversation: ConversationSummary,
        ownedAgents: [CloudAgent],
        sharedAgents: [CloudAgent]
    ) -> [ComposerMentionTarget] {
        let ownerAccountIDs = Set(ownerAccountIDs(
            for: conversation,
            currentAccountID: account.accountId
        ))
        var targets: [ComposerMentionTarget] = []

        if conversation.kind == .group {
            var seenPeople = Set<String>()
            for participant in conversation.groupParticipants
                where participant.accountId != account.accountId
                    && seenPeople.insert(participant.accountId).inserted {
                targets.append(ComposerMentionTarget(
                    id: "person:\(participant.accountId)",
                    displayName: participant.displayName.nonEmpty ?? "Participant",
                    kind: .person,
                    accountId: participant.accountId,
                    agentId: nil,
                    ownerName: participant.displayName.nonEmpty,
                    avatarSource: participant.avatarUrl
                ))
            }
        }

        var seenAgentIDs = Set<String>()
        for agent in ownedAgents + sharedAgents
            where ownerAccountIDs.contains(agent.ownerAccountId)
                && isMentionable(agent)
                && seenAgentIDs.insert(agent.agentId).inserted {
            targets.append(ComposerMentionTarget(
                id: "agent:\(agent.agentId)",
                displayName: agent.name,
                kind: .agent,
                accountId: agent.ownerAccountId,
                agentId: agent.agentId,
                ownerName: agent.ownerDisplayName
                    ?? (agent.ownerAccountId == account.accountId ? account.preferredName : nil),
                avatarSource: agent.avatarUrl
            ))
        }

        return targets.sorted(by: precedes)
    }

    static func replacingSharedAgents(
        _ existingAgents: [CloudAgent],
        with refreshedAgents: [CloudAgent],
        forOwnerAccountIDs ownerAccountIDs: [String]
    ) -> [CloudAgent] {
        let refreshedOwners = Set(ownerAccountIDs)
        return existingAgents.filter { !refreshedOwners.contains($0.ownerAccountId) }
            + refreshedAgents.filter { refreshedOwners.contains($0.ownerAccountId) }
    }

    static func resolvedTarget(
        in text: String,
        selectedTarget: ComposerMentionTarget?,
        targets: [ComposerMentionTarget]
    ) -> ComposerMentionTarget? {
        if let selectedTarget,
           text.localizedCaseInsensitiveContains(selectedTarget.mentionText) {
            return targets.contains(where: { $0.id == selectedTarget.id })
                ? selectedTarget
                : nil
        }

        let matchingTargets = targets
            .filter { text.localizedCaseInsensitiveContains($0.mentionText) }
            .sorted { $0.displayName.count > $1.displayName.count }
        guard let mostSpecificTarget = matchingTargets.first else { return nil }
        let equallySpecificMatches = matchingTargets.filter {
            $0.displayName.count == mostSpecificTarget.displayName.count
        }
        return equallySpecificMatches.count == 1 ? mostSpecificTarget : nil
    }

    private static func isMentionable(_ agent: CloudAgent) -> Bool {
        agent.accessScope == CloudAgentAccessScope.participantConversations.rawValue
            && (agent.status == nil || agent.status == "active")
            && agent.archivedAt == nil
    }

    private static func precedes(
        _ lhs: ComposerMentionTarget,
        _ rhs: ComposerMentionTarget
    ) -> Bool {
        if lhs.kind != rhs.kind { return lhs.kind == .agent }
        let nameComparison = lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName)
        if nameComparison != .orderedSame { return nameComparison == .orderedAscending }
        let ownerComparison = (lhs.ownerName ?? "").localizedCaseInsensitiveCompare(rhs.ownerName ?? "")
        if ownerComparison != .orderedSame { return ownerComparison == .orderedAscending }
        return lhs.id < rhs.id
    }
}
