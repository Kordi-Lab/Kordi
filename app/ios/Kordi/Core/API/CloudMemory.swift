import Foundation

/// Public capability flags from `GET /v1/cloud/auth/capabilities`. Only the
/// fields the app reads are declared, so new server fields never break decoding.
struct CloudAuthCapabilities: Decodable, Equatable {
    var password: Bool?
    /// Present when the server offers account memory and replay state routes.
    /// Older servers omit it, and the Memory screen stays hidden.
    var memoryVersion: Int?
}

enum CloudMemoryScope: Hashable, Codable {
    case conversation
    case group
    case project
    /// A scope this app version does not know. It keeps the rest of the list readable.
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "conversation": self = .conversation
        case "group": self = .group
        case "project": self = .project
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
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

struct CloudReplayStateResponse: Decodable, Equatable {
    let runCount: Int
}

struct CloudReplayStateClearResponse: Decodable {
    let deleted: Int
}

struct CloudMemoryUpdateRequest: Encodable {
    let text: String
}

/// Omitted fields keep their current value on the server.
struct CloudMemorySettingsUpdateRequest: Encodable {
    var memoryEnabled: Bool?
    var excludeSensitive: Bool?
}
