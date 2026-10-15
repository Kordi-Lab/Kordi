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

    var id: String { memoryId }
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

struct CloudMemoryUpdateRequest: Encodable {
    let text: String
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
}

/// Omitted fields keep their current value on the server.
struct CloudMemorySettingsUpdateRequest: Encodable {
    var memoryEnabled: Bool?
    var excludeSensitive: Bool?
}
