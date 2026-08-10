import Foundation

struct CloudWireSnapshot: Codable {
    let accountId: String
    let cursor: String
    let messagesByPeer: [String: [CloudMessageDTO]]
    let sessionForksById: [String: CloudSessionForkSummary]?
    let savedAt: Date
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
        messagesByPeer: [String: [CloudMessageDTO]],
        sessionForksById: [String: CloudSessionForkSummary]? = nil
    ) {
        guard let directory, let url = snapshotURL(accountId: accountId) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let snapshot = CloudWireSnapshot(
                accountId: accountId,
                cursor: cursor,
                messagesByPeer: messagesByPeer,
                sessionForksById: sessionForksById,
                savedAt: Date()
            )
            try encoder.encode(snapshot).write(to: url, options: .atomic)
        } catch {
            // Cloud remains canonical; a failed cache write only makes the next
            // launch perform a complete replay.
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
