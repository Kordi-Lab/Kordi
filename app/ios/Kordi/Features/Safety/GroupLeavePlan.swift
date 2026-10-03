import Foundation

/// The decisions behind leaving a group, kept free of networking so they can
/// be tested: who takes over from a leaving owner, what the leave envelope
/// lists, which conversations the server leave is called on, and which
/// failures stop the leave.
enum GroupLeavePlan {
    static let errorMessage = "Couldn't leave the group. Check your connection and try again."
    static let unavailableMessage = "Leaving groups isn't available yet. Try again after Kordi updates."

    /// Kordi service accounts never take over a group and are never left
    /// out of it by a leave.
    static func isServiceAccount(_ accountId: String) -> Bool {
        KordiPipIdentity.isPip(accountId: accountId) || accountId == KordiSupportIdentity.accountId
    }

    private static func isManager(_ participant: CloudGroupParticipant) -> Bool {
        ["owner", "admin"].contains(participant.role?.lowercased() ?? "")
    }

    /// People who could take over: the server's active members of the
    /// group's main conversation when known (with their server roles and
    /// join times), else the group's known participants. Names come from the
    /// participants, which already carry contact names.
    static func candidates(
        rootMembers: [CloudChatMember]?,
        participants: [CloudGroupParticipant]
    ) -> [CloudGroupParticipant] {
        guard let rootMembers, !rootMembers.isEmpty else { return participants }
        let namesById = Dictionary(
            participants.map { ($0.accountId, $0.displayName) },
            uniquingKeysWith: { first, _ in first }
        )
        return rootMembers
            .filter { $0.membershipState == "active" }
            .map { member in
                CloudGroupParticipant(
                    accountId: member.accountId,
                    displayName: namesById[member.accountId]?.nonEmpty
                        ?? member.displayName?.nonEmpty
                        ?? "Kordi user",
                    avatarUrl: member.avatarUrl,
                    role: member.role,
                    joinedAt: member.joinedAt
                )
            }
    }

    /// Whether the leaver owns the group, from the server role when known.
    static func leaverIsOwner(
        rootMembers: [CloudChatMember]?,
        participants: [CloudGroupParticipant],
        leaverAccountId: String
    ) -> Bool {
        if let member = rootMembers?.first(where: { $0.accountId == leaverAccountId }) {
            return member.role.lowercased() == "owner"
        }
        return participants.first { $0.accountId == leaverAccountId }?.role?.lowercased() == "owner"
    }

    /// Another owner stays the owner. Otherwise the earliest-joined admin,
    /// else the earliest-joined member: the order the server uses when the
    /// suggestion is not usable. Never the leaver or a service account.
    static func successor(
        among candidates: [CloudGroupParticipant],
        leaverAccountId: String
    ) -> CloudGroupParticipant? {
        let ordered = candidates
            .filter { !$0.accountId.isEmpty && $0.accountId != leaverAccountId && !isServiceAccount($0.accountId) }
            .sorted(by: CloudGroupParticipant.canonicalPrecedes)
        return ordered.first { $0.role?.lowercased() == "owner" }
            ?? ordered.first(where: isManager)
            ?? ordered.first
    }

    /// Everyone but the leaver. A successor is listed as admin so clients
    /// that apply envelope roles show them the admin controls.
    static func envelopeParticipants(
        _ participants: [CloudGroupParticipant],
        leaverAccountId: String,
        successorAccountId: String?
    ) -> [CloudGroupParticipant] {
        participants
            .filter { $0.accountId != leaverAccountId && !$0.accountId.isEmpty }
            .map { participant in
                guard participant.accountId == successorAccountId, !isManager(participant) else { return participant }
                return CloudGroupParticipant(
                    accountId: participant.accountId,
                    displayName: participant.displayName,
                    avatarUrl: participant.avatarUrl,
                    agentId: participant.agentId,
                    agentDisplayName: participant.agentDisplayName,
                    agentAvatarUrl: participant.agentAvatarUrl,
                    role: "admin",
                    joinedAt: participant.joinedAt
                )
            }
    }

    /// The group's main conversation when it is known; leaving it leaves
    /// every channel.
    static func rootConversation(
        spaceRootId: String,
        canonical: [CloudChatConversation]
    ) -> CloudChatConversation? {
        canonical.first { conversation in
            conversation.kind == "group"
                && (conversation.legacySessionId?.nonEmpty == spaceRootId || conversation.id == spaceRootId)
        }
    }

    /// Where to call the server leave: once on the main conversation, else
    /// on each channel the server knows.
    static func leaveSessionIds(
        spaceRootId: String,
        membershipSessionIds: [String],
        canonical: [CloudChatConversation]
    ) -> [String] {
        if let root = rootConversation(spaceRootId: spaceRootId, canonical: canonical) {
            return [root.legacySessionId?.nonEmpty ?? root.id]
        }
        let known = Set(canonical.filter { $0.kind == "group" }.flatMap { conversation in
            [conversation.id, conversation.legacySessionId?.nonEmpty].compactMap { $0 }
        })
        var seen = Set<String>()
        return membershipSessionIds.filter { known.contains($0) && seen.insert($0).inserted }
    }

    /// A leave envelope that could not be delivered stops the leave before
    /// anything changes. A refusal (for example a member list the server
    /// does not accept from this person) does not.
    static func envelopeFailureStopsLeave(_ error: Error) -> Bool {
        if CloudTransportErrorPolicy.isCancellation(error) { return true }
        guard let error = error as? CloudAPIError else { return true }
        return error.isRetryableDelivery
    }

    /// The server has no membership left to end, so only this device needs
    /// updating.
    static func isAlreadyGone(_ error: Error) -> Bool {
        guard let error = error as? CloudAPIError else { return false }
        return ["CHAT_ENTITY_NOT_FOUND", "CHAT_FORBIDDEN", "chat_conversation_missing"].contains(error.code)
    }

    /// The navigation path after leaving: screens for the group's
    /// conversations close, together with anything opened on top of them.
    static func navigationPath(
        _ path: [MainNavigationRoute],
        afterLeaving sessionIds: Set<String>
    ) -> [MainNavigationRoute] {
        guard !sessionIds.isEmpty,
              let first = path.firstIndex(where: { route in
                  route.conversationSessionId.map(sessionIds.contains) ?? false
              }) else { return path }
        return Array(path[..<first])
    }

    static func confirmationMessage(isOwner: Bool, successorName: String?) -> String {
        let body = "You'll stop getting messages from this group and all of its channels, "
            + "and it will be removed from your devices. To come back, you'll need an invite "
            + "link from someone in the group."
        guard isOwner else { return body }
        return body + " You're the group owner, so \(successorName?.nonEmpty ?? "another member") will become the owner."
    }
}

private extension MainNavigationRoute {
    var conversationSessionId: String? {
        switch self {
        case .conversation(let conversation), .sessionDetails(let conversation):
            conversation.sessionId
        case .message(let route):
            route.conversation.sessionId
        case .newChat, .archived:
            nil
        }
    }
}
