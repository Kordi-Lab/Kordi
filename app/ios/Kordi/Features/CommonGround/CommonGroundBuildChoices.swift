import Foundation

/// The Build screen's choices turned into the build request, kept free of
/// SwiftUI for tests. Mirrors the desktop `buildRequest.ts`.
struct CommonGroundBuildChoices: Equatable {
    /// The Memory switch.
    var memoryOn = false
    /// Saved memories; nil while loading or when the server has no memory.
    var memoryCount: Int?
    /// Connectors the account has connected.
    var connectedCount = 0
    var device: [CommonGroundDeviceItems] = []
    var links = ""
    var notes = ""

    var memoryUsable: Bool { (memoryCount ?? 0) > 0 }

    var request: CommonGroundBuildRequest {
        CommonGroundBuildRequest(
            memory: memoryOn && memoryUsable,
            connectors: connectedCount > 0,
            device: device.filter { !$0.items.isEmpty },
            links: links.trimmingCharacters(in: .whitespacesAndNewlines),
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    /// True only when the request carries something to read.
    var canBuild: Bool {
        let request = request
        return request.memory || request.connectors || !request.device.isEmpty
            || !request.links.isEmpty || !request.notes.isEmpty
    }
}

enum CommonGroundBuildCopy {
    /// The connectors the Build screen lists, in the desktop order.
    static let connectorIds: [ConnectorProviderId] = [.gmail, .googleCalendar, .github, .slack]

    /// What each connector adds to a profile.
    static func reads(_ providerId: ConnectorProviderId) -> String {
        switch providerId {
        case .gmail: "Paper, review and conference threads"
        case .googleCalendar: "Talks and meetings"
        case .github: "Repositories and bio"
        case .slack: "Channels you choose"
        default: ConnectorsModel.definition(providerId).summary
        }
    }

    static func connectorLine(_ providerId: ConnectorProviderId, status: ConnectorStatus?) -> String {
        switch status {
        case .connected: "Connected"
        case .needsReauth: "Sign in again"
        default: reads(providerId)
        }
    }

    static func memoryLine(_ count: Int?) -> String {
        guard let count else { return "Loading…" }
        switch count {
        case 0: return "No memories yet"
        case 1: return "1 memory"
        default: return "\(count) memories"
        }
    }
}
