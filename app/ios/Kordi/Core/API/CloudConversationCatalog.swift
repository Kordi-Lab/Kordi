import Foundation

enum CloudConversationCatalog {
    static func build(
        account: CloudAccount,
        contacts: [CloudContact],
        ownedAgents: [CloudAgent],
        sharedAgents: [CloudAgent],
        messagesByPeer: [String: [CloudMessageDTO]],
        canonicalConversations: [CloudChatConversation] = [],
        canonicalParticipantsBySessionId: [String: [CloudGroupParticipant]] = [:],
        sessionForksById: [String: CloudSessionForkSummary] = [:],
        hiddenSessionIds: Set<String> = [],
        deletedSessionIds: Set<String> = [],
        now: Date = Date()
    ) -> [ConversationSummary] {
        let invisibleSessionIds = hiddenSessionIds.union(deletedSessionIds)
        var visibleMessagesByPeer: [String: [CloudMessageDTO]] = [:]
        var groupRows: [(CloudMessageDTO, CloudGroupControlEnvelope)] = []
        var groupWireMessageIds = Set<String>()
        for (peer, messages) in messagesByPeer {
            for message in messages {
                let envelope = CloudGroupMessageCodec.parse(message.body)
                var sessionKeys = Set<String>()
                if let sessionId = message.sessionId?.nonEmpty { sessionKeys.insert(sessionId) }
                if let groupId = envelope?.groupId.nonEmpty { sessionKeys.insert(groupId) }
                guard sessionKeys.isDisjoint(with: invisibleSessionIds) else { continue }
                visibleMessagesByPeer[peer, default: []].append(message)
                if let envelope {
                    groupWireMessageIds.insert(message.messageId)
                    if envelope.participants.contains(where: { $0.accountId == account.accountId }) {
                        groupRows.append((message, envelope))
                    }
                }
            }
        }
        let allMessages = visibleMessagesByPeer.values.flatMap { $0 }
        let contactsById = contacts.reduce(into: [String: CloudContact]()) { result, contact in
            result[contact.accountId] = contact
        }
        let agentsById = (ownedAgents + sharedAgents).reduce(into: [String: CloudAgent]()) { result, agent in
            result[agent.agentId] = agent
        }
        let visibleCanonicalConversations = canonicalConversations.filter { conversation in
            let sessionId = conversation.legacySessionId?.nonEmpty ?? conversation.id
            return !invisibleSessionIds.contains(sessionId)
                && !invisibleSessionIds.contains(conversation.id)
        }
        var canonicalConversationsBySessionId: [String: CloudChatConversation] = [:]
        for conversation in visibleCanonicalConversations {
            canonicalConversationsBySessionId[conversation.id] = conversation
            if let sessionId = conversation.legacySessionId?.nonEmpty {
                canonicalConversationsBySessionId[sessionId] = conversation
            }
        }
        let supportCanonicalConversation = visibleCanonicalConversations
            .filter {
                KordiSupportIdentity.isSystemAgentSession($0.legacySessionId ?? $0.id)
            }
            .max { parseCloudDate($0.updatedAt) < parseCloudDate($1.updatedAt) }
        let groups = groupConversations(
            account: account,
            contactsById: contactsById,
            canonicalConversations: visibleCanonicalConversations,
            canonicalParticipantsBySessionId: canonicalParticipantsBySessionId,
            canonicalConversationsBySessionId: canonicalConversationsBySessionId,
            controls: groupRows
        )
        let groupSessionIds = Set(groups.map(\.sessionId))
        var agentSessions = agentConversations(
            account: account,
            contactsById: contactsById,
            agentsById: agentsById,
            messages: allMessages,
            sessionForksById: sessionForksById,
            groupSessionIds: groupSessionIds,
            groupWireMessageIds: groupWireMessageIds
        )
        let existingAgentSessionIds = Set(agentSessions.map(\.sessionId))
        agentSessions += canonicalAgentConversations(
            account: account,
            contactsById: contactsById,
            agentsById: agentsById,
            messages: allMessages,
            canonicalConversations: visibleCanonicalConversations,
            sessionForksById: sessionForksById
        ).filter { !existingAgentSessionIds.contains($0.sessionId) }
        let discoveredAgentIds = Set(agentSessions.compactMap(\.agentId))
        let hasDefaultAgentSession = agentSessions.contains { $0.agentId == nil && $0.peerAccountId == account.accountId }

        var agents = agentSessions
        if !hasDefaultAgentSession {
            agents.append(defaultAgentConversation(account: account, now: now))
        }
        agents += ownedAgents
            .filter {
                ($0.status == nil || $0.status == "active")
                    && !discoveredAgentIds.contains($0.agentId)
                    && !isKordiSupport(agent: $0)
            }
            .map { defaultConversation(for: $0, account: account) }
        agents += sharedAgents
            .filter { !discoveredAgentIds.contains($0.agentId) && !isKordiSupport(agent: $0) }
            .map { defaultConversation(for: $0, account: account) }

        var people = contacts.map { contact in
            let isSupport = KordiSupportIdentity.matches(name: contact.displayName, seed: contact.accountId)
            let sessionId = isSupport
                ? supportCanonicalConversation.flatMap { $0.legacySessionId?.nonEmpty ?? $0.id.nonEmpty }
                    ?? directPersonSessionId(account.accountId, contact.accountId)
                : directPersonSessionId(account.accountId, contact.accountId)
            let candidates = isSupport
                ? allMessages
                : visibleMessagesByPeer[contact.accountId, default: []]
            let matching = candidates.filter { message in
                guard !CloudMessageCodec.isAgentControl(message.body),
                      !groupWireMessageIds.contains(message.messageId) else { return false }
                guard let sourceSessionId = message.sessionId?.nonEmpty else { return true }
                return sourceSessionId == sessionId
            }
            let latest = matching.max { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }
            let unread = matching.filter {
                $0.toAccountId == account.accountId
                    && $0.fromAccountId != account.accountId
                    && $0.direction == "incoming"
                    && $0.readAt == nil
            }.count
            return ConversationSummary(
                id: "person:\(contact.accountId)",
                kind: .person,
                peerAccountId: contact.accountId,
                agentId: nil,
                ownerDisplayName: contact.preferredName,
                displayName: contact.preferredName,
                lastMessage: latest.map { CloudMessageCodec.displayText($0.body) } ?? "Start a conversation",
                lastActivityAt: latest.map { parseCloudDate($0.createdAt) } ?? parseCloudDate(contact.createdAt),
                unreadCount: unread,
                avatarSource: contact.avatarUrl.nonEmpty,
                agentActivity: nil,
                sessionId: sessionId
            )
        }
        people += visibleCanonicalConversations.compactMap { conversation in
            guard conversation.kind == "direct",
                  !isCanonicalAgentConversation(conversation) else { return nil }
            let sessionId = conversation.legacySessionId?.nonEmpty ?? conversation.id
            guard !KordiSupportIdentity.isSystemAgentSession(sessionId),
                  let peer = conversation.members.first(where: {
                      $0.accountId != account.accountId && $0.membershipState == "active"
                  }),
                  contactsById[peer.accountId] == nil else { return nil }
            let matching = visibleMessagesByPeer[peer.accountId, default: []].filter { message in
                guard !CloudMessageCodec.isAgentControl(message.body),
                      !groupWireMessageIds.contains(message.messageId) else { return false }
                guard let sourceSessionId = message.sessionId?.nonEmpty else { return true }
                return sourceSessionId == sessionId
            }
            let latest = matching.max { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }
            let unread = matching.filter {
                $0.toAccountId == account.accountId
                    && $0.fromAccountId != account.accountId
                    && $0.direction == "incoming"
                    && $0.readAt == nil
            }.count
            let peerName = peer.displayName?.nonEmpty ?? "Kordi user"
            return ConversationSummary(
                id: "person:\(peer.accountId)",
                kind: .person,
                peerAccountId: peer.accountId,
                agentId: nil,
                ownerDisplayName: peerName,
                displayName: peerName,
                lastMessage: latest.map { CloudMessageCodec.displayText($0.body) } ?? "Start a conversation",
                lastActivityAt: latest.map { parseCloudDate($0.createdAt) }
                    ?? parseCloudDate(conversation.updatedAt),
                unreadCount: unread,
                avatarSource: peer.avatarUrl?.nonEmpty,
                agentActivity: nil,
                sessionId: sessionId
            )
        }

        var uniqueById: [String: ConversationSummary] = [:]
        for conversation in groups + agents + people {
            if let existing = uniqueById[conversation.id], existing.lastActivityAt >= conversation.lastActivityAt {
                continue
            }
            uniqueById[conversation.id] = conversation
        }

        return uniqueById.values.sorted {
            $0.lastActivityAt > $1.lastActivityAt || (
                $0.lastActivityAt == $1.lastActivityAt && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            )
        }
    }

    private static func groupConversations(
        account: CloudAccount,
        contactsById: [String: CloudContact],
        canonicalConversations: [CloudChatConversation],
        canonicalParticipantsBySessionId: [String: [CloudGroupParticipant]],
        canonicalConversationsBySessionId: [String: CloudChatConversation],
        controls: [(CloudMessageDTO, CloudGroupControlEnvelope)]
    ) -> [ConversationSummary] {
        var grouped = Dictionary(grouping: controls, by: { $0.1.groupId })
        // Bootstrap contains every canonical session, while its message
        // snapshot contains only the newest raw item. Keep the directory
        // complete even for an empty group session or a legacy row whose
        // newest payload cannot be decoded.
        for conversation in canonicalConversations where conversation.kind == "group" {
            let sessionId = conversation.legacySessionId?.nonEmpty ?? conversation.id
            if grouped[sessionId] == nil { grouped[sessionId] = [] }
        }
        let canonicalLineage = canonicalGroupLineage(controls.map(\.1))

        return grouped.compactMap { groupId, rows in
            guard !KordiSupportIdentity.isSystemAgentSession(groupId) else { return nil }
            let sorted = rows.sorted { rowDate($0) < rowDate($1) }
            let canonical = canonicalConversationsBySessionId[groupId]
            let participants = enrichedParticipants(
                mergedParticipants(
                    legacy: latestParticipants(in: sorted.map(\.1)),
                    canonical: canonicalParticipantsBySessionId[groupId] ?? []
                ),
                account: account,
                contactsById: contactsById
            )
            let peers = participants.filter { $0.accountId != account.accountId }
            let groupMessages = deduplicatedGroupMessages(sorted)
            let latestMessage = groupMessages.max { $0.createdAtMs < $1.createdAtMs }
            let sessionTitle = sorted.reversed().compactMap { row -> String? in
                row.1.kind == "session-title-update" ? nonGenericTitle(row.1.groupTitle) : nil
            }.first
            let groupTitle = sorted.reversed().compactMap { row -> String? in
                ["group-invite", "group-update", "group-title-update"].contains(row.1.kind)
                    ? nonGenericTitle(row.1.groupTitle)
                    : nil
            }.first
            let participantTitle = peers
                .map { contactsById[$0.accountId]?.preferredName ?? $0.displayName }
                .filter { !$0.isEmpty }
                .prefix(3)
                .joined(separator: ", ")
            let groupSpaceId = canonicalLineage[groupId]?.spaceId
                ?? sorted.reversed().compactMap { $0.1.groupSpaceId?.nonEmpty }.first
                ?? groupId
            let inferredSessionTitle = groupMessages
                .min { $0.createdAtMs < $1.createdAtMs }
                .flatMap { Self.sessionTitle($0.text) }
            let title = sessionTitle
                ?? (groupId == groupSpaceId ? groupTitle : nil)
                ?? nonGenericTitle(canonical?.preferences.personalTitle)
                ?? nonGenericTitle(canonical?.sharedTitle)
                ?? inferredSessionTitle
                ?? groupTitle
                ?? participantTitle.nonEmpty
                ?? "Group"
            let unreadMessageIds = Set(sorted.compactMap { wire, envelope -> String? in
                guard envelope.kind == "group-message",
                      let message = envelope.message,
                      wire.toAccountId == account.accountId,
                      wire.direction == "incoming",
                      wire.fromAccountId != account.accountId,
                      message.senderAccountId != account.accountId,
                      wire.readAt == nil else { return nil }
                return message.id
            })
            return ConversationSummary(
                id: "group:\(groupId)",
                kind: .group,
                peerAccountId: peers.first?.accountId ?? account.accountId,
                agentId: nil,
                ownerDisplayName: groupTitle,
                displayName: title,
                lastMessage: latestMessage?.text.nonEmpty ?? "Group conversation",
                lastActivityAt: latestMessage.map { Date(timeIntervalSince1970: $0.createdAtMs / 1_000) }
                    ?? sorted.last.map(rowDate)
                    ?? canonical.map { parseCloudDate($0.updatedAt) }
                    ?? .distantPast,
                unreadCount: unreadMessageIds.count,
                avatarSource: nil,
                agentActivity: nil,
                sessionId: groupId,
                groupSpaceId: groupSpaceId,
                groupParticipants: participants,
                messageCount: groupMessages.count,
                forkedFromSessionId: canonicalLineage[groupId]?.forkedFromSessionId
                    ?? canonical?.forkedFromSessionId?.nonEmpty
            )
        }
    }

    /// Historical desktop builds wrote a fork's own session id into
    /// `groupSpaceId`. The fork payload still carries the true parent, so walk
    /// that lineage to keep every session under its original group space.
    private struct GroupLineage {
        let spaceId: String
        let forkedFromSessionId: String?
    }

    private static func canonicalGroupLineage(
        _ envelopes: [CloudGroupControlEnvelope]
    ) -> [String: GroupLineage] {
        var explicitSpaceByGroup: [String: String] = [:]
        var parentByFork: [String: String] = [:]
        for envelope in envelopes {
            if let explicit = envelope.groupSpaceId?.nonEmpty {
                explicitSpaceByGroup[envelope.groupId] = explicit
            }
            if let fork = envelope.fork,
               let child = fork.forkSessionId.nonEmpty ?? envelope.groupId.nonEmpty,
               let parent = fork.parentSessionId.nonEmpty,
               child != parent {
                parentByFork[child] = parent
            }
        }

        var resolved: [String: String] = [:]
        func root(for groupId: String, visiting: Set<String>) -> String {
            if let cached = resolved[groupId] { return cached }
            guard !visiting.contains(groupId) else { return groupId }
            var nextVisiting = visiting
            nextVisiting.insert(groupId)

            let parent = parentByFork[groupId]
                ?? explicitSpaceByGroup[groupId].flatMap { $0 == groupId ? nil : $0 }
            let value = parent.map { root(for: $0, visiting: nextVisiting) } ?? groupId
            resolved[groupId] = value
            return value
        }

        for groupId in Set(envelopes.map(\.groupId)) {
            resolved[groupId] = root(for: groupId, visiting: [])
        }
        return Dictionary(uniqueKeysWithValues: resolved.map { groupId, spaceId in
            (groupId, GroupLineage(
                spaceId: spaceId,
                forkedFromSessionId: parentByFork[groupId]
            ))
        })
    }

    private static func agentConversations(
        account: CloudAccount,
        contactsById: [String: CloudContact],
        agentsById: [String: CloudAgent],
        messages: [CloudMessageDTO],
        sessionForksById: [String: CloudSessionForkSummary],
        groupSessionIds: Set<String>,
        groupWireMessageIds: Set<String>
    ) -> [ConversationSummary] {
        let candidateRows = messages.filter { message in
            guard let sessionId = message.sessionId?.nonEmpty,
                  !sessionId.hasPrefix("session:direct-person:"),
                  !sessionId.hasPrefix("cloud-agent:"),
                  !groupSessionIds.contains(sessionId),
                  !groupWireMessageIds.contains(message.messageId),
                  !CloudMessageCodec.isAgentControl(message.body) else { return false }
            let selfAccountSession = message.fromAccountId == account.accountId
                && message.toAccountId == account.accountId
            return selfAccountSession
                || sessionId.hasPrefix("session:self-agent:")
                || sessionId.hasPrefix("session:direct-agent:")
                || CloudMessageCodec.directEnvelope(message.body) != nil
                || CloudMessageCodec.isAgentResponse(message.body)
        }
        let grouped = Dictionary(grouping: candidateRows, by: { $0.sessionId ?? "" })

        return grouped.compactMap { sessionId, rows in
            guard !sessionId.isEmpty else { return nil }
            let sorted = rows.sorted { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }
            let requests = sorted.compactMap { message -> (CloudMessageDTO, CloudMessageCodec.DirectEnvelope)? in
                guard let envelope = CloudMessageCodec.directEnvelope(message.body) else { return nil }
                return (message, envelope)
            }
            let targetId = requests.compactMap { $0.1.targetCloudAgentId?.nonEmpty }.last
                ?? knownAgentId(from: sessionId, agentsById: agentsById)
            let definition = targetId.flatMap { agentsById[$0] }
            let peerAccountId = requests.compactMap { $0.1.targetCloudAgentOwnerAccountId?.nonEmpty }.last
                ?? definition?.ownerAccountId
                ?? otherAccountId(in: sorted, accountId: account.accountId)
                ?? account.accountId
            let agentName = requests.compactMap { $0.1.targetCloudAgentName?.nonEmpty }.last
                ?? definition?.name
                ?? "My Kordi"
            guard !KordiSupportIdentity.matches(name: agentName, seed: targetId) else { return nil }
            let ownerName = requests.compactMap { $0.1.targetCloudAgentOwnerName?.nonEmpty }.last
                ?? (peerAccountId == account.accountId ? account.preferredName : contactsById[peerAccountId]?.preferredName)
            let firstPrompt = sorted.first(where: { !CloudMessageCodec.isAgentResponse($0.body) })
                .map { CloudMessageCodec.displayText($0.body) }
            let latest = sorted.last
            return ConversationSummary(
                id: "agent-session:\(sessionId)",
                kind: .agent,
                peerAccountId: peerAccountId,
                agentId: targetId,
                ownerDisplayName: ownerName,
                displayName: sessionTitle(firstPrompt) ?? agentName,
                lastMessage: latest.map { CloudMessageCodec.displayText($0.body) } ?? definition?.description?.nonEmpty ?? "No messages yet",
                lastActivityAt: latest.map { parseCloudDate($0.createdAt) } ?? definition.map { parseCloudDate($0.updatedAt) } ?? .distantPast,
                unreadCount: 0,
                avatarSource: definition?.avatarUrl?.nonEmpty,
                agentActivity: .ready,
                sessionId: sessionId,
                agentDisplayName: agentName,
                forkedFromSessionId: sessionForksById[sessionId]?.parentSessionId.nonEmpty
            )
        }
    }

    private static func canonicalAgentConversations(
        account: CloudAccount,
        contactsById: [String: CloudContact],
        agentsById: [String: CloudAgent],
        messages: [CloudMessageDTO],
        canonicalConversations: [CloudChatConversation],
        sessionForksById: [String: CloudSessionForkSummary]
    ) -> [ConversationSummary] {
        canonicalConversations.compactMap { conversation in
            let sessionId = conversation.legacySessionId?.nonEmpty ?? conversation.id
            guard isCanonicalAgentConversation(conversation) else { return nil }

            let rows = messages
                .filter { ($0.sessionId?.nonEmpty ?? "") == sessionId }
                .sorted { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }
            let requests = rows.compactMap { message -> CloudMessageCodec.DirectEnvelope? in
                CloudMessageCodec.directEnvelope(message.body)
            }
            let targetId = requests.compactMap { $0.targetCloudAgentId?.nonEmpty }.last
                ?? knownAgentId(from: sessionId, agentsById: agentsById)
            let definition = targetId.flatMap { agentsById[$0] }
            let otherMember = conversation.members.first {
                $0.accountId != account.accountId && $0.membershipState == "active"
            }
            let peerAccountId = requests.compactMap { $0.targetCloudAgentOwnerAccountId?.nonEmpty }.last
                ?? definition?.ownerAccountId
                ?? otherMember?.accountId
                ?? account.accountId
            let agentName = requests.compactMap { $0.targetCloudAgentName?.nonEmpty }.last
                ?? definition?.name
                ?? "My Kordi"
            guard !KordiSupportIdentity.matches(name: agentName, seed: targetId) else { return nil }
            let ownerName = requests.compactMap { $0.targetCloudAgentOwnerName?.nonEmpty }.last
                ?? (peerAccountId == account.accountId
                    ? account.preferredName
                    : contactsById[peerAccountId]?.preferredName ?? otherMember?.displayName)
            let firstPrompt = rows.first(where: { !CloudMessageCodec.isAgentResponse($0.body) })
                .map { CloudMessageCodec.displayText($0.body) }
            let latest = rows.last
            let title = nonGenericTitle(conversation.preferences.personalTitle)
                ?? nonGenericTitle(conversation.sharedTitle)
                ?? sessionTitle(firstPrompt)
                ?? agentName
            return ConversationSummary(
                id: "agent-session:\(sessionId)",
                kind: .agent,
                peerAccountId: peerAccountId,
                agentId: targetId,
                ownerDisplayName: ownerName,
                displayName: title,
                lastMessage: latest.map { CloudMessageCodec.displayText($0.body) }
                    ?? definition?.description?.nonEmpty
                    ?? "No messages yet",
                lastActivityAt: max(
                    latest.map { parseCloudDate($0.createdAt) } ?? .distantPast,
                    parseCloudDate(conversation.updatedAt)
                ),
                unreadCount: 0,
                avatarSource: definition?.avatarUrl?.nonEmpty,
                agentActivity: .ready,
                sessionId: sessionId,
                agentDisplayName: agentName,
                messageCount: Int(clamping: conversation.latestMessageSequence),
                forkedFromSessionId: conversation.forkedFromSessionId?.nonEmpty
                    ?? sessionForksById[sessionId]?.parentSessionId.nonEmpty
            )
        }
    }

    private static func isCanonicalAgentConversation(_ conversation: CloudChatConversation) -> Bool {
        guard conversation.kind != "group" else { return false }
        let sessionId = conversation.legacySessionId?.nonEmpty ?? conversation.id
        return conversation.kind == "ai"
            || sessionId.hasPrefix("session:self-agent:")
            || sessionId.hasPrefix("session:direct-agent:")
            || sessionId.hasPrefix("session:fork:")
    }

    private static func isKordiSupport(agent: CloudAgent) -> Bool {
        KordiSupportIdentity.matches(name: agent.name, seed: agent.agentId)
            || KordiSupportIdentity.matches(name: agent.ownerDisplayName, seed: agent.ownerAccountId)
    }

    private static func defaultAgentConversation(account: CloudAccount, now: Date) -> ConversationSummary {
        ConversationSummary(
            id: "agent-session:session:self-agent:default",
            kind: .agent,
            peerAccountId: account.accountId,
            agentId: nil,
            ownerDisplayName: account.preferredName,
            displayName: "My Kordi",
            lastMessage: "Your private cloud agent",
            lastActivityAt: now,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:self-agent:default",
            agentDisplayName: "My Kordi"
        )
    }

    private static func defaultConversation(for agent: CloudAgent, account: CloudAccount) -> ConversationSummary {
        let owned = agent.ownerAccountId == account.accountId
        let sessionPrefix = owned ? "session:self-agent:" : "session:direct-agent:\(agent.ownerAccountId):"
        return ConversationSummary(
            id: "agent-session:\(sessionPrefix)\(agent.agentId)",
            kind: .agent,
            peerAccountId: agent.ownerAccountId,
            agentId: agent.agentId,
            ownerDisplayName: owned ? account.preferredName : agent.ownerDisplayName,
            displayName: agent.name,
            lastMessage: agent.description?.nonEmpty ?? agent.role,
            lastActivityAt: parseCloudDate(agent.updatedAt),
            unreadCount: 0,
            avatarSource: agent.avatarUrl?.nonEmpty,
            agentActivity: .ready,
            sessionId: "\(sessionPrefix)\(agent.agentId)",
            agentDisplayName: agent.name
        )
    }

    private static func latestParticipants(in controls: [CloudGroupControlEnvelope]) -> [CloudGroupParticipant] {
        var byId: [String: CloudGroupParticipant] = [:]
        for participant in controls.flatMap(\.participants) {
            guard let accountId = participant.accountId.nonEmpty else { continue }
            let previous = byId[accountId]
            byId[accountId] = CloudGroupParticipant(
                accountId: accountId,
                displayName: participant.displayName.nonEmpty ?? previous?.displayName ?? "Kordi user",
                avatarUrl: participant.avatarUrl?.nonEmpty ?? previous?.avatarUrl,
                role: participant.role?.nonEmpty ?? previous?.role
            )
        }
        return byId.values.sorted { $0.accountId < $1.accountId }
    }

    private static func enrichedParticipants(
        _ participants: [CloudGroupParticipant],
        account: CloudAccount,
        contactsById: [String: CloudContact]
    ) -> [CloudGroupParticipant] {
        participants.map { participant in
            if participant.accountId == account.accountId {
                return CloudGroupParticipant(
                    accountId: participant.accountId,
                    displayName: account.preferredName,
                    avatarUrl: account.avatarUrl?.nonEmpty ?? participant.avatarUrl,
                    role: participant.role
                )
            }
            guard let contact = contactsById[participant.accountId] else { return participant }
            return CloudGroupParticipant(
                accountId: participant.accountId,
                displayName: contact.preferredName,
                avatarUrl: contact.avatarUrl?.nonEmpty ?? participant.avatarUrl,
                role: participant.role
            )
        }
    }

    private static func mergedParticipants(
        legacy: [CloudGroupParticipant],
        canonical: [CloudGroupParticipant]
    ) -> [CloudGroupParticipant] {
        var byAccountId = Dictionary(uniqueKeysWithValues: legacy.map { ($0.accountId, $0) })
        for participant in canonical {
            let previous = byAccountId[participant.accountId]
            byAccountId[participant.accountId] = CloudGroupParticipant(
                accountId: participant.accountId,
                displayName: participant.displayName.nonEmpty ?? previous?.displayName ?? "Kordi user",
                avatarUrl: participant.avatarUrl?.nonEmpty ?? previous?.avatarUrl,
                role: participant.role?.nonEmpty ?? previous?.role
            )
        }
        return byAccountId.values.sorted { $0.accountId < $1.accountId }
    }

    private static func deduplicatedGroupMessages(
        _ rows: [(CloudMessageDTO, CloudGroupControlEnvelope)]
    ) -> [CloudGroupMessagePayload] {
        var byId: [String: CloudGroupMessagePayload] = [:]
        for (_, envelope) in rows where envelope.kind == "group-message" {
            if let message = envelope.message { byId[message.id] = message }
        }
        return Array(byId.values)
    }

    private static func rowDate(_ row: (CloudMessageDTO, CloudGroupControlEnvelope)) -> Date {
        row.1.message.map { Date(timeIntervalSince1970: $0.createdAtMs / 1_000) }
            ?? parseCloudDate(row.0.createdAt)
    }

    private static func otherAccountId(in messages: [CloudMessageDTO], accountId: String) -> String? {
        for message in messages {
            if message.fromAccountId != accountId { return message.fromAccountId }
            if message.toAccountId != accountId { return message.toAccountId }
        }
        return nil
    }

    private static func knownAgentId(from sessionId: String, agentsById: [String: CloudAgent]) -> String? {
        agentsById.keys.first { sessionId.hasSuffix(":\($0)") }
    }

    private static func sessionTitle(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else { return nil }
        return text.split(whereSeparator: \.isWhitespace).prefix(8).joined(separator: " ").prefix(60).description
    }

    private static func nonGenericTitle(_ title: String?) -> String? {
        guard let title = title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else { return nil }
        let generic = ["new chat", "new session", "new fork", "untitled session", "session"]
        return generic.contains(title.lowercased().replacingOccurrences(of: "# ", with: "")) ? nil : title
    }
}

func directPersonSessionId(_ first: String, _ second: String) -> String {
    "session:direct-person:" + [first, second].sorted().joined(separator: ":")
}

func parseCloudDate(_ value: String) -> Date {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) ?? .distantPast
}
