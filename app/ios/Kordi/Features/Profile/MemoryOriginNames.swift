import Foundation

/// The origin label of a memory on Account › Memory: "Global", the chat
/// title, the project name or the group name. Titles come from what the app
/// already loaded; unknown scopes fall back to the memory's `scopeLabel`.
struct MemoryOriginNames: Equatable {
    static let global = "Global"
    static let chat = "Chat"
    static let project = "Project"
    static let group = "Group"

    /// Conversation session and subsession ids to chat titles.
    var conversationTitles: [String: String] = [:]
    /// Group ids (cloud conversation id, group space id, group session id
    /// with and without `session:group:`) to group titles.
    var groupTitles: [String: String] = [:]

    init(conversationTitles: [String: String] = [:], groupTitles: [String: String] = [:]) {
        self.conversationTitles = conversationTitles
        self.groupTitles = groupTitles
    }

    init(conversations: [ConversationSummary], cloudConversations: [CloudChatConversation] = []) {
        var groupBySession: [String: String] = [:]
        for conversation in conversations {
            if conversation.kind == .group {
                guard let title = (conversation.ownerDisplayName?.originName ?? conversation.displayName.originName) else { continue }
                var ids = [conversation.sessionId, conversation.groupSpaceId ?? ""]
                if conversation.sessionId.hasPrefix(MemoryPresentation.groupSessionPrefix) {
                    ids.append(String(conversation.sessionId.dropFirst(MemoryPresentation.groupSessionPrefix.count)))
                }
                for id in ids.compactMap(\.originName) where groupTitles[id] == nil { groupTitles[id] = title }
                groupBySession[conversation.sessionId] = title
                conversationTitles[conversation.sessionId] = conversationTitles[conversation.sessionId] ?? title
            } else if let title = conversation.displayName.originName {
                for id in [conversation.sessionId, conversation.subsessionId ?? ""].compactMap(\.originName)
                where conversationTitles[id] == nil {
                    conversationTitles[id] = title
                }
            }
        }
        // Group memories are saved under the cloud group conversation id.
        for cloud in cloudConversations where cloud.kind == "group" {
            let title = cloud.groupTitle?.originName ?? cloud.sharedTitle?.originName
                ?? cloud.legacySessionId.flatMap { groupBySession[$0] }
            if let title, groupTitles[cloud.id] == nil { groupTitles[cloud.id] = title }
        }
    }

    /// The label shown on the row and on the From filter chip.
    func name(for memory: CloudMemory) -> String {
        let label = memory.scopeLabel?.originName
        switch memory.scope {
        case .global:
            return Self.global
        case .conversation:
            return conversationTitles[memory.scopeId] ?? label ?? Self.chat
        case .group:
            return groupTitles[memory.scopeId] ?? label ?? Self.group
        case .project:
            // Projects are labelled by their folder; the last path component is the project name.
            guard let label else { return Self.project }
            return label.split(separator: "/").last.map(String.init)?.originName ?? label
        case .other:
            return label ?? Self.chat
        }
    }

    /// What the From filter matches on: one origin, even when two share a name.
    static func key(for memory: CloudMemory) -> String {
        memory.scope == .global ? "global" : "\(memory.scope.rawValue):\(memory.scopeId)"
    }
}

private extension String {
    var originName: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
