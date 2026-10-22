import Foundation

/// The Build screen's choices turned into the build request, kept free of
/// SwiftUI for tests. Mirrors the desktop `buildRequest.ts`.
struct CommonGroundBuildChoices: Equatable {
    /// The Memory switch.
    var memoryOn = false
    /// Saved memories; nil while loading or when the server has no memory.
    var memoryCount: Int?
    /// Connected accounts the person included.
    var connectors: [ConnectorProviderId] = []
    var device: [CommonGroundDeviceItems] = []
    /// Picked documents the account can still use.
    var documents: [String] = []
    var links = ""
    var notes = ""
    /// `commonGroundVersion` 3: also send the providers, documents and picks.
    var sendsSources = false
    /// The picks the server saves with the build.
    var picks: CommonGroundSourcePicks?

    var memoryUsable: Bool { (memoryCount ?? 0) > 0 }

    var request: CommonGroundBuildRequest {
        var request = CommonGroundBuildRequest(
            memory: memoryOn && memoryUsable,
            connectors: !connectors.isEmpty,
            device: device.filter { !$0.items.isEmpty },
            links: links.trimmingCharacters(in: .whitespacesAndNewlines),
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        if sendsSources {
            request.connectorProviders = connectors.map(\.rawValue)
            request.documents = Array(documents.prefix(CommonGroundSourcePicks.maxDocuments))
            request.picks = picks
        }
        return request
    }

    /// True only when the request carries something to read.
    var canBuild: Bool {
        let request = request
        return request.memory || request.connectors || !request.device.isEmpty
            || !(request.documents ?? []).isEmpty || !request.links.isEmpty || !request.notes.isEmpty
    }
}

extension CommonGroundSourcePicks {
    /// The Build screen's switches as picks. Agents and connectors this
    /// screen does not list stay as saved, so a build here keeps the Mac's.
    init(memory: Bool, connectors: Set<ConnectorProviderId>, device: Set<CommonGroundDeviceSource>,
         documents: [String], links: String, notes: String, keeping saved: CommonGroundSourcePicks?) {
        let listed = Set(CommonGroundBuildCopy.connectorIds.map(\.rawValue))
        self.init(
            memory: memory,
            connectors: CommonGroundBuildCopy.connectorIds.filter(connectors.contains).map(\.rawValue)
                + (saved?.connectors ?? []).filter { !listed.contains($0) },
            device: CommonGroundDeviceSource.allCases.filter(device.contains).map(\.rawValue),
            agents: saved?.agents ?? false,
            documents: Array(documents.prefix(Self.maxDocuments)),
            links: links,
            notes: notes
        )
    }

    var connectorIds: Set<ConnectorProviderId> { Set(connectors.compactMap(ConnectorProviderId.init(rawValue:))) }
    var deviceSources: Set<CommonGroundDeviceSource> { Set(device.compactMap(CommonGroundDeviceSource.init(rawValue:))) }
}

enum CommonGroundBuildCopy {
    /// The connectors the Build screen lists, in the desktop order.
    static let connectorIds: [ConnectorProviderId] = [.gmail, .googleCalendar, .github, .slack]

    static func memoryLine(_ count: Int?) -> String {
        guard let count else { return "Loading…" }
        switch count {
        case 0: return "No memories yet"
        case 1: return "1 memory"
        default: return "\(count) memories"
        }
    }

    /// The Documents row's value.
    static func documentsLine(_ count: Int) -> String {
        count == 0 ? "None chosen" : "\(count) chosen"
    }
}
