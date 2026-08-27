import Foundation

struct ComposerMentionTextSegment: Equatable {
    let text: String
    let kind: ComposerMentionKind?
    let profileAccountId: String?

    init(
        text: String,
        kind: ComposerMentionKind?,
        profileAccountId: String? = nil
    ) {
        self.text = text
        self.kind = kind
        self.profileAccountId = profileAccountId
    }
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
        sharedAgents: [CloudAgent],
        contacts: [CloudContact] = []
    ) -> [ComposerMentionTarget] {
        let ownerAccountIDs = Set(ownerAccountIDs(
            for: conversation,
            currentAccountID: account.accountId
        ))
        var targets: [ComposerMentionTarget] = []

        if conversation.kind == .group {
            targets.append(ComposerMentionTarget(
                id: "group:\(conversation.sessionId)",
                displayName: "All",
                kind: .all,
                accountId: conversation.sessionId,
                agentId: nil,
                ownerName: "All people in this group",
                avatarSource: nil
            ))
            var seenPeople = Set<String>()
            for participant in conversation.groupParticipants
                where participant.accountId != account.accountId
                    && participant.displayName.localizedCaseInsensitiveCompare("all") != .orderedSame
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

        if conversation.kind != .agent {
            targets.append(defaultAgentTarget(
                ownerAccountID: account.accountId,
                ownerName: account.preferredName,
                isCurrentAccount: true
            ))
            for contact in contacts
                where ownerAccountIDs.contains(contact.accountId)
                    && !KordiSupportIdentity.matches(
                        name: contact.preferredName,
                        seed: contact.accountId
                    ) {
                targets.append(defaultAgentTarget(
                    ownerAccountID: contact.accountId,
                    ownerName: contact.preferredName,
                    isCurrentAccount: false
                ))
            }
        }

        var seenAgentIDs = Set<String>()
        for agent in ownedAgents + sharedAgents
            where ownerAccountIDs.contains(agent.ownerAccountId)
                && isMentionable(agent)
                && agent.name.localizedCaseInsensitiveCompare("all") != .orderedSame
                && seenAgentIDs.insert(agent.agentId).inserted {
            targets.append(ComposerMentionTarget(
                id: "agent:\(agent.agentId)",
                displayName: agent.name,
                kind: .agent,
                accountId: agent.ownerAccountId,
                agentId: agent.agentId,
                ownerName: agent.ownerDisplayName
                    ?? (agent.ownerAccountId == account.accountId ? account.preferredName : nil),
                avatarSource: agent.avatar.imageSource
            ))
        }

        return targets.sorted(by: precedes)
    }

    private static func defaultAgentTarget(
        ownerAccountID: String,
        ownerName: String,
        isCurrentAccount: Bool
    ) -> ComposerMentionTarget {
        let agentID = isCurrentAccount
            ? CanonicalAvatarSystem.defaultAgentId
            : "cloud-agent:\(ownerAccountID)"
        return ComposerMentionTarget(
            id: "agent:\(agentID)",
            displayName: isCurrentAccount ? "My Kordi" : "\(ownerName)’s Kordi",
            kind: .agent,
            accountId: ownerAccountID,
            agentId: agentID,
            ownerName: ownerName,
            avatarSource: nil
        )
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

    static func mentions(
        in text: String,
        selectedTarget: ComposerMentionTarget?,
        targets: [ComposerMentionTarget]
    ) -> [MessageMention] {
        let targetsByName = Dictionary(grouping: targets) {
            $0.displayName.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        }
        var occupied: [NSRange] = []
        var result: [MessageMention] = []
        for target in targets.sorted(by: { $0.mentionText.count > $1.mentionText.count }) {
            let key = target.displayName.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            if (targetsByName[key]?.count ?? 0) > 1, selectedTarget?.id != target.id { continue }
            var searchStart = text.startIndex
            while searchStart < text.endIndex,
                  result.count < 32,
                  let range = text.range(
                    of: target.mentionText,
                    options: [.caseInsensitive, .diacriticInsensitive],
                    range: searchStart..<text.endIndex,
                    locale: .current
                  ) {
                let nsRange = NSRange(range, in: text)
                if hasLeadingBoundary(in: text, at: range.lowerBound),
                   hasTrailingBoundary(in: text, at: range.upperBound),
                   !occupied.contains(where: { NSIntersectionRange($0, nsRange).length > 0 }) {
                    occupied.append(nsRange)
                    result.append(MessageMention(target: target, text: text, range: range))
                }
                searchStart = range.upperBound
            }
        }
        return result.sorted { ($0.startUtf16 ?? 0) < ($1.startUtf16 ?? 0) }
    }

    static func highlightedSegments(
        in text: String,
        mentions: [MessageMention] = [],
        targets: [ComposerMentionTarget]
    ) -> [ComposerMentionTextSegment] {
        guard !text.isEmpty, text.contains("@") else {
            return text.isEmpty ? [] : [ComposerMentionTextSegment(text: text, kind: nil)]
        }

        let exactMentions = MessageMention.rebased(mentions, in: text)
        let exactTargets = targets.sorted { $0.mentionText.count > $1.mentionText.count }
        var segments: [ComposerMentionTextSegment] = []
        var plainStart = text.startIndex
        var cursor = text.startIndex

        while cursor < text.endIndex {
            guard text[cursor] == "@", hasLeadingBoundary(in: text, at: cursor) else {
                cursor = text.index(after: cursor)
                continue
            }

            var match: (
                range: Range<String.Index>,
                kind: ComposerMentionKind,
                profileAccountId: String?
            )?
            let cursorUtf16 = NSRange(cursor..<cursor, in: text).location
            if let mention = exactMentions.first(where: { $0.startUtf16 == cursorUtf16 }),
               let start = mention.startUtf16,
               let length = mention.lengthUtf16,
               let range = Range(NSRange(location: start, length: length), in: text),
               hasLeadingBoundary(in: text, at: range.lowerBound),
               hasTrailingBoundary(in: text, at: range.upperBound) {
                let kind = mention.kind ?? inferredKind(for: String(text[range]))
                match = (
                    range,
                    kind,
                    kind == .person ? personAccountID(for: mention) : nil
                )
            }
            for target in exactTargets where match == nil && !target.displayName.isEmpty {
                if let range = text.range(
                    of: target.mentionText,
                    options: [.anchored, .caseInsensitive, .diacriticInsensitive],
                    range: cursor..<text.endIndex,
                    locale: .current
                ), hasTrailingBoundary(in: text, at: range.upperBound) {
                    match = (
                        range,
                        target.kind,
                        target.kind == .person ? target.accountId.nonEmpty : nil
                    )
                    break
                }
            }

            if match == nil,
               let range = text.range(
                of: "@My Kordi",
                options: [.anchored, .caseInsensitive],
                range: cursor..<text.endIndex,
                locale: .current
               ), hasTrailingBoundary(in: text, at: range.upperBound) {
                match = (range, .agent, nil)
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
                    match = (range, inferredKind(for: String(text[range])), nil)
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
                kind: match.kind,
                profileAccountId: match.profileAccountId
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

    static func accessibilityText(
        in text: String,
        mentions: [MessageMention] = [],
        targets: [ComposerMentionTarget]
    ) -> String {
        highlightedSegments(in: text, mentions: mentions, targets: targets)
            .map { segment in
                segment.kind.map { "\($0.accessibilityDescription) \(segment.text)" } ?? segment.text
            }
            .joined()
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
        if lhs.kind != rhs.kind { return mentionKindRank(lhs.kind) < mentionKindRank(rhs.kind) }
        let nameComparison = lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName)
        if nameComparison != .orderedSame { return nameComparison == .orderedAscending }
        let ownerComparison = (lhs.ownerName ?? "").localizedCaseInsensitiveCompare(rhs.ownerName ?? "")
        if ownerComparison != .orderedSame { return ownerComparison == .orderedAscending }
        return lhs.id < rhs.id
    }

    private static func mentionKindRank(_ kind: ComposerMentionKind) -> Int {
        switch kind {
        case .all: 0
        case .agent: 1
        case .person: 2
        }
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

    private static func personAccountID(for mention: MessageMention) -> String? {
        if let humanID = mention.humanId?.nonEmpty { return humanID }
        guard mention.kind == .person,
              let identityID = mention.targetIdentityId?.nonEmpty,
              identityID.hasPrefix("human:") else { return nil }
        return String(identityID.dropFirst("human:".count)).nonEmpty
    }
}
