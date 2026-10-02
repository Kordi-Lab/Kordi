import Foundation

struct CloudGroupParticipant: Codable, Hashable, Identifiable {
    let accountId: String
    let displayName: String
    let avatarUrl: String?
    let agentId: String?
    let agentDisplayName: String?
    let agentAvatarUrl: String?
    let role: String?
    let joinedAt: String?

    var id: String { accountId }

    init(
        accountId: String,
        displayName: String,
        avatarUrl: String?,
        agentId: String? = nil,
        agentDisplayName: String? = nil,
        agentAvatarUrl: String? = nil,
        role: String?,
        joinedAt: String? = nil
    ) {
        self.accountId = accountId
        self.displayName = displayName
        self.avatarUrl = avatarUrl
        self.agentId = agentId
        self.agentDisplayName = agentDisplayName
        self.agentAvatarUrl = agentAvatarUrl
        self.role = role
        self.joinedAt = joinedAt
    }

    static func canonicalPrecedes(
        _ left: CloudGroupParticipant,
        _ right: CloudGroupParticipant
    ) -> Bool {
        let leftJoinedAt = left.joinedAt?.nonEmpty
        let rightJoinedAt = right.joinedAt?.nonEmpty
        if leftJoinedAt != rightJoinedAt {
            if let leftJoinedAt, let rightJoinedAt { return leftJoinedAt < rightJoinedAt }
            return leftJoinedAt != nil
        }
        return left.accountId < right.accountId
    }
}

struct CloudChatConversation: Codable, Hashable {
    let id: String
    let kind: String
    let sharedTitle: String?
    let version: Int
    let createdByAccountId: String
    let legacySessionId: String?
    var groupSpaceId: String? = nil
    var groupTitle: String? = nil
    var groupAvatar: CloudGroupAvatar? = nil
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
        case groupSpaceId = "group_space_id"
        case groupTitle = "group_title"
        case groupAvatar = "group_avatar"
        case forkedFromSessionId = "forked_from_session_id"
        case forkedFromMessageId = "forked_from_message_id"
        case latestMessageSequence = "latest_message_sequence"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// A null image is a persisted removal, so older channels cannot restore it.
struct CloudGroupAvatar: Codable, Hashable {
    let imageUrl: String?
    let updatedAtMs: Double

    init(imageUrl: String?, updatedAtMs: Double) {
        self.imageUrl = imageUrl
        self.updatedAtMs = updatedAtMs.rounded(.towardZero)
    }

    enum CodingKeys: String, CodingKey { case imageUrl, updatedAtMs }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let image = try container.decode(String?.self, forKey: .imageUrl)
        let revision = try container.decode(Double.self, forKey: .updatedAtMs)
        guard revision.isFinite, revision > 0, revision.rounded(.towardZero) == revision,
              image == nil || image?.range(of: "^kordi-avatar://uploaded/ava_[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw DecodingError.dataCorruptedError(forKey: .imageUrl, in: container, debugDescription: "Invalid group avatar snapshot")
        }
        self.init(imageUrl: image, updatedAtMs: revision)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(imageUrl, forKey: .imageUrl)
        try container.encode(updatedAtMs, forKey: .updatedAtMs)
    }
}

enum GroupAvatarCatalog {
    static func imageSource(
        groupSpaceId: String,
        canonical: [CloudChatConversation],
        controls: [(CloudMessageDTO, CloudGroupControlEnvelope)]
    ) -> String? {
        let spaceId = normalizedGroupSpaceId(groupSpaceId)
        let snapshots = canonical.filter {
            $0.kind == "group" && normalizedGroupSpaceId($0.groupSpaceId ?? $0.legacySessionId ?? $0.id) == spaceId
        }.compactMap(\.groupAvatar)
        // Canonical state wins even when its newest revision removes the image.
        if let latest = snapshots.max(by: { $0.updatedAtMs < $1.updatedAtMs }) { return latest.imageUrl }
        return controls.filter {
            normalizedGroupSpaceId($0.1.groupSpaceId ?? $0.1.groupId) == spaceId
        }.compactMap { $0.1.groupAvatar }.max(by: { $0.updatedAtMs < $1.updatedAtMs })?.imageUrl
    }
}
