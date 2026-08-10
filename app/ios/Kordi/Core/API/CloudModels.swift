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

    static let empty = CloudModelRouting()
}

struct CloudAgent: Codable, Hashable, Identifiable {
    let agentId: String
    let ownerAccountId: String
    let accessScope: String
    let status: String?
    let name: String
    let role: String
    let description: String?
    let updatedAt: String
    let ownerDisplayName: String?
    let avatarUrl: String?
    let modelRouting: CloudModelRouting

    var id: String { agentId }

    enum CodingKeys: String, CodingKey {
        case agentId, ownerAccountId, accessScope, status, name, role, description, updatedAt, ownerDisplayName, avatarUrl, modelRouting
    }

    init(
        agentId: String,
        ownerAccountId: String,
        accessScope: String,
        status: String?,
        name: String,
        role: String,
        description: String?,
        updatedAt: String,
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
        self.updatedAt = updatedAt
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
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
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
