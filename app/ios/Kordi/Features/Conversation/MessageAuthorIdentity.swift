import Foundation

struct ConversationAvatarIdentity: Hashable {
    let name: String
    let source: String?
    let seed: String?
}

/// The name, picture, and avatar seed shown beside a timeline message.
enum MessageAuthorIdentity {
    static func resolve(
        _ message: ChatMessage,
        in conversation: ConversationSummary,
        account: CloudAccount?,
        mentionTargets: [ComposerMentionTarget]
    ) -> ConversationAvatarIdentity {
        if message.author == .me {
            let participant = conversation.groupParticipants.first {
                $0.accountId == account?.accountId || $0.role == "self"
            }
            return ConversationAvatarIdentity(
                name: account?.preferredName.nonEmpty
                    ?? participant?.displayName.nonEmpty
                    ?? message.authorName,
                source: account?.avatar.imageSource ?? participant?.avatarUrl?.nonEmpty,
                seed: account?.avatar.seed.nonEmpty ?? participant?.accountId.nonEmpty
            )
        }

        if KordiSystemIdentity.isSystemNotice(message) { return KordiSystemIdentity.avatar }

        // In an agent session the conversation is the agent itself; anywhere
        // else the conversation title and picture belong to someone else.
        let isAgentInSharedSpace = message.author == .agent && conversation.kind != .agent
        let participant = isAgentInSharedSpace ? nil : conversation.groupParticipants.first {
            $0.displayName.localizedCaseInsensitiveCompare(message.authorName) == .orderedSame
        }
        // The plan agent posts in the chat without being a member, so it is
        // never in groupParticipants; it shows as System, not as the group.
        if participant == nil, conversation.kind == .group,
           KordiPipIdentity.isPipName(message.authorName) || message.authorName == KordiSystemIdentity.displayName {
            return KordiSystemIdentity.avatar
        }
        if isAgentInSharedSpace {
            return agent(message, participants: conversation.groupParticipants,
                         ownAccountId: account?.accountId, mentionTargets: mentionTargets)
        }
        return ConversationAvatarIdentity(
            name: participant?.displayName.nonEmpty
                ?? conversation.displayName.nonEmpty
                ?? message.authorName,
            source: participant?.avatarUrl?.nonEmpty ?? conversation.avatarSource?.nonEmpty,
            seed: participant?.accountId.nonEmpty ?? conversation.peerAccountId.nonEmpty
        )
    }

    /// An agent reply keeps the agent's own name; its picture comes from the
    /// agent directory for this conversation, matched by name and owner.
    static func agent(
        _ message: ChatMessage,
        participants: [CloudGroupParticipant],
        ownAccountId: String?,
        mentionTargets: [ComposerMentionTarget]
    ) -> ConversationAvatarIdentity {
        let name = message.authorName
        let ownerAccountId = message.senderOwnerName == "You" ? ownAccountId?.nonEmpty : nil
        let ownerName = ownerAccountId == nil ? message.senderOwnerName?.nonEmpty : nil
        func isOwner(accountId: String, name: String?) -> Bool {
            if let ownerAccountId { return accountId == ownerAccountId }
            if let ownerName { return sameName(name, ownerName) }
            return true
        }
        func pick<T>(_ candidates: [T], _ owned: (T) -> Bool) -> T? {
            candidates.first(where: owned) ?? (candidates.count == 1 ? candidates.first : nil)
        }

        let targets = mentionTargets.filter { $0.kind == .agent && sameName($0.displayName, name) }
        if let target = pick(targets, { isOwner(accountId: $0.accountId, name: $0.ownerName) }) {
            return ConversationAvatarIdentity(
                name: name,
                source: target.avatarSource?.nonEmpty,
                seed: CanonicalAvatarSystem.agentID(target.agentId, ownerAccountID: target.accountId)
            )
        }
        let members = participants.filter { sameName($0.agentDisplayName, name) }
        if let member = pick(members, { isOwner(accountId: $0.accountId, name: $0.displayName) }) {
            return ConversationAvatarIdentity(
                name: name,
                source: member.agentAvatarUrl?.nonEmpty,
                seed: CanonicalAvatarSystem.agentID(member.agentId, ownerAccountID: member.accountId)
            )
        }
        return ConversationAvatarIdentity(name: name, source: nil, seed: name)
    }

    private static func sameName(_ lhs: String?, _ rhs: String) -> Bool {
        guard let lhs = lhs?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else { return false }
        return lhs.localizedCaseInsensitiveCompare(rhs.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
    }
}
