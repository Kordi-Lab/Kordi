import Foundation
import Observation

enum MessageForwardFilter: String, CaseIterable, Identifiable {
    case all = "All", people = "People", groups = "Groups", agents = "Agents"
    var id: Self { self }

    func includes(_ kind: ConversationKind) -> Bool {
        switch self {
        case .all: true
        case .people: kind == .person
        case .groups: kind == .group
        case .agents: kind == .agent
        }
    }
}

struct MessageForwardDestination: Identifiable {
    let conversation: ConversationSummary
    let parentLabel: String?
    let publicIdentity: String?
    let searchText: String
    var id: String { conversation.sessionId }
    var label: String { conversation.displayName }
    var kind: ConversationKind { conversation.kind }
    var typeLabel: String {
        switch kind {
        case .person: "Direct message"
        case .group: "Group chat"
        case .agent: "Agent chat"
        }
    }
    var context: String {
        [parentLabel, typeLabel, publicIdentity].compactMap { $0 }.joined(separator: " · ")
    }
    var path: String {
        [parentLabel, label, publicIdentity].compactMap { $0 }.joined(separator: " › ")
    }
}

enum MessageForwardCatalog {
    static func build(
        conversations: [ConversationSummary],
        contacts: [CloudContact],
        contactConversations: [ConversationSummary] = [],
        ownAccountID: String
    ) -> [MessageForwardDestination] {
        let spaces = GroupSpaceCatalog.build(conversations: conversations, ownAccountId: ownAccountID)
        var parentsBySession: [String: String] = [:]
        var parentsBySpace: [String: String] = [:]
        for space in spaces {
            for session in space.sessions { parentsBySession[session.sessionId] = space.displayName }
            if let id = normalizedGroupSpaceId(space.id) { parentsBySpace[id] = space.displayName }
        }
        let contactsByID = Dictionary(contacts.map { ($0.accountId, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        return (conversations + contactConversations).compactMap { conversation in
            guard !conversation.representsKordiSupport,
                  !conversation.isLocalDraft, !conversation.isAgentLaunchTemplate,
                  conversation.subsessionId == nil,
                  !conversation.sessionId.isEmpty,
                  seen.insert(conversation.sessionId).inserted else { return nil }
            let contact = contactsByID[conversation.peerAccountId]
            let groupName = parentsBySession[conversation.sessionId]
                ?? normalizedGroupSpaceId(conversation.groupSpaceId).flatMap { parentsBySpace[$0] }
            let contextName = groupName ?? (conversation.kind == .agent
                ? conversation.agentDisplayName?.nonEmpty ?? conversation.ownerDisplayName?.nonEmpty : nil)
            let parent = contextName == conversation.displayName ? nil : contextName
            let publicIdentity = conversation.kind == .person ? contact?.kordiId?.nonEmpty.map { "@\($0)" } : nil
            let searchText = ([conversation.displayName, parent, publicIdentity,
                               contact?.preferredName, conversation.agentDisplayName, conversation.ownerDisplayName]
                .compactMap { $0 } + conversation.groupParticipants.map(\.displayName)).joined(separator: " ")
            return MessageForwardDestination(conversation: conversation, parentLabel: parent,
                                             publicIdentity: publicIdentity, searchText: searchText)
        }.sorted {
            ChatListOrdering.precedes(id: $0.id, displayName: $0.label, lastActivityAt: $0.conversation.lastActivityAt,
                before: $1.id, displayName: $1.label, lastActivityAt: $1.conversation.lastActivityAt)
        }
    }

    static func filter(_ destinations: [MessageForwardDestination], query: String, kind: MessageForwardFilter) -> [MessageForwardDestination] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return destinations.filter { destination in
            kind.includes(destination.kind) && terms.allSatisfy { destination.searchText.localizedStandardContains($0) }
        }
    }
}

/// One sheet owns one batch, including stable operation IDs and its partial-delivery cursor.
@MainActor @Observable
final class MessageForwardBatch {
    private(set) var completedCount = 0
    private(set) var isSending = false
    private(set) var succeeded = false
    private(set) var errorMessage: String?
    private(set) var destinationID: String?
    private var sourceIDs: [String] = []
    private var operationIDs: [String] = []
    private var accountID: String?
    private var caption = ""

    func fail(_ message: String) { errorMessage = message }

    func run(
        sourceIDs: [String], destinationID: String, accountID: String, caption: String,
        send: (Int, String) async -> Bool
    ) async -> Bool {
        guard !isSending, !sourceIDs.isEmpty else { return false }
        if let lockedDestination = self.destinationID {
            guard lockedDestination == destinationID, self.accountID == accountID,
                  self.sourceIDs == sourceIDs, self.caption == caption else {
                errorMessage = "Close this sheet and start forwarding again."
                return false
            }
        } else {
            self.destinationID = destinationID
            self.accountID = accountID
            self.sourceIDs = sourceIDs
            self.caption = caption
            operationIDs = sourceIDs.map { _ in UUID().uuidString.lowercased() }
        }
        if succeeded { return true }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        for index in completedCount..<sourceIDs.count {
            guard !Task.isCancelled, await send(index, operationIDs[index]) else {
                errorMessage = "Couldn’t finish forwarding. Try again to continue with the remaining messages."
                return false
            }
            completedCount = index + 1
        }
        succeeded = true
        return true
    }
}
