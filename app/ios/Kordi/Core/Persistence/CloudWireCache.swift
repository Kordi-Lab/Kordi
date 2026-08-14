import Foundation

struct CloudWireSnapshot: Codable {
    static let currentForkLineageVersion = 1

    let accountId: String
    let cursor: String
    let lastStreamSequence: Int64?
    let messagesByPeer: [String: [CloudMessageDTO]]
    let sessionForksById: [String: CloudSessionForkSummary]?
    let forkLineageVersion: Int?
    let savedAt: Date
}

enum CloudSyncRecoveryPolicy {
    static func requiresBootstrap(
        hasHydratedWireSnapshot: Bool,
        hasHydratedForkLineage: Bool
    ) -> Bool {
        !hasHydratedWireSnapshot || !hasHydratedForkLineage
    }
}

/// Persists the canonical Cloud projection away from the main actor so an app
/// relaunch can resume at its last event instead of replaying the whole account.
actor CloudWireCache {
    private let directory: URL?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            self.directory = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first?.appendingPathComponent("Kordi/Cloud", isDirectory: true)
        }
        encoder.outputFormatting = [.sortedKeys]
    }

    func load(accountId: String) -> CloudWireSnapshot? {
        guard let url = snapshotURL(accountId: accountId),
              let data = try? Data(contentsOf: url),
              let snapshot = try? decoder.decode(CloudWireSnapshot.self, from: data),
              snapshot.accountId == accountId else { return nil }
        return snapshot
    }

    func save(
        accountId: String,
        cursor: String,
        lastStreamSequence: Int64,
        messagesByPeer: [String: [CloudMessageDTO]],
        sessionForksById: [String: CloudSessionForkSummary]? = nil
    ) -> Bool {
        guard let directory, let url = snapshotURL(accountId: accountId) else { return false }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let snapshot = CloudWireSnapshot(
                accountId: accountId,
                cursor: cursor,
                lastStreamSequence: lastStreamSequence,
                messagesByPeer: messagesByPeer,
                sessionForksById: sessionForksById,
                forkLineageVersion: CloudWireSnapshot.currentForkLineageVersion,
                savedAt: Date()
            )
            try encoder.encode(snapshot).write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    func clear(accountId: String) {
        guard let url = snapshotURL(accountId: accountId) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private func snapshotURL(accountId: String) -> URL? {
        let safeAccountId = accountId.unicodeScalars.map { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-"
                ? String(scalar)
                : "_"
        }.joined()
        return directory?.appendingPathComponent("messages-\(safeAccountId).json")
    }
}
