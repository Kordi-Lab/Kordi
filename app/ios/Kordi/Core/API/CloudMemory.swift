import Foundation

enum CloudMemoryScope: Hashable, Codable {
    /// Preferences for every conversation; the scope id is always `account`.
    case global
    case conversation
    case group
    case project
    /// A scope this app version does not know. It keeps the rest of the list readable.
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "global": self = .global
        case "conversation": self = .conversation
        case "group": self = .group
        case "project": self = .project
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .global: "global"
        case .conversation: "conversation"
        case .group: "group"
        case .project: "project"
        case .other(let value): value
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

enum CloudMemorySource: Hashable, Codable {
    case userCorrection
    case repeatedFailure
    case outcome
    case manual
    /// A source this app version does not know.
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "user_correction": self = .userCorrection
        case "repeated_failure": self = .repeatedFailure
        case "outcome": self = .outcome
        case "manual": self = .manual
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .userCorrection: "user_correction"
        case .repeatedFailure: "repeated_failure"
        case .outcome: "outcome"
        case .manual: "manual"
        case .other(let value): value
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

struct CloudMemory: Codable, Hashable, Identifiable {
    let memoryId: String
    let scope: CloudMemoryScope
    let scopeId: String
    let scopeLabel: String?
    let source: CloudMemorySource
    var text: String
    let createdAt: String
    var updatedAt: String
    /// The account that saved the memory. Group memories are shared by the
    /// group, so it can be another member. Nil from servers that predate it.
    var ownerAccountId: String? = nil
    var ownerName: String? = nil
    /// Routing fields (#1977); nil from servers that predate them. `category`
    /// is one of `MemoryPresentation.categoryLabels`' keys, `declarationType`
    /// `user-declared` or `model-inferred`, `confidence` `low`, `medium` or
    /// `high`, and `profileKind` `work`, `health`, `daily`, `all` or `custom`.
    var category: String? = nil
    var declarationType: String? = nil
    var confidence: String? = nil
    var profileId: String? = nil
    var profileKind: String? = nil
    /// The cards the memory feeds, in profile order, and the cards the person
    /// removed it from (`memoryVersion` 3, #2035); nil from older servers.
    var profileIds: [String]? = nil
    var excludedProfileIds: [String]? = nil

    var id: String { memoryId }
}

/// A memory routed to one Grounding profile. `everyProfile` marks a
/// schedule memory listed in every fixed-kind profile until it is moved.
struct CloudProfileMemory: Decodable, Hashable, Identifiable {
    let memory: CloudMemory
    let everyProfile: Bool

    var id: String { memory.memoryId }

    init(memory: CloudMemory, everyProfile: Bool = false) {
        self.memory = memory
        self.everyProfile = everyProfile
    }

    private enum CodingKeys: String, CodingKey { case everyProfile }

    init(from decoder: Decoder) throws {
        memory = try CloudMemory(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        everyProfile = (try? container.decodeIfPresent(Bool.self, forKey: .everyProfile)) ?? false
    }
}

/// `GET /v1/cloud/common-ground/profiles/{profileId}/memories`, newest first.
struct CloudProfileMemoryList: Decodable, Hashable {
    let memories: [CloudProfileMemory]
}

struct CloudMemorySettings: Codable, Equatable {
    var memoryEnabled: Bool
    var excludeSensitive: Bool
}

struct CloudMemoryListResponse: Decodable, Equatable {
    let memories: [CloudMemory]
    let settings: CloudMemorySettings
}

struct CloudMemoryResponse: Decodable {
    let memory: CloudMemory
}

struct CloudMemoryForgetResponse: Decodable {
    let archived: Int
}

/// `PATCH /v1/cloud/memory/{id}`. Omitted fields keep their value; a
/// cleared profile is sent as an explicit `"profileId": null`.
/// `addProfileId` and `removeProfileId` change one card (`memoryVersion` 3).
struct CloudMemoryUpdateRequest: Encodable {
    enum Profile: Equatable {
        case keep
        case move(String)
        case clear
    }

    var text: String? = nil
    var category: String? = nil
    var profile: Profile = .keep
    var addProfileId: String? = nil
    var removeProfileId: String? = nil

    private enum CodingKeys: String, CodingKey { case text, category, profileId, addProfileId, removeProfileId }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodeIfPresent(category, forKey: .category)
        try container.encodeIfPresent(addProfileId, forKey: .addProfileId)
        try container.encodeIfPresent(removeProfileId, forKey: .removeProfileId)
        switch profile {
        case .keep: break
        case .move(let profileId): try container.encode(profileId, forKey: .profileId)
        case .clear: try container.encodeNil(forKey: .profileId)
        }
    }
}

/// Where a memory typed on a Memory screen is saved: the scope of the screen it was added from.
struct MemoryAddTarget: Equatable {
    let scope: CloudMemoryScope
    let scopeId: String
    var scopeLabel: String? = nil

    /// Settings add global memories, which always use the `account` scope id.
    static let global = MemoryAddTarget(scope: .global, scopeId: "account")
}

/// A memory the person typed. The server returns the existing memory when the
/// scope already has this text.
struct CloudMemoryCreateRequest: Encodable {
    let scope: CloudMemoryScope
    let scopeId: String
    let scopeLabel: String?
    let source: CloudMemorySource
    let text: String

    init(target: MemoryAddTarget, text: String) {
        scope = target.scope
        scopeId = target.scopeId
        scopeLabel = target.scopeLabel
        source = .manual
        self.text = text
    }
}

extension CloudAPIClient {
    func createMemory(token: String, target: MemoryAddTarget, text: String) async throws -> CloudMemory {
        let response: CloudMemoryResponse = try await send(
            path: "/v1/cloud/memory",
            method: "POST",
            token: token,
            body: CloudMemoryCreateRequest(target: target, text: text),
            fallback: "Could not save this memory. Try again."
        )
        return response.memory
    }

    /// Changes a memory's category or cards with one `PATCH`.
    func changeMemory(token: String, memoryId: String, _ request: CloudMemoryUpdateRequest) async throws -> CloudMemory {
        let segment = memoryId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? memoryId
        let response: CloudMemoryResponse = try await send(
            path: "/v1/cloud/memory/\(segment)",
            method: "PATCH",
            token: token,
            body: request,
            fallback: "Could not change this memory. Try again."
        )
        return response.memory
    }
}

/// Omitted fields keep their current value on the server.
struct CloudMemorySettingsUpdateRequest: Encodable {
    var memoryEnabled: Bool?
    var excludeSensitive: Bool?
}
