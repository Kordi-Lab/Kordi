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
            messages: allMessages,
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
            groupWireMessageIds: groupWireMessageIds,
            canonicalConversationsBySessionId: canonicalConversationsBySessionId
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

        let people = contacts.map { contact in
            let isSupport = KordiSupportIdentity.matches(name: contact.displayName, seed: contact.accountId)
            let sessionId = isSupport
                ? supportCanonicalConversation.flatMap { $0.legacySessionId?.nonEmpty ?? $0.id.nonEmpty }
                    ?? KordiSupportIdentity.sessionId(for: account.accountId)
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
            let canonical = canonicalConversationsBySessionId[sessionId]
            let unreadMessages = matching.filter {
                messageIsUnread(
                    $0,
                    conversation: canonical,
                    accountId: account.accountId,
                    allowSelfAuthoredAgent: false
                )
            }
            return ConversationSummary(
                id: "person:\(contact.accountId)",
                kind: .person,
                peerAccountId: contact.accountId,
                agentId: nil,
                ownerDisplayName: contact.preferredName,
                displayName: contact.preferredName,
                lastMessage: latest.map { CloudMessageCodec.previewText($0) } ?? "Start a conversation",
                lastAttachment: previewAttachment(latest),
                lastActivityAt: latest.map { parseCloudDate($0.createdAt) } ?? parseCloudDate(contact.createdAt),
                unreadCount: Set(unreadMessages.map(\.messageId)).count,
                avatarSource: contact.avatarUrl.nonEmpty,
                agentActivity: nil,
                sessionId: sessionId,
                unreadMentionCount: unreadMentionMessageIDs(
                    unreadMessages,
                    accountId: account.accountId
                ).count,
                lastReadSequence: lastReadSequence(
                    in: canonical,
                    accountId: account.accountId
                )
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
        messages: [CloudMessageDTO],
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
            let canonicalContentMessages = messages.filter {
                CloudMessageStateProjector.sessionKeys(for: $0).contains(groupId)
                    && ChatCallActivity(messageKind: $0.messageKind) == nil
                    && CloudGroupMessageCodec.parse($0.body) == nil
            }
            let latestCanonicalMessage = canonicalContentMessages.max {
                parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt)
            }
            let callMessages = Dictionary(
                grouping: messages.filter {
                    ChatCallActivity(messageKind: $0.messageKind) != nil
                        && CloudMessageStateProjector.sessionKeys(for: $0).contains(groupId)
                },
                by: \.messageId
            ).compactMap { _, rows in
                rows.max { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }
            }
            let latestCallMessage = callMessages.max {
                parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt)
            }
            var visibleRows: [(date: Date, text: String?, attachment: ChatAttachment?)] = []
            if let latestMessage {
                visibleRows.append((
                    Date(timeIntervalSince1970: latestMessage.createdAtMs / 1_000),
                    CloudMessageCodec.previewText(latestMessage).nonEmpty,
                    previewAttachment(latestMessage)
                ))
            }
            if let latestCanonicalMessage {
                visibleRows.append((
                    parseCloudDate(latestCanonicalMessage.createdAt),
                    CloudMessageCodec.previewText(latestCanonicalMessage).nonEmpty,
                    previewAttachment(latestCanonicalMessage)
                ))
            }
            if let latestCallMessage {
                visibleRows.append((
                    parseCloudDate(latestCallMessage.createdAt),
                    latestCallMessage.body.nonEmpty,
                    nil
                ))
            }
            let latestVisible = visibleRows.max { $0.date < $1.date }
            let latestVisibleText = latestVisible?.text
            let latestVisibleDate = latestVisible?.date
            let latestVisibleAttachment = latestVisible?.attachment
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
                      let message = envelope.message else { return nil }
                if message.senderKind == "agent",
                   ["queued", "processing"].contains(message.deliveryState ?? "") {
                    return nil
                }
                let selfAgentMessage = message.senderKind == "agent"
                    && message.senderAccountId == account.accountId
                let incomingMessage = wire.toAccountId == account.accountId
                    && wire.direction == "incoming"
                    && wire.fromAccountId != account.accountId
                    && message.senderAccountId != account.accountId
                guard selfAgentMessage || incomingMessage,
                      messageIsUnread(
                        wire,
                        conversation: canonical,
                        accountId: account.accountId,
                        allowSelfAuthoredAgent: selfAgentMessage
                      ) else { return nil }
                return message.id
            })
            let canonicalUnreadMessageIds = Set(canonicalContentMessages.compactMap { wire -> String? in
                guard wire.fromAccountId != account.accountId,
                      messageIsUnread(
                        wire,
                        conversation: canonical,
                        accountId: account.accountId,
                        allowSelfAuthoredAgent: false
                      ) else { return nil }
                return wire.messageId
            })
            let unreadMentionMessageIds = Set(sorted.compactMap { wire, envelope -> String? in
                guard envelope.kind == "group-message",
                      let message = envelope.message else { return nil }
                let humanGroupSessionId = message.senderKind != "agent"
                    && envelope.participants.contains { $0.accountId == message.senderAccountId }
                    ? groupId
                    : nil
                guard
                      message.senderAccountId != account.accountId,
                      messageIsUnread(
                        wire,
                        conversation: canonical,
                        accountId: account.accountId,
                        allowSelfAuthoredAgent: false
                      ),
                      containsVerifiedPersonMention(
                        wire,
                        accountId: account.accountId,
                        groupSessionId: humanGroupSessionId
                      ) else { return nil }
                return message.id
            })
            return ConversationSummary(
                id: "group:\(groupId)",
                kind: .group,
                peerAccountId: peers.first?.accountId ?? account.accountId,
                agentId: nil,
                ownerDisplayName: groupTitle,
                displayName: title,
                lastMessage: latestVisibleText ?? "Group conversation",
                lastAttachment: latestVisibleAttachment,
                lastActivityAt: latestVisibleDate
                    ?? sorted.last.map(rowDate)
                    ?? canonical.map { parseCloudDate($0.updatedAt) }
                    ?? .distantPast,
                unreadCount: unreadMessageIds.union(canonicalUnreadMessageIds).count,
                avatarSource: nil,
                agentActivity: nil,
                sessionId: groupId,
                groupSpaceId: groupSpaceId,
                groupParticipants: participants,
                messageCount: Set(
                    groupMessages.map(\.id)
                        + canonicalContentMessages.map(\.messageId)
                        + callMessages.map(\.messageId)
                ).count,
                forkedFromSessionId: canonicalLineage[groupId]?.forkedFromSessionId
                    ?? canonical?.forkedFromSessionId?.nonEmpty,
                unreadMentionCount: unreadMentionMessageIds.count,
                lastReadSequence: lastReadSequence(
                    in: canonical,
                    accountId: account.accountId
                )
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
        groupWireMessageIds: Set<String>,
        canonicalConversationsBySessionId: [String: CloudChatConversation]
    ) -> [ConversationSummary] {
        let candidateRows = messages.filter { message in
            guard let sessionId = message.sessionId?.nonEmpty,
                  !sessionId.hasPrefix("draft:"),
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
            let sorted = CloudAgentLifecycleProjector.visibleRows(rows)
            let conversationalRows = sorted.filter {
                !CloudMessageCodec.isAgentModelChange($0)
                    && $0.messageKind != CloudMessageCodec.agentSessionIdentityMessageKind
            }
            guard !conversationalRows.isEmpty else { return nil }
            let requests = sorted.compactMap { message -> (CloudMessageDTO, CloudMessageCodec.DirectEnvelope)? in
                guard let envelope = CloudMessageCodec.directEnvelope(message.body) else { return nil }
                return (message, envelope)
            }
            let canonical = canonicalConversationsBySessionId[sessionId]
            let titleDefinition = canonical.flatMap {
                agentDefinition(matchingTitlesIn: $0, agentsById: agentsById)
            }
            let targetId = requests.compactMap { $0.1.targetCloudAgentId?.nonEmpty }.last
                ?? knownAgentId(from: sessionId, agentsById: agentsById)
                ?? titleDefinition?.agentId
            let definition = targetId.flatMap { agentsById[$0] } ?? titleDefinition
            let peerAccountId = requests.compactMap { $0.1.targetCloudAgentOwnerAccountId?.nonEmpty }.last
                ?? definition?.ownerAccountId
                ?? otherAccountId(in: sorted, accountId: account.accountId)
                ?? account.accountId
            let defaultAgent = peerAccountId == account.accountId
                ? account.defaultAgent
                : contactsById[peerAccountId]?.defaultAgent
            let resolvedTargetId = targetId ?? defaultAgent?.agentId
            let agentName = requests.compactMap { $0.1.targetCloudAgentName?.nonEmpty }.last
                ?? definition?.name
                ?? defaultAgent?.displayName
                ?? "Kordi"
            guard !KordiSupportIdentity.matches(name: agentName, seed: resolvedTargetId) else { return nil }
            let ownerName = requests.compactMap { $0.1.targetCloudAgentOwnerName?.nonEmpty }.last
                ?? (peerAccountId == account.accountId ? account.preferredName : contactsById[peerAccountId]?.preferredName)
            let firstPrompt = conversationalRows.first(where: { !CloudMessageCodec.isAgentResponse($0.body) })
                .map { CloudMessageCodec.displayText($0.body) }
            let latest = conversationalRows.last
            return ConversationSummary(
                id: "agent-session:\(sessionId)",
                kind: .agent,
                peerAccountId: peerAccountId,
                agentId: resolvedTargetId,
                ownerDisplayName: ownerName,
                displayName: sessionTitle(firstPrompt) ?? agentName,
                lastMessage: latest.map { CloudMessageCodec.previewText($0) } ?? definition?.description?.nonEmpty ?? "No messages yet",
                lastAttachment: previewAttachment(latest),
                lastActivityAt: latest.map { parseCloudDate($0.createdAt) } ?? definition.map { parseCloudDate($0.updatedAt) } ?? .distantPast,
                unreadCount: unreadAgentResponseCount(
                    conversationalRows,
                    conversation: canonicalConversationsBySessionId[sessionId],
                    accountId: account.accountId
                ),
                avatarSource: definition?.avatar.imageSource ?? defaultAgent?.avatar.imageSource,
                agentActivity: CloudAgentLifecycleProjector.activity(in: conversationalRows),
                sessionId: sessionId,
                agentDisplayName: agentName,
                forkedFromSessionId: sessionForksById[sessionId]?.parentSessionId.nonEmpty,
                unreadMentionCount: unreadMentionMessageIDs(
                    conversationalRows.filter {
                        messageIsUnread(
                            $0,
                            conversation: canonical,
                            accountId: account.accountId,
                            allowSelfAuthoredAgent: false
                        )
                    },
                    accountId: account.accountId
                ).count,
                lastReadSequence: lastReadSequence(
                    in: canonical,
                    accountId: account.accountId
                )
            )
        }
    }

    private static func unreadAgentResponseCount(
        _ messages: [CloudMessageDTO],
        conversation: CloudChatConversation?,
        accountId: String
    ) -> Int {
        Set(messages.compactMap { message -> String? in
            guard CloudMessageCodec.isTerminalAgentResponse(message.body),
                  messageIsUnread(
                    message,
                    conversation: conversation,
                    accountId: accountId,
                    allowSelfAuthoredAgent: true
                  ) else { return nil }
            return message.messageId
        }).count
    }

    private static func messageIsUnread(
        _ message: CloudMessageDTO,
        conversation: CloudChatConversation?,
        accountId: String,
        allowSelfAuthoredAgent: Bool
    ) -> Bool {
        let authoredByViewer = message.fromAccountId == accountId
        if authoredByViewer && !allowSelfAuthoredAgent { return false }
        if let sequence = message.conversationSequence,
           let member = conversation?.members.first(where: {
               $0.accountId == accountId && $0.membershipState == "active"
           }) {
            return sequence > member.lastReadSequence
        }
        if authoredByViewer { return false }
        return message.toAccountId == accountId
            && message.direction == "incoming"
            && message.readAt == nil
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
            let isAgentSession = conversation.kind != "group" && (
                conversation.kind == "ai"
                || sessionId.hasPrefix("session:self-agent:")
                || sessionId.hasPrefix("session:direct-agent:")
                || sessionId.hasPrefix("session:fork:")
            )
            guard isAgentSession, !sessionId.hasPrefix("draft:") else { return nil }

            let rows = CloudAgentLifecycleProjector.visibleRows(
                messages.filter { ($0.sessionId?.nonEmpty ?? "") == sessionId }
            )
            let conversationalRows = rows.filter {
                !CloudMessageCodec.isAgentModelChange($0)
                    && $0.messageKind != CloudMessageCodec.agentSessionIdentityMessageKind
            }
            let requests = rows.compactMap { message -> CloudMessageCodec.DirectEnvelope? in
                CloudMessageCodec.directEnvelope(message.body)
            }
            let titleDefinition = agentDefinition(
                matchingTitlesIn: conversation,
                agentsById: agentsById
            )
            let targetId = requests.compactMap { $0.targetCloudAgentId?.nonEmpty }.last
                ?? knownAgentId(from: sessionId, agentsById: agentsById)
                ?? titleDefinition?.agentId
            let definition = targetId.flatMap { agentsById[$0] } ?? titleDefinition
            let otherMember = conversation.members.first {
                $0.accountId != account.accountId && $0.membershipState == "active"
            }
            let peerAccountId = requests.compactMap { $0.targetCloudAgentOwnerAccountId?.nonEmpty }.last
                ?? definition?.ownerAccountId
                ?? otherMember?.accountId
                ?? account.accountId
            let defaultAgent = peerAccountId == account.accountId
                ? account.defaultAgent
                : contactsById[peerAccountId]?.defaultAgent
            let memberAgentName = otherMember?.defaultAgentDisplayName?.nonEmpty
            let memberAgentId = otherMember?.defaultAgentId?.nonEmpty
            let resolvedTargetId = targetId ?? defaultAgent?.agentId ?? memberAgentId
            let agentName = requests.compactMap { $0.targetCloudAgentName?.nonEmpty }.last
                ?? definition?.name
                ?? defaultAgent?.displayName
                ?? memberAgentName
                ?? "Kordi"
            guard !KordiSupportIdentity.matches(name: agentName, seed: resolvedTargetId) else { return nil }
            let ownerName = requests.compactMap { $0.targetCloudAgentOwnerName?.nonEmpty }.last
                ?? (peerAccountId == account.accountId
                    ? account.preferredName
                    : contactsById[peerAccountId]?.preferredName ?? otherMember?.displayName)
            let firstPrompt = conversationalRows.first(where: { !CloudMessageCodec.isAgentResponse($0.body) })
                .map { CloudMessageCodec.displayText($0.body) }
            let latest = conversationalRows.last
            let title = nonGenericTitle(conversation.preferences.personalTitle)
                ?? nonGenericTitle(conversation.sharedTitle)
                ?? sessionTitle(firstPrompt)
                ?? agentName
            return ConversationSummary(
                id: "agent-session:\(sessionId)",
                kind: .agent,
                peerAccountId: peerAccountId,
                agentId: resolvedTargetId,
                ownerDisplayName: ownerName,
                displayName: title,
                lastMessage: latest.map { CloudMessageCodec.previewText($0) }
                    ?? definition?.description?.nonEmpty
                    ?? "No messages yet",
                lastAttachment: previewAttachment(latest),
                lastActivityAt: max(
                    latest.map { parseCloudDate($0.createdAt) } ?? .distantPast,
                    parseCloudDate(conversation.updatedAt)
                ),
                unreadCount: unreadAgentResponseCount(
                    conversationalRows,
                    conversation: conversation,
                    accountId: account.accountId
                ),
                avatarSource: definition?.avatar.imageSource
                    ?? defaultAgent?.avatar.imageSource
                    ?? otherMember?.defaultAgentAvatarUrl?.nonEmpty,
                agentActivity: CloudAgentLifecycleProjector.activity(in: conversationalRows),
                sessionId: sessionId,
                agentDisplayName: agentName,
                messageCount: Int(clamping: conversation.latestMessageSequence),
                forkedFromSessionId: conversation.forkedFromSessionId?.nonEmpty
                    ?? sessionForksById[sessionId]?.parentSessionId.nonEmpty,
                unreadMentionCount: unreadMentionMessageIDs(
                    conversationalRows.filter {
                        messageIsUnread(
                            $0,
                            conversation: conversation,
                            accountId: account.accountId,
                            allowSelfAuthoredAgent: false
                        )
                    },
                    accountId: account.accountId
                ).count,
                lastReadSequence: lastReadSequence(
                    in: conversation,
                    accountId: account.accountId
                )
            )
        }
    }

    private static func unreadMentionMessageIDs(
        _ messages: [CloudMessageDTO],
        accountId: String
    ) -> Set<String> {
        Set(messages.compactMap { message in
            guard message.fromAccountId != accountId,
                  containsVerifiedPersonMention(message, accountId: accountId) else {
                return nil
            }
            return message.messageId
        })
    }

    private static func containsVerifiedPersonMention(
        _ message: CloudMessageDTO,
        accountId: String,
        groupSessionId: String? = nil
    ) -> Bool {
        CloudMessageCodec.mentions(in: message).contains {
            $0.targetsPerson(
                accountId: accountId,
                groupSessionId: groupSessionId
            )
        }
    }

    private static func lastReadSequence(
        in conversation: CloudChatConversation?,
        accountId: String
    ) -> Int64 {
        conversation?.members.first {
            $0.accountId == accountId && $0.membershipState == "active"
        }?.lastReadSequence ?? 0
    }

    private static func isKordiSupport(agent: CloudAgent) -> Bool {
        KordiSupportIdentity.matches(name: agent.name, seed: agent.agentId)
            || KordiSupportIdentity.matches(name: agent.ownerDisplayName, seed: agent.ownerAccountId)
    }

    private static func defaultAgentConversation(account: CloudAccount, now: Date) -> ConversationSummary {
        let sessionId = defaultSelfAgentSessionId(account.accountId)
        let agentName = account.defaultAgent?.displayName.nonEmpty ?? "Kordi"
        return ConversationSummary(
            id: "agent-template:\(sessionId)",
            kind: .agent,
            peerAccountId: account.accountId,
            agentId: account.defaultAgent?.agentId.nonEmpty ?? "cloud-agent:\(account.accountId)",
            ownerDisplayName: account.preferredName,
            displayName: agentName,
            lastMessage: "Your private cloud agent",
            lastActivityAt: now,
            unreadCount: 0,
            avatarSource: account.defaultAgent?.avatar.imageSource,
            agentActivity: .ready,
            sessionId: sessionId,
            agentDisplayName: agentName
        )
    }

    private static func defaultConversation(for agent: CloudAgent, account: CloudAccount) -> ConversationSummary {
        let owned = agent.ownerAccountId == account.accountId
        let sessionPrefix = owned ? "session:self-agent:" : "session:direct-agent:\(agent.ownerAccountId):"
        return ConversationSummary(
            id: "agent-template:\(sessionPrefix)\(agent.agentId)",
            kind: .agent,
            peerAccountId: agent.ownerAccountId,
            agentId: agent.agentId,
            ownerDisplayName: owned ? account.preferredName : agent.ownerDisplayName,
            displayName: agent.name,
            lastMessage: agent.description?.nonEmpty ?? agent.role,
            lastActivityAt: parseCloudDate(agent.updatedAt),
            unreadCount: 0,
            avatarSource: agent.avatar.imageSource,
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
                agentId: participant.agentId?.nonEmpty ?? previous?.agentId,
                agentDisplayName: participant.agentDisplayName?.nonEmpty ?? previous?.agentDisplayName,
                agentAvatarUrl: participant.agentAvatarUrl?.nonEmpty ?? previous?.agentAvatarUrl,
                role: participant.role?.nonEmpty ?? previous?.role,
                joinedAt: participant.joinedAt?.nonEmpty ?? previous?.joinedAt
            )
        }
        return byId.values.sorted(by: CloudGroupParticipant.canonicalPrecedes)
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
                    avatarUrl: account.avatar.imageSource,
                    agentId: account.defaultAgent?.agentId,
                    agentDisplayName: account.defaultAgent?.displayName,
                    agentAvatarUrl: account.defaultAgent?.avatar.imageSource,
                    role: participant.role,
                    joinedAt: participant.joinedAt
                )
            }
            guard let contact = contactsById[participant.accountId] else { return participant }
            return CloudGroupParticipant(
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
                agentId: participant.agentId?.nonEmpty ?? previous?.agentId,
                agentDisplayName: participant.agentDisplayName?.nonEmpty ?? previous?.agentDisplayName,
                agentAvatarUrl: participant.agentAvatarUrl?.nonEmpty ?? previous?.agentAvatarUrl,
                role: participant.role?.nonEmpty ?? previous?.role,
                joinedAt: participant.joinedAt?.nonEmpty ?? previous?.joinedAt
            )
        }
        return byAccountId.values.sorted(by: CloudGroupParticipant.canonicalPrecedes)
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

    private static func previewAttachment(_ message: CloudMessageDTO?) -> ChatAttachment? {
        guard let message else { return nil }
        return message.attachments
            .first(where: { $0.inferredChatAttachmentKind == .image })?
            .chatAttachment(messageKind: CloudMessageCodec.canonicalMessageKind(message))
    }

    private static func previewAttachment(_ message: CloudGroupMessagePayload?) -> ChatAttachment? {
        guard let message else { return nil }
        return message.attachments?
            .first(where: { $0.inferredChatAttachmentKind == .image })?
            .chatAttachment(messageKind: message.messageKind)
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

    private static func agentDefinition(
        matchingTitlesIn conversation: CloudChatConversation,
        agentsById: [String: CloudAgent]
    ) -> CloudAgent? {
        let titles = [
            conversation.preferences.personalTitle?.nonEmpty,
            conversation.sharedTitle?.nonEmpty,
        ].compactMap { $0 }
        guard !titles.isEmpty else { return nil }
        let matches = agentsById.values.filter { agent in
            titles.contains {
                $0.localizedCaseInsensitiveCompare(agent.name) == .orderedSame
            }
        }
        return matches.count == 1 ? matches[0] : nil
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

func defaultSelfAgentSessionId(_ accountId: String) -> String {
    "session:self-agent:\(accountId):default"
}

func parseCloudDate(_ value: String) -> Date {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) ?? .distantPast
}
