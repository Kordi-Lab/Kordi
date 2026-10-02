import Foundation

struct CloudWireSnapshot: Codable {
    static let currentForkLineageVersion = 1
    static let currentMessageProjectionVersion = 1

    let accountId: String
    let cursor: String
    let messagesByPeer: [String: [CloudMessageDTO]]
    let sessionForksById: [String: CloudSessionForkSummary]?
    let forkLineageVersion: Int?
    let savedAt: Date
    var sessionPinsByID: [String: CloudSessionPin]? = nil
    var visibility: CloudSessionVisibility? = nil
    var messageProjectionVersion: Int? = nil
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
///
/// Snapshots are Class C and excluded from backups: background writers such as
/// a VoIP launch on a locked device must still be able to read the cursor, and
/// the data is a regenerable copy of Cloud state.
actor CloudWireCache {
    private let directory: URL?
    private let protection: any LocalDataProtecting
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var didPrepareDirectory = false

    init(directory: URL? = nil, protection: any LocalDataProtecting = SystemLocalDataProtection()) {
        if let directory {
            self.directory = directory
        } else {
            self.directory = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first?.appendingPathComponent("Kordi/Cloud", isDirectory: true)
        }
        self.protection = protection
        encoder.outputFormatting = [.sortedKeys]
    }

    func load(accountId: String) -> CloudWireSnapshot? {
        if !didPrepareDirectory, let directory, FileManager.default.fileExists(atPath: directory.path) {
            try? prepareDirectory(directory)
        }
        guard let url = snapshotURL(accountId: accountId),
              let data = try? Data(contentsOf: url),
              let snapshot = try? decoder.decode(CloudWireSnapshot.self, from: data),
              snapshot.accountId == accountId else { return nil }
        // Previous projections dropped history timestamps. Refetch affected
        // snapshots instead of resuming their cursor with permanent wrong dates.
        if snapshot.messageProjectionVersion != CloudWireSnapshot.currentMessageProjectionVersion,
           snapshot.messagesByPeer.values.contains(where: { messages in
               messages.contains { $0.messageKind?.hasPrefix("canonical-history-") == true }
           }) { return nil }
        return snapshot
    }

    func save(
        accountId: String,
        cursor: String,
        messagesByPeer: [String: [CloudMessageDTO]],
        sessionForksById: [String: CloudSessionForkSummary]? = nil,
        visibility: CloudSessionVisibility? = nil,
        sessionPinsByID: [String: CloudSessionPin]? = nil
    ) {
        guard let directory, let url = snapshotURL(accountId: accountId) else { return }
        do {
            try prepareDirectory(directory)
            let snapshot = CloudWireSnapshot(
                accountId: accountId,
                cursor: cursor,
                messagesByPeer: messagesByPeer,
                sessionForksById: sessionForksById,
                forkLineageVersion: CloudWireSnapshot.currentForkLineageVersion,
                savedAt: Date(),
                sessionPinsByID: sessionPinsByID,
                visibility: visibility,
                messageProjectionVersion: CloudWireSnapshot.currentMessageProjectionVersion
            )
            try encoder.encode(snapshot).write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch {
            // Cloud remains canonical; a failed cache write only makes the next
            // launch perform a complete replay.
        }
    }

    func clear(accountId: String) {
        guard let url = snapshotURL(accountId: accountId) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Prepares the directory once per cache instance, and again only if it
    /// was removed. Only creating the directory can throw.
    private func prepareDirectory(_ directory: URL) throws {
        if didPrepareDirectory, FileManager.default.fileExists(atPath: directory.path) { return }
        try protection.prepareDirectory(
            directory,
            protection: LocalDataProtectionClass.backgroundStore,
            excludeFromBackup: true
        )
        didPrepareDirectory = true
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
