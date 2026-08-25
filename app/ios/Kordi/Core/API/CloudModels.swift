import Foundation

struct CanonicalAvatarDescriptor: Codable, Hashable {
    let entityType: String
    let entityId: String
    let source: String
    let style: String
    let seed: String
    let rendererVersion: String
    let uploadedAsset: String?
    let version: Int64
    let updatedAt: String

    var imageSource: String? {
        source == "uploaded"
            ? uploadedAsset?.nonEmpty
            : CanonicalAvatarSystem.marker(style: style, seed: seed, version: version)
    }
}

struct CanonicalAvatarMutation: Codable, Hashable {
    let action: String
    let uploadedAsset: String?
    let seed: String?
    let expectedVersion: Int64?

    static func upload(_ dataURL: String, expectedVersion: Int64?) -> Self {
        Self(action: "upload", uploadedAsset: dataURL, seed: nil, expectedVersion: expectedVersion)
    }

    static func regenerate(seed: String, expectedVersion: Int64?) -> Self {
        Self(action: "regenerate", uploadedAsset: nil, seed: seed, expectedVersion: expectedVersion)
    }

    static func removeUpload(expectedVersion: Int64?) -> Self {
        Self(action: "remove_upload", uploadedAsset: nil, seed: nil, expectedVersion: expectedVersion)
    }
}

enum CanonicalAvatarSystem {
    static let rendererVersion = "dicebear-rust-10.6.0-styles-10.5.0"
    static let humanStyle = "lorelei"
    static let agentStyle = "thumbs"
    static let defaultAgentId = "cloud-local-agent"
    static let markerPrefix = "kordi-avatar://"

    struct Marker: Equatable {
        let style: String
        let seed: String
        let version: Int64
    }

    struct UploadedMarker: Equatable {
        let assetId: String
    }

    static func marker(from value: String?) -> Marker? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.hasPrefix(markerPrefix),
              let components = URLComponents(string: value),
              components.host == rendererVersion else { return nil }
        let path = components.path.split(separator: "/").map(String.init)
        guard path.count == 2,
              [humanStyle, agentStyle].contains(path[0]),
              validSeed(path[1]),
              let versionText = components.queryItems?.first(where: { $0.name == "version" })?.value,
              let version = Int64(versionText), version > 0 else { return nil }
        return Marker(style: path[0], seed: path[1], version: version)
    }

    static func marker(style: String, seed: String, version: Int64) -> String? {
        guard [humanStyle, agentStyle].contains(style), validSeed(seed), version > 0 else { return nil }
        return "\(markerPrefix)\(rendererVersion)/\(style)/\(seed)?version=\(version)"
    }

    static func uploadedMarker(from value: String?) -> UploadedMarker? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.hasPrefix(markerPrefix),
              let components = URLComponents(string: value),
              components.host == "uploaded" else { return nil }
        let path = components.path.split(separator: "/").map(String.init)
        guard path.count == 1,
              path[0].range(of: #"^ava_[0-9a-fA-F]{32}$"#, options: .regularExpression) != nil
        else { return nil }
        return UploadedMarker(assetId: path[0])
    }

    static func renderURL(from value: String?, baseURL: URL = CloudAPIClient.configuredBaseURL) -> URL? {
        if let uploaded = uploadedMarker(from: value) {
            return baseURL
                .appendingPathComponent("v1/avatars/assets")
                .appendingPathComponent(uploaded.assetId)
                .appendingPathComponent("256.jpg")
        }
        guard let marker = marker(from: value) else { return nil }
        return baseURL
            .appendingPathComponent("v1/avatars")
            .appendingPathComponent(rendererVersion)
            .appendingPathComponent(marker.style)
            .appendingPathComponent("\(marker.seed).png")
            .appending(queryItems: [URLQueryItem(name: "v", value: String(marker.version))])
    }

    static func previewURL(style: String, seed: String, baseURL: URL = CloudAPIClient.configuredBaseURL) -> URL? {
        guard [humanStyle, agentStyle].contains(style), validSeed(seed) else { return nil }
        return baseURL
            .appendingPathComponent("v1/avatars/preview")
            .appendingPathComponent(style)
            .appendingPathComponent("\(seed).png")
    }

    static func newSeed() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    private static func validSeed(_ value: String) -> Bool {
        !value.isEmpty
            && value.utf8.count <= 128
            && value.utf8.allSatisfy {
                (48...57).contains($0)
                    || (65...90).contains($0)
                    || (97...122).contains($0)
                    || $0 == 45
                    || $0 == 95
            }
    }
}

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
    var avatar: CanonicalAvatarDescriptor
    let nodeId: String?
    let passwordSet: Bool

    var preferredName: String {
        displayName?.nonEmpty ?? primaryEmail?.nonEmpty ?? "Kordi user"
    }
}

struct CloudSession: Codable, Hashable {
    let token: String
    let expiresAt: String
    let deviceId: String?
}

struct CloudDeviceRegistration: Codable, Hashable {
    let displayName: String
    let platform: String
    let osVersion: String
    let appVersion: String
    let approximateLocation: String
    let publicKey: String
    let keyAlgorithm: String
}

struct CloudDeviceSyncStatus: Codable, Hashable {
    let protocolVersion: Int
    let lastAppliedSequence: Int64
    let lastSuccessfulCatchUpAt: String?
}

struct CloudDeviceAuthorization: Codable, Hashable, Identifiable {
    let deviceId: String
    let displayName: String?
    let platform: String?
    let osVersion: String?
    let appVersion: String?
    let createdAt: String
    let lastActiveAt: String
    let authorizationState: String
    let currentDevice: Bool
    let sessionExpiresAt: String?
    let approximateLocation: String?
    let syncStatus: CloudDeviceSyncStatus

    var id: String { deviceId }
    var needsReview: Bool { authorizationState == "pending_review" }
}

struct CloudDeviceListResponse: Codable, Hashable {
    let devices: [CloudDeviceAuthorization]
}

struct CloudDeviceMutationResponse: Codable, Hashable {
    let affectedDeviceIds: [String]
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
    var avatarUploadWarning: String? = nil
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

enum CloudPresenceStatus: String, Codable, Hashable {
    case online
    case offline
}

struct CloudPresenceAccount: Codable, Hashable {
    let accountId: String
    let status: CloudPresenceStatus
    let lastSeenAt: String?
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

    private enum CodingKeys: String, CodingKey {
        case defaultModel
        case defaultAuthProvider
        case defaultAuthChoice
        case fallbackModel
        case fallbackAuthProvider
        case fallbackAuthChoice
        case thinking
        case tools
        case plugins
        case model
        case authProvider
        case authChoice
    }

    init(
        defaultModel: String? = nil,
        defaultAuthProvider: String? = nil,
        defaultAuthChoice: String? = nil,
        fallbackModel: String? = nil,
        fallbackAuthProvider: String? = nil,
        fallbackAuthChoice: String? = nil,
        thinking: String? = nil,
        tools: [String]? = nil,
        plugins: [String]? = nil
    ) {
        self.defaultModel = defaultModel
        self.defaultAuthProvider = defaultAuthProvider
        self.defaultAuthChoice = defaultAuthChoice
        self.fallbackModel = fallbackModel
        self.fallbackAuthProvider = fallbackAuthProvider
        self.fallbackAuthChoice = fallbackAuthChoice
        self.thinking = thinking
        self.tools = tools
        self.plugins = plugins
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultModel = try container.decodeIfPresent(String.self, forKey: .defaultModel)
            ?? container.decodeIfPresent(String.self, forKey: .model)
        defaultAuthProvider = try container.decodeIfPresent(
            String.self,
            forKey: .defaultAuthProvider
        ) ?? container.decodeIfPresent(String.self, forKey: .authProvider)
        defaultAuthChoice = try container.decodeIfPresent(
            String.self,
            forKey: .defaultAuthChoice
        ) ?? container.decodeIfPresent(String.self, forKey: .authChoice)
        fallbackModel = try container.decodeIfPresent(String.self, forKey: .fallbackModel)
        fallbackAuthProvider = try container.decodeIfPresent(
            String.self,
            forKey: .fallbackAuthProvider
        )
        fallbackAuthChoice = try container.decodeIfPresent(
            String.self,
            forKey: .fallbackAuthChoice
        )
        thinking = try container.decodeIfPresent(String.self, forKey: .thinking)
        tools = try container.decodeIfPresent([String].self, forKey: .tools)
        plugins = try container.decodeIfPresent([String].self, forKey: .plugins)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(defaultModel, forKey: .defaultModel)
        try container.encodeIfPresent(defaultAuthProvider, forKey: .defaultAuthProvider)
        try container.encodeIfPresent(defaultAuthChoice, forKey: .defaultAuthChoice)
        try container.encodeIfPresent(fallbackModel, forKey: .fallbackModel)
        try container.encodeIfPresent(fallbackAuthProvider, forKey: .fallbackAuthProvider)
        try container.encodeIfPresent(fallbackAuthChoice, forKey: .fallbackAuthChoice)
        try container.encodeIfPresent(thinking, forKey: .thinking)
        try container.encodeIfPresent(tools, forKey: .tools)
        try container.encodeIfPresent(plugins, forKey: .plugins)
    }
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
    let avatar: CanonicalAvatarDescriptor
    let modelRouting: CloudModelRouting

    var id: String { agentId }

    enum CodingKeys: String, CodingKey {
        case agentId, ownerAccountId, accessScope, status, name, role, description
        case systemPrompt, sourceSummary, boundaries, resources, skills
        case createdAt, updatedAt, archivedAt, ownerDisplayName, avatarUrl, avatar, modelRouting
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
        avatar: CanonicalAvatarDescriptor,
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
        self.avatar = avatar
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
        avatar = try container.decode(CanonicalAvatarDescriptor.self, forKey: .avatar)
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
    let subtype: ChatAttachmentSubtype?
    let altText: String?
    let mimeType: String?
    let sizeBytes: Int64?
    let downloadUrl: String?
    let previewUrl: String?

    var id: String { attachmentId }

    init(
        attachmentId: String,
        name: String,
        kind: String,
        subtype: ChatAttachmentSubtype? = nil,
        altText: String? = nil,
        mimeType: String?,
        sizeBytes: Int64?,
        downloadUrl: String?,
        previewUrl: String?
    ) {
        self.attachmentId = attachmentId
        self.name = name
        self.kind = kind
        self.subtype = subtype
        self.altText = altText
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.downloadUrl = downloadUrl
        self.previewUrl = previewUrl
    }
}

struct CloudExpressiveMediaItem: Codable, Hashable, Identifiable {
    let itemId: String
    let attachmentId: String
    let kind: ExpressiveMediaLibraryKind
    let name: String
    let mimeType: String
    let sizeBytes: Int64
    let createdAt: String
    let updatedAt: String

    var id: String { itemId }
}

struct CloudExpressiveMediaListResponse: Codable, Hashable {
    let items: [CloudExpressiveMediaItem]
}

struct CloudExpressiveMediaMutationResponse: Codable, Hashable {
    let item: CloudExpressiveMediaItem
}

struct CloudMessageDTO: Codable, Hashable, Identifiable {
    let messageId: String
    let clientMessageId: String?
    let fromAccountId: String
    let toAccountId: String
    let body: String
    let createdAt: String
    let deliveredAt: String?
    let readAt: String?
    let readByAccountIds: [String]?
    let direction: String
    let sessionId: String?
    let attachments: [CloudMessageAttachment]
    let messageKind: String?
    let voiceMessage: VoiceMessage?
    let conversationId: String?
    let conversationSequence: Int64?
    let reactions: [MessageReaction]

    var id: String { messageId }

    init(
        messageId: String,
        clientMessageId: String? = nil,
        fromAccountId: String,
        toAccountId: String,
        body: String,
        createdAt: String,
        deliveredAt: String?,
        readAt: String?,
        readByAccountIds: [String]? = nil,
        direction: String,
        sessionId: String?,
        attachments: [CloudMessageAttachment] = [],
        messageKind: String? = nil,
        voiceMessage: VoiceMessage? = nil,
        conversationId: String? = nil,
        conversationSequence: Int64? = nil,
        reactions: [MessageReaction] = []
    ) {
        self.messageId = messageId
        self.clientMessageId = clientMessageId
        self.fromAccountId = fromAccountId
        self.toAccountId = toAccountId
        self.body = body
        self.createdAt = createdAt
        self.deliveredAt = deliveredAt
        self.readAt = readAt
        self.readByAccountIds = readByAccountIds
        self.direction = direction
        self.sessionId = sessionId
        self.attachments = attachments
        self.messageKind = messageKind
        self.voiceMessage = voiceMessage
        self.conversationId = conversationId
        self.conversationSequence = conversationSequence
        self.reactions = reactions
    }

    enum CodingKeys: String, CodingKey {
        case messageId, clientMessageId, fromAccountId, toAccountId, body, createdAt, deliveredAt, readAt, readByAccountIds, direction, sessionId, attachments
        case messageKind = "kind"
        case voiceMessage
        case conversationId, conversationSequence, reactions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try container.decode(String.self, forKey: .messageId)
        clientMessageId = try container.decodeIfPresent(String.self, forKey: .clientMessageId)
        fromAccountId = try container.decode(String.self, forKey: .fromAccountId)
        toAccountId = try container.decode(String.self, forKey: .toAccountId)
        body = try container.decode(String.self, forKey: .body)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        deliveredAt = try container.decodeIfPresent(String.self, forKey: .deliveredAt)
        readAt = try container.decodeIfPresent(String.self, forKey: .readAt)
        readByAccountIds = try container.decodeIfPresent([String].self, forKey: .readByAccountIds)
        direction = try container.decode(String.self, forKey: .direction)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        attachments = try container.decodeIfPresent([CloudMessageAttachment].self, forKey: .attachments) ?? []
        messageKind = try container.decodeIfPresent(String.self, forKey: .messageKind)
        voiceMessage = try container.decodeIfPresent(VoiceMessage.self, forKey: .voiceMessage)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        conversationSequence = try container.decodeIfPresent(Int64.self, forKey: .conversationSequence)
        reactions = try container.decodeIfPresent([MessageReaction].self, forKey: .reactions) ?? []
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

struct CloudChatBlock: Codable, Hashable {
    let type: String
    let text: String?
    let mediaId: String?
    let mimeType: String?
    let durationMs: Int?
    let waveformSamples: [Double]?
    let transcript: String?

    init(text: String) {
        type = "text"
        self.text = text
        mediaId = nil
        mimeType = nil
        durationMs = nil
        waveformSamples = nil
        transcript = nil
    }

    init(voiceMessage: VoiceMessage) {
        type = "voice"
        text = nil
        mediaId = voiceMessage.mediaId
        mimeType = voiceMessage.mimeType
        durationMs = voiceMessage.durationMs
        waveformSamples = voiceMessage.waveformSamples
        transcript = voiceMessage.transcript
    }

    var voiceMessage: VoiceMessage? {
        guard type == "voice", let mediaId, let mimeType, let durationMs else { return nil }
        return VoiceMessage(
            mediaId: mediaId,
            mimeType: mimeType,
            durationMs: durationMs,
            waveformSamples: Array((waveformSamples ?? []).prefix(96)),
            transcript: transcript ?? ""
        )
    }
}

struct CloudChatContent: Codable, Hashable {
    let schema: Int
    let blocks: [CloudChatBlock]
    let legacyAttachments: [CloudMessageAttachment]

    init(body: String, attachments: [CloudMessageAttachment], voiceMessage: VoiceMessage? = nil) {
        schema = 1
        blocks = [CloudChatBlock(text: body)] + (voiceMessage.map { [CloudChatBlock(voiceMessage: $0)] } ?? [])
        legacyAttachments = voiceMessage == nil ? attachments : []
    }

    enum CodingKeys: String, CodingKey {
        case schema, blocks
        case legacyAttachments = "legacy_attachments"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(Int.self, forKey: .schema)
        blocks = try container.decode([CloudChatBlock].self, forKey: .blocks)
        legacyAttachments = try container.decodeIfPresent([CloudMessageAttachment].self, forKey: .legacyAttachments) ?? []
    }

    var body: String { blocks.compactMap(\.text).joined() }
    var voiceMessage: VoiceMessage? { blocks.lazy.compactMap(\.voiceMessage).first }
}

struct CloudChatReaction: Codable, Hashable {
    let reaction: String
    let accountIds: [String]

    enum CodingKeys: String, CodingKey {
        case reaction
        case accountIds = "account_ids"
    }
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
    let reactions: [CloudChatReaction]?

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
        case reactions
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
    let call: CloudCall?
    let sessionId: String?
    let messageId: String?
    let scope: String?
    let updatedAt: String?
    let deviceId: String?

    enum CodingKeys: String, CodingKey {
        case conversation, message, preferences, cursor, call
        case sessionId, messageId, scope, updatedAt
        case deviceId = "deviceId"
    }
}

enum CloudCallKind: String, Codable, Hashable {
    case voice
    case video
    case meeting

    var allowsVideo: Bool { self != .voice }
}

enum CloudCallState: String, Codable, Hashable {
    case ringing
    case active
    case ended
}

struct CloudCallParticipant: Codable, Hashable, Identifiable {
    let accountId: String
    let displayName: String?
    let avatarUrl: String?
    let state: String
    let joinedAt: String?
    let leftAt: String?

    var id: String { accountId }

    enum CodingKeys: String, CodingKey {
        case state
        case accountId = "account_id"
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case joinedAt = "joined_at"
        case leftAt = "left_at"
    }
}

struct CloudCall: Codable, Hashable, Identifiable {
    let id: String
    var revision: Int64? = nil
    let conversationId: String
    let kind: CloudCallKind
    let state: CloudCallState
    let createdByAccountId: String
    let createdAt: String
    let answeredAt: String?
    let endedAt: String?
    let participants: [CloudCallParticipant]

    enum CodingKeys: String, CodingKey {
        case id, revision, kind, state, participants
        case conversationId = "conversation_id"
        case createdByAccountId = "created_by_account_id"
        case createdAt = "created_at"
        case answeredAt = "answered_at"
        case endedAt = "ended_at"
    }
}

enum CloudCallSnapshotOrdering {
    static func shouldApply(
        _ incoming: CloudCall,
        after current: CloudCall?,
        endedCallIDs: Set<String>
    ) -> Bool {
        if endedCallIDs.contains(incoming.id), incoming.state != .ended { return false }
        guard let current, current.id == incoming.id else { return true }
        if current.state == .ended { return false }
        if incoming.state == .ended { return true }
        return (incoming.revision ?? 0) >= (current.revision ?? 0)
    }
}

struct CloudCallMediaConnection: Codable, Hashable {
    let url: String
    let token: String
}

struct CloudCallSessionResponse: Codable, Hashable {
    let call: CloudCall
    let media: CloudCallMediaConnection
}

struct CloudCallResponse: Codable, Hashable {
    let call: CloudCall?
}

struct CloudActiveCallSnapshot: Codable, Hashable {
    let call: CloudCall
    let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case call
        case sessionId = "session_id"
    }
}

struct CloudCallListResponse: Codable, Hashable {
    let calls: [CloudActiveCallSnapshot]
}

struct CloudStartCallRequest: Codable, Hashable {
    let clientOperationId: String
    let kind: CloudCallKind

    enum CodingKeys: String, CodingKey {
        case kind
        case clientOperationId = "client_operation_id"
    }
}

struct CloudVoIPPushTokenRequest: Codable, Hashable {
    let token: String
    let environment: String
}

struct CloudNotificationPushTokenRequest: Codable, Hashable {
    let token: String
    let environment: String
    let messagesEnabled: Bool
    let soundEnabled: Bool
    let previewsEnabled: Bool
    let badgeEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case token
        case environment
        case messagesEnabled = "messages_enabled"
        case soundEnabled = "sound_enabled"
        case previewsEnabled = "previews_enabled"
        case badgeEnabled = "badge_enabled"
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

struct CloudChatRealtimeTicket: Codable, Hashable {
    let ticket: String
    let deviceId: String
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case ticket
        case deviceId = "device_id"
        case expiresAt = "expires_at"
    }
}

struct CloudChatRealtimeConnection: Hashable {
    let url: URL
    let deviceId: String
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
    let lastStreamSequence: Int64
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
    let messageId: String?
    let readAt: String?
    let sessionId: String?
    let scope: String?
    let updatedAt: String?
    let forkSessionId: String?
    let parentSessionId: String?
    let parentMessageId: String?
    let createdByAccountId: String?
    let createdAt: String?
    let sessionTitle: CloudSyncedSessionTitle?
    let deviceId: String?
    let call: CloudCall?
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
