import Foundation

enum CloudOAuthProvider: String, CaseIterable, Codable, Hashable, Identifiable {
    case google
    case github

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .google: "Google"
        case .github: "GitHub"
        }
    }
}

struct CloudOAuthStartResponse: Codable, Hashable {
    let authUrl: String
}

struct CloudAccount: Codable, Hashable {
    let accountId: String
    let kordiId: String?
    let displayName: String?
    let primaryEmail: String?
    let avatarUrl: String?
    let nodeId: String?
    let passwordSet: Bool

    var preferredName: String {
        displayName?.nonEmpty ?? primaryEmail?.nonEmpty ?? "Kordi user"
    }
}

struct CloudSession: Codable, Hashable {
    let token: String
    let expiresAt: String
}

struct CloudSessionPin: Codable, Hashable {
    let sessionId: String
    let sharedMessageId: String?
    let privateMessageId: String?
    let effectiveMessageId: String?
    let updatedAt: String?
}

struct CloudAuthResponse: Codable, Hashable {
    let account: CloudAccount
    let session: CloudSession
}

struct CloudContact: Codable, Hashable, Identifiable {
    let accountId: String
    let kordiId: String?
    let displayName: String?
    let avatarUrl: String?
    let nodeId: String?
    let createdAt: String

    var id: String { accountId }
    var preferredName: String { displayName?.nonEmpty ?? kordiId?.nonEmpty ?? "Kordi user" }
}

struct CloudPublicProfile: Codable, Hashable {
    let accountId: String
    let kordiId: String
    let displayName: String?
    let avatarUrl: String?
    let nodeId: String?
    let isContact: Bool
    let isSelf: Bool

    var preferredName: String { displayName?.nonEmpty ?? kordiId }
}

struct CloudContactRequest: Codable, Hashable, Identifiable {
    let requestId: String
    let fromAccountId: String
    let toAccountId: String
    let status: String
    let direction: String
    let message: String?
    let createdAt: String
    let decidedAt: String?
    let counterpart: CloudContact?

    var id: String { requestId }
    var isIncoming: Bool { direction == "incoming" }
}

struct CloudModelRouting: Codable, Hashable {
    var defaultModel: String?
    var defaultAuthProvider: String?
    var defaultAuthChoice: String?
    var fallbackModel: String?
    var fallbackAuthProvider: String?
    var fallbackAuthChoice: String?
    var thinking: String?
    var tools: [String]?
    var plugins: [String]?

    static let empty = CloudModelRouting()
}

enum CloudAgentAccessScope: String, CaseIterable, Codable, Hashable, Identifiable {
    case privateAgent = "private"
    case participantConversations = "participant_conversations"

    var id: Self { self }

    var label: String {
        switch self {
        case .privateAgent:
            "Only me"
        case .participantConversations:
            "People in my chats can mention it"
        }
    }
}

struct CloudAgentResource: Codable, Hashable {
    let kind: String
    let value: String
    let title: String?
    let summary: String?
}

struct CloudAgentSkill: Codable, Hashable {
    let name: String
    let description: String
    let content: String?

    init(name: String, description: String, content: String? = nil) {
        self.name = name
        self.description = description
        self.content = content
    }
}

struct CloudAgentBoundaryDraft: Identifiable, Equatable {
    let id: UUID
    var value: String

    init(id: UUID = UUID(), value: String = "") {
        self.id = id
        self.value = value
    }
}

struct CloudAgentResourceDraft: Identifiable, Equatable {
    let id: UUID
    var kind: String
    var value: String
    var title: String
    var summary: String

    init(
        id: UUID = UUID(),
        kind: String = "text",
        value: String = "",
        title: String = "",
        summary: String = ""
    ) {
        self.id = id
        self.kind = kind
        self.value = value
        self.title = title
        self.summary = summary
    }

    init(resource: CloudAgentResource) {
        self.init(
            kind: resource.kind,
            value: resource.value,
            title: resource.title ?? "",
            summary: resource.summary ?? ""
        )
    }
}

struct CloudAgentSkillDraft: Identifiable, Equatable {
    let id: UUID
    var name: String
    var description: String
    var content: String

    init(id: UUID = UUID(), name: String = "", description: String = "", content: String = "") {
        self.id = id
        self.name = name
        self.description = description
        self.content = content
    }

    init(skill: CloudAgentSkill) {
        self.init(name: skill.name, description: skill.description, content: skill.content ?? "")
    }
}

struct CloudAgentCapabilityDraft: Identifiable, Equatable {
    let id: UUID
    var name: String

    init(id: UUID = UUID(), name: String = "") {
        self.id = id
        self.name = name
    }
}

struct CloudAgentDraft: Equatable {
    var accessScope = CloudAgentAccessScope.privateAgent
    var name = ""
    var role = ""
    var description = ""
    var systemPrompt = ""
    var sourceSummary = ""
    var boundaries: [CloudAgentBoundaryDraft] = []
    var resources: [CloudAgentResourceDraft] = []
    var skills: [CloudAgentSkillDraft] = []
    var tools: [CloudAgentCapabilityDraft] = []
    var plugins: [CloudAgentCapabilityDraft] = []
    var modelRouting = CloudModelRouting.empty

    init() {}

    init(agent: CloudAgent) {
        accessScope = CloudAgentAccessScope(rawValue: agent.accessScope) ?? .privateAgent
        name = agent.name
        role = agent.role
        description = agent.description ?? ""
        systemPrompt = agent.systemPrompt
        sourceSummary = agent.sourceSummary ?? ""
        boundaries = agent.boundaries.map { CloudAgentBoundaryDraft(value: $0) }
        resources = agent.resources.map(CloudAgentResourceDraft.init(resource:))
        skills = agent.skills.map(CloudAgentSkillDraft.init(skill:))
        tools = (agent.modelRouting.tools ?? []).map { CloudAgentCapabilityDraft(name: $0) }
        plugins = (agent.modelRouting.plugins ?? []).map { CloudAgentCapabilityDraft(name: $0) }
        var routing = agent.modelRouting
        routing.tools = nil
        routing.plugins = nil
        modelRouting = routing
    }

    var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Agent name is required."
        }
        if role.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Agent role is required."
        }
        if systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "System prompt is required."
        }
        if boundaries.contains(where: { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return "Complete or delete each empty boundary."
        }
        if resources.contains(where: {
            $0.kind.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) {
            return "Each resource needs a type and source."
        }
        if skills.contains(where: {
            $0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || $0.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) {
            return "Each skill needs a name and description."
        }
        if tools.contains(where: { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return "Complete or delete each empty tool."
        }
        if plugins.contains(where: { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return "Complete or delete each empty plugin."
        }
        return nil
    }

    var isValid: Bool { validationMessage == nil }
}

struct CloudAgent: Codable, Hashable, Identifiable {
    let agentId: String
    let ownerAccountId: String
    let accessScope: String
    let status: String?
    let name: String
    let role: String
    let description: String?
    let systemPrompt: String
    let sourceSummary: String?
    let boundaries: [String]
    let resources: [CloudAgentResource]
    let skills: [CloudAgentSkill]
    let updatedAt: String
    let createdAt: String?
    let archivedAt: String?
    let ownerDisplayName: String?
    let avatarUrl: String?
    let modelRouting: CloudModelRouting

    var id: String { agentId }

    enum CodingKeys: String, CodingKey {
        case agentId, ownerAccountId, accessScope, status, name, role, description
        case systemPrompt, sourceSummary, boundaries, resources, skills
        case createdAt, updatedAt, archivedAt, ownerDisplayName, avatarUrl, modelRouting
    }

    init(
        agentId: String,
        ownerAccountId: String,
        accessScope: String,
        status: String?,
        name: String,
        role: String,
        description: String?,
        systemPrompt: String = "",
        sourceSummary: String? = nil,
        boundaries: [String] = [],
        resources: [CloudAgentResource] = [],
        skills: [CloudAgentSkill] = [],
        updatedAt: String,
        createdAt: String? = nil,
        archivedAt: String? = nil,
        ownerDisplayName: String?,
        avatarUrl: String? = nil,
        modelRouting: CloudModelRouting = .empty
    ) {
        self.agentId = agentId
        self.ownerAccountId = ownerAccountId
        self.accessScope = accessScope
        self.status = status
        self.name = name
        self.role = role
        self.description = description
        self.systemPrompt = systemPrompt
        self.sourceSummary = sourceSummary
        self.boundaries = boundaries
        self.resources = resources
        self.skills = skills
        self.updatedAt = updatedAt
        self.createdAt = createdAt
        self.archivedAt = archivedAt
        self.ownerDisplayName = ownerDisplayName
        self.avatarUrl = avatarUrl
        self.modelRouting = modelRouting
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try container.decode(String.self, forKey: .agentId)
        ownerAccountId = try container.decode(String.self, forKey: .ownerAccountId)
        accessScope = try container.decode(String.self, forKey: .accessScope)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        systemPrompt = try container.decodeIfPresent(String.self, forKey: .systemPrompt) ?? ""
        sourceSummary = try container.decodeIfPresent(String.self, forKey: .sourceSummary)
        boundaries = try container.decodeIfPresent([String].self, forKey: .boundaries) ?? []
        resources = try container.decodeIfPresent([CloudAgentResource].self, forKey: .resources) ?? []
        skills = try container.decodeIfPresent([CloudAgentSkill].self, forKey: .skills) ?? []
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        archivedAt = try container.decodeIfPresent(String.self, forKey: .archivedAt)
        ownerDisplayName = try container.decodeIfPresent(String.self, forKey: .ownerDisplayName)
        avatarUrl = try container.decodeIfPresent(String.self, forKey: .avatarUrl)
        modelRouting = try container.decodeIfPresent(CloudModelRouting.self, forKey: .modelRouting) ?? .empty
    }
}

struct CloudProviderAuthSnapshot: Codable, Hashable {
    let snapshotId: String
    let provider: String
    let authChoice: String
    let createdAt: String
    let revokedAt: String?
}

struct CloudSessionTaskActivity: Codable, Hashable, Identifiable {
    let taskActivityId: String
    let sessionId: String
    let taskId: String
    let title: String
    let summary: String?
    let status: String
    let createdByAccountId: String
    let targetAccountId: String?
    let artifactIds: [String]
    let responseMessageId: String?
    let createdAt: String
    let updatedAt: String

    var id: String { taskActivityId }
}

struct CloudSessionArtifactActivity: Codable, Hashable, Identifiable {
    let artifactActivityId: String
    let sessionId: String
    let artifactId: String
    let name: String
    let path: String
    let kind: String
    let category: String
    let summary: String?
    let createdByAccountId: String
    let sourceMessageId: String?
    let attachmentId: String?
    let contentType: String?
    let sizeBytes: Int64?
    let createdAt: String
    let updatedAt: String

    var id: String { artifactActivityId }
}

struct CloudSessionActivity: Codable, Hashable {
    let tasks: [CloudSessionTaskActivity]
    let artifacts: [CloudSessionArtifactActivity]
}

struct CloudMessageAttachment: Codable, Hashable, Identifiable {
    let attachmentId: String
    let name: String
    let kind: String
    let mimeType: String?
    let sizeBytes: Int64?
    let downloadUrl: String?
    let previewUrl: String?

    var id: String { attachmentId }
}

struct CloudMessageDTO: Codable, Hashable, Identifiable {
    let messageId: String
    let fromAccountId: String
    let toAccountId: String
    let body: String
    let createdAt: String
    let deliveredAt: String?
    let readAt: String?
    let direction: String
    let sessionId: String?
    let attachments: [CloudMessageAttachment]

    var id: String { messageId }

    init(
        messageId: String,
        fromAccountId: String,
        toAccountId: String,
        body: String,
        createdAt: String,
        deliveredAt: String?,
        readAt: String?,
        direction: String,
        sessionId: String?,
        attachments: [CloudMessageAttachment] = []
    ) {
        self.messageId = messageId
        self.fromAccountId = fromAccountId
        self.toAccountId = toAccountId
        self.body = body
        self.createdAt = createdAt
        self.deliveredAt = deliveredAt
        self.readAt = readAt
        self.direction = direction
        self.sessionId = sessionId
        self.attachments = attachments
    }

    enum CodingKeys: String, CodingKey {
        case messageId, fromAccountId, toAccountId, body, createdAt, deliveredAt, readAt, direction, sessionId, attachments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try container.decode(String.self, forKey: .messageId)
        fromAccountId = try container.decode(String.self, forKey: .fromAccountId)
        toAccountId = try container.decode(String.self, forKey: .toAccountId)
        body = try container.decode(String.self, forKey: .body)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        deliveredAt = try container.decodeIfPresent(String.self, forKey: .deliveredAt)
        readAt = try container.decodeIfPresent(String.self, forKey: .readAt)
        direction = try container.decode(String.self, forKey: .direction)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        attachments = try container.decodeIfPresent([CloudMessageAttachment].self, forKey: .attachments) ?? []
    }
}

// MARK: - Canonical chat wire snapshots

struct CloudChatMember: Codable, Hashable {
    let accountId: String
    let displayName: String?
    let avatarUrl: String?
    let role: String
    let membershipState: String
    let version: Int
    let lastDeliveredSequence: Int64
    let lastReadSequence: Int64
    let joinedAt: String
    let leftAt: String?

    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case role
        case membershipState = "membership_state"
        case version
        case lastDeliveredSequence = "last_delivered_sequence"
        case lastReadSequence = "last_read_sequence"
        case joinedAt = "joined_at"
        case leftAt = "left_at"
    }
}

struct CloudChatPreferences: Codable, Hashable {
    let conversationId: String
    let accountId: String
    let personalTitle: String?
    let version: Int

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case accountId = "account_id"
        case personalTitle = "personal_title"
        case version
    }
}

struct CloudChatConversation: Codable, Hashable {
    let id: String
    let kind: String
    let sharedTitle: String?
    let version: Int
    let createdByAccountId: String
    let legacySessionId: String?
    let forkedFromSessionId: String?
    let forkedFromMessageId: String?
    let latestMessageSequence: Int64
    let createdAt: String
    let updatedAt: String
    let members: [CloudChatMember]
    let preferences: CloudChatPreferences

    enum CodingKeys: String, CodingKey {
        case id, kind, version, members, preferences
        case sharedTitle = "shared_title"
        case createdByAccountId = "created_by_account_id"
        case legacySessionId = "legacy_session_id"
        case forkedFromSessionId = "forked_from_session_id"
        case forkedFromMessageId = "forked_from_message_id"
        case latestMessageSequence = "latest_message_sequence"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct CloudChatTextBlock: Codable, Hashable {
    let type: String
    let text: String
}

struct CloudChatContent: Codable, Hashable {
    let schema: Int
    let blocks: [CloudChatTextBlock]
    let legacyAttachments: [CloudMessageAttachment]

    init(body: String, attachments: [CloudMessageAttachment]) {
        schema = 1
        blocks = [CloudChatTextBlock(type: "text", text: body)]
        legacyAttachments = attachments
    }

    enum CodingKeys: String, CodingKey {
        case schema, blocks
        case legacyAttachments = "legacy_attachments"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(Int.self, forKey: .schema)
        blocks = try container.decode([CloudChatTextBlock].self, forKey: .blocks)
        legacyAttachments = try container.decodeIfPresent([CloudMessageAttachment].self, forKey: .legacyAttachments) ?? []
    }

    var body: String { blocks.map(\.text).joined() }
}

struct CloudChatMessage: Codable, Hashable {
    let id: String
    let clientMessageId: String
    let conversationId: String
    let conversationSequence: Int64
    let senderAccountId: String
    let kind: String
    let content: CloudChatContent
    let replyToMessageId: String?
    let attachmentIds: [String]
    let version: Int
    let generationStatus: String?
    let providerResponseId: String?
    let createdAt: String
    let editedAt: String?
    let deletedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, content, version
        case clientMessageId = "client_message_id"
        case conversationId = "conversation_id"
        case conversationSequence = "conversation_sequence"
        case senderAccountId = "sender_account_id"
        case replyToMessageId = "reply_to_message_id"
        case attachmentIds = "attachment_ids"
        case generationStatus = "generation_status"
        case providerResponseId = "provider_response_id"
        case createdAt = "created_at"
        case editedAt = "edited_at"
        case deletedAt = "deleted_at"
    }
}

struct CloudChatCursor: Codable, Hashable {
    let conversationId: String
    let accountId: String
    let lastDeliveredSequence: Int64
    let lastReadSequence: Int64

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case accountId = "account_id"
        case lastDeliveredSequence = "last_delivered_sequence"
        case lastReadSequence = "last_read_sequence"
    }
}

struct CloudChatEventPayload: Codable, Hashable {
    let conversation: CloudChatConversation?
    let message: CloudChatMessage?
    let preferences: CloudChatPreferences?
    let cursor: CloudChatCursor?
    let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case conversation, message, preferences, cursor
        case sessionId = "sessionId"
    }
}

struct CloudChatEvent: Codable, Hashable {
    let streamSequence: Int64
    let eventId: String
    let protocolVersion: Int
    let eventType: String
    let critical: Bool
    let conversationId: String?
    let entityId: String?
    let entityVersion: Int?
    let occurredAt: String
    let payload: CloudChatEventPayload

    enum CodingKeys: String, CodingKey {
        case streamSequence = "stream_seq"
        case eventId = "event_id"
        case protocolVersion = "protocol_version"
        case eventType = "type"
        case critical
        case conversationId = "conversation_id"
        case entityId = "entity_id"
        case entityVersion = "entity_version"
        case occurredAt = "occurred_at"
        case payload
    }
}

struct CloudChatSyncResponse: Codable, Hashable {
    let protocolVersion: Int
    let events: [CloudChatEvent]
    let nextCursor: String
    let lastStreamSequence: Int64
    let hasMore: Bool
    let serverTime: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case events
        case nextCursor = "next_cursor"
        case lastStreamSequence = "last_stream_seq"
        case hasMore = "has_more"
        case serverTime = "server_time"
    }
}

struct CloudChatBootstrapResponse: Codable, Hashable {
    let protocolVersion: Int
    let conversations: [CloudChatConversation]
    let latestMessages: [CloudChatMessage]
    let nextCursor: String
    let lastStreamSequence: Int64
    let serverTime: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case conversations
        case latestMessages = "latest_messages"
        case nextCursor = "next_cursor"
        case lastStreamSequence = "last_stream_seq"
        case serverTime = "server_time"
    }
}

struct CloudSyncedSessionTitle: Codable, Hashable {
    let sessionId: String
    let title: String
}

struct CloudAgentRun: Codable, Hashable {
    let runId: String
    let status: String
    let sandboxId: String?
    let createdAt: String
    let updatedAt: String
}

struct CloudSyncResponse: Codable, Hashable {
    let cursor: String
    let hasMore: Bool
    let events: [CloudSyncEvent]
}

struct CloudSessionVisibility: Codable, Hashable {
    let hiddenSessionIds: [String]
    let deletedSessionIds: [String]
}

struct CloudSessionForkSummary: Codable, Hashable {
    let forkSessionId: String
    let parentSessionId: String
    let parentMessageId: String?
    let createdByAccountId: String
    let createdAt: String
}

struct CloudSyncEvent: Codable, Hashable {
    let eventId: String
    let eventType: String
    let peerAccountId: String?
    let messageId: String?
    let payload: CloudSyncEventPayload?
    let occurredAt: String
}

struct CloudSyncEventPayload: Codable, Hashable {
    let message: CloudMessageDTO?
    let messageIds: [String]?
    let readAt: String?
    let sessionId: String?
    let forkSessionId: String?
    let parentSessionId: String?
    let parentMessageId: String?
    let createdByAccountId: String?
    let createdAt: String?
    let sessionTitle: CloudSyncedSessionTitle?
}

extension Optional where Wrapped == String {
    var nonEmpty: String? {
        guard let value = self?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

extension String {
    var nonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
