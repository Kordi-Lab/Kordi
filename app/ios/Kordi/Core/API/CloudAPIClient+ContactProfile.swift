import Foundation

/// `GET /v1/cloud/contacts/{account_id}/profile` (issue #1945). Every field
/// past the identity is optional so a partial response still renders.
struct CloudContactProfile: Codable, Hashable {
    enum Kind: String, Codable, Hashable {
        case person
        case agent
        case system
    }

    struct Presence: Codable, Hashable {
        let status: CloudPresenceStatus
        let lastSeenAt: String?
    }

    /// The person's default agent: the public profile `defaultAgent` shape
    /// plus `accountId`. The canonical `avatar` descriptor is not needed here.
    struct Agent: Codable, Hashable {
        let agentId: String
        let displayName: String
        let avatarUrl: String?
        var accountId: String? = nil

        private enum CodingKeys: String, CodingKey { case agentId, displayName, avatarUrl, accountId }

        init(agentId: String, displayName: String, avatarUrl: String?, accountId: String? = nil) {
            self.agentId = agentId
            self.displayName = displayName
            self.avatarUrl = avatarUrl
            self.accountId = accountId
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            agentId = try c.decode(String.self, forKey: .agentId)
            displayName = (try? c.decodeIfPresent(String.self, forKey: .displayName)) ?? ""
            avatarUrl = try? c.decodeIfPresent(String.self, forKey: .avatarUrl)
            accountId = try? c.decodeIfPresent(String.self, forKey: .accountId)
        }
    }

    /// The person who owns an agent account.
    struct Owner: Codable, Hashable {
        let accountId: String
        let kordiId: String?
        let displayName: String?
        let avatarUrl: String?
    }

    /// `title` may be null on the wire and falls back to "Group"; `avatarUrl`
    /// may be a `kordi-avatar://` marker, which `IdentityAvatar` renders.
    struct SharedGroup: Codable, Hashable, Identifiable {
        let groupId: String
        let title: String
        let avatarUrl: String?

        var id: String { groupId }

        private enum CodingKeys: String, CodingKey { case groupId, title, avatarUrl }

        init(groupId: String, title: String, avatarUrl: String?) {
            self.groupId = groupId
            self.title = title
            self.avatarUrl = avatarUrl
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            groupId = try c.decode(String.self, forKey: .groupId)
            title = (try? c.decodeIfPresent(String.self, forKey: .title))?.nonEmpty ?? "Group"
            avatarUrl = try? c.decodeIfPresent(String.self, forKey: .avatarUrl)
        }
    }

    struct Shared: Codable, Hashable {
        var mediaCount: Int = 0
        var linkCount: Int = 0
        var documentCount: Int = 0
        var groups: [SharedGroup] = []

        var isEmpty: Bool {
            mediaCount == 0 && linkCount == 0 && documentCount == 0 && groups.isEmpty
        }
    }

    struct CommonGround: Codable, Hashable {
        var workingOn: [String] = []
        var canHelp: [String] = []
        var lookingFor: [String] = []

        var isEmpty: Bool { workingOn.isEmpty && canHelp.isEmpty && lookingFor.isEmpty }
    }

    let accountId: String
    var kordiId: String? = nil
    var displayName: String? = nil
    var avatarUrl: String? = nil
    var about: String? = nil
    var kind: Kind = .person
    var isSelf: Bool = false
    var isContact: Bool = false
    var presence: Presence? = nil
    var defaultAgent: Agent? = nil
    var owner: Owner? = nil
    var contactSince: String? = nil
    var shared: Shared? = nil
    var commonGround: CommonGround? = nil

    private enum CodingKeys: String, CodingKey {
        case accountId, kordiId, displayName, avatarUrl, about, kind, isSelf, isContact
        case presence, defaultAgent, owner, contactSince, shared, commonGround
    }

    init(
        accountId: String,
        kordiId: String? = nil,
        displayName: String? = nil,
        avatarUrl: String? = nil,
        about: String? = nil,
        kind: Kind = .person,
        isSelf: Bool = false,
        isContact: Bool = false,
        presence: Presence? = nil,
        defaultAgent: Agent? = nil,
        owner: Owner? = nil,
        contactSince: String? = nil,
        shared: Shared? = nil,
        commonGround: CommonGround? = nil
    ) {
        self.accountId = accountId
        self.kordiId = kordiId
        self.displayName = displayName
        self.avatarUrl = avatarUrl
        self.about = about
        self.kind = kind
        self.isSelf = isSelf
        self.isContact = isContact
        self.presence = presence
        self.defaultAgent = defaultAgent
        self.owner = owner
        self.contactSince = contactSince
        self.shared = shared
        self.commonGround = commonGround
    }

    /// Unknown or malformed optional parts decode as nil instead of failing the whole profile.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try c.decode(String.self, forKey: .accountId)
        kordiId = try? c.decodeIfPresent(String.self, forKey: .kordiId)
        displayName = try? c.decodeIfPresent(String.self, forKey: .displayName)
        avatarUrl = try? c.decodeIfPresent(String.self, forKey: .avatarUrl)
        about = try? c.decodeIfPresent(String.self, forKey: .about)
        kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .person
        isSelf = (try? c.decodeIfPresent(Bool.self, forKey: .isSelf)) ?? false
        isContact = (try? c.decodeIfPresent(Bool.self, forKey: .isContact)) ?? false
        presence = try? c.decodeIfPresent(Presence.self, forKey: .presence)
        defaultAgent = try? c.decodeIfPresent(Agent.self, forKey: .defaultAgent)
        owner = try? c.decodeIfPresent(Owner.self, forKey: .owner)
        contactSince = try? c.decodeIfPresent(String.self, forKey: .contactSince)
        shared = try? c.decodeIfPresent(Shared.self, forKey: .shared)
        commonGround = try? c.decodeIfPresent(CommonGround.self, forKey: .commonGround)
    }
}

extension CloudContactProfile.Shared {
    private enum CodingKeys: String, CodingKey { case mediaCount, linkCount, documentCount, groups }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mediaCount = (try? c.decodeIfPresent(Int.self, forKey: .mediaCount)) ?? 0
        linkCount = (try? c.decodeIfPresent(Int.self, forKey: .linkCount)) ?? 0
        documentCount = (try? c.decodeIfPresent(Int.self, forKey: .documentCount)) ?? 0
        // One malformed group drops only itself.
        let decoded = (try? c.decodeIfPresent([FailableGroup].self, forKey: .groups)) ?? []
        groups = decoded.compactMap(\.group)
    }
}

private struct FailableGroup: Decodable {
    let group: CloudContactProfile.SharedGroup?

    init(from decoder: Decoder) throws {
        group = try? CloudContactProfile.SharedGroup(from: decoder)
    }
}

extension CloudContactProfile.CommonGround {
    private enum CodingKeys: String, CodingKey { case workingOn, canHelp, lookingFor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workingOn = (try? c.decodeIfPresent([String].self, forKey: .workingOn)) ?? []
        canHelp = (try? c.decodeIfPresent([String].self, forKey: .canHelp)) ?? []
        lookingFor = (try? c.decodeIfPresent([String].self, forKey: .lookingFor)) ?? []
    }
}

extension CloudAPIClient {
    private static let contactProfileSegment = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    /// Only call when the server reports `contactProfileVersion` 1 or later.
    func fetchContactProfile(token: String, accountId: String) async throws -> CloudContactProfile {
        let segment = accountId.addingPercentEncoding(withAllowedCharacters: Self.contactProfileSegment) ?? accountId
        return try await send(
            path: "/v1/cloud/contacts/\(segment)/profile",
            method: "GET",
            token: token,
            fallback: "Could not load this profile."
        )
    }

    /// `DELETE /v1/cloud/contacts/{account_id}`: 204 on success, 404 when not a
    /// contact, 403 for the system contact or yourself.
    func removeContact(token: String, accountId: String) async throws {
        let segment = accountId.addingPercentEncoding(withAllowedCharacters: Self.contactProfileSegment) ?? accountId
        try await sendWithoutResponse(
            path: "/v1/cloud/contacts/\(segment)",
            method: "DELETE",
            token: token,
            fallback: "Could not delete this contact."
        )
    }
}
