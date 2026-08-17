import Foundation

struct ComposerMentionTextSegment: Equatable {
    let text: String
    let kind: ComposerMentionKind?
}

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

    static func highlightedSegments(
        in text: String,
        targets: [ComposerMentionTarget]
    ) -> [ComposerMentionTextSegment] {
        guard !text.isEmpty, text.contains("@") else {
            return text.isEmpty ? [] : [ComposerMentionTextSegment(text: text, kind: nil)]
        }

        let exactTargets = targets.sorted { $0.mentionText.count > $1.mentionText.count }
        var segments: [ComposerMentionTextSegment] = []
        var plainStart = text.startIndex
        var cursor = text.startIndex

        while cursor < text.endIndex {
            guard text[cursor] == "@", hasLeadingBoundary(in: text, at: cursor) else {
                cursor = text.index(after: cursor)
                continue
            }

            var match: (range: Range<String.Index>, kind: ComposerMentionKind)?
            for target in exactTargets where !target.displayName.isEmpty {
                if let range = text.range(
                    of: target.mentionText,
                    options: [.anchored, .caseInsensitive, .diacriticInsensitive],
                    range: cursor..<text.endIndex,
                    locale: .current
                ), hasTrailingBoundary(in: text, at: range.upperBound) {
                    match = (range, target.kind)
                    break
                }
            }

            if match == nil {
                let labelStart = text.index(after: cursor)
                if labelStart < text.endIndex,
                   text[labelStart].isLetter || text[labelStart].isNumber {
                    var labelEnd = text.index(after: labelStart)
                    while labelEnd < text.endIndex,
                          isMentionContinuation(text[labelEnd]) {
                        labelEnd = text.index(after: labelEnd)
                    }
                    let range = cursor..<labelEnd
                    match = (range, inferredKind(for: String(text[range])))
                }
            }

            guard let match else {
                cursor = text.index(after: cursor)
                continue
            }
            if plainStart < match.range.lowerBound {
                segments.append(ComposerMentionTextSegment(
                    text: String(text[plainStart..<match.range.lowerBound]),
                    kind: nil
                ))
            }
            segments.append(ComposerMentionTextSegment(
                text: String(text[match.range]),
                kind: match.kind
            ))
            plainStart = match.range.upperBound
            cursor = match.range.upperBound
        }

        if plainStart < text.endIndex {
            segments.append(ComposerMentionTextSegment(
                text: String(text[plainStart...]),
                kind: nil
            ))
        }
        return segments
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

    private static func hasLeadingBoundary(in text: String, at index: String.Index) -> Bool {
        index == text.startIndex
            || !isMentionLeadingCharacter(text[text.index(before: index)])
    }

    private static func hasTrailingBoundary(in text: String, at index: String.Index) -> Bool {
        index == text.endIndex
            || !(text[index].isLetter || text[index].isNumber || "_'-’".contains(text[index]))
    }

    private static func isMentionLeadingCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || "._%+-".contains(character)
    }

    private static func isMentionContinuation(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || "._'-’".contains(character)
    }

    private static func inferredKind(for label: String) -> ComposerMentionKind {
        let normalized = String(label.dropFirst()).lowercased()
        return normalized == "kordi" || normalized.hasSuffix("kordi") ? .agent : .person
    }
}
