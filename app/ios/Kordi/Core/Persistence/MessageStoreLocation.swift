import Foundation
import OSLog

/// Moves the SwiftData message cache from SwiftData's default location to the
/// app container's `Application Support/Kordi/MessageStore`, a Class C
/// directory excluded from backups.
///
/// The move is copy, then open, then delete: a store is never removed before
/// its replacement has opened, and any failure falls back to the legacy store
/// and retries on the next launch. The Cloud wire cache is never touched.
enum MessageStoreLocation {
    struct Resolution: Equatable {
        /// The store to open.
        let url: URL
        /// A store whose files are removed after `url` opens.
        let removeAfterOpen: URL?
        /// `url` was copied from the legacy store during this launch.
        let didCopy: Bool
        /// `url` is the legacy store because the relocated store is unavailable.
        let isLegacyFallback: Bool
    }

    static let directoryPath = "Kordi/MessageStore"
    static let storeFileName = "messages.store"
    static let partialFileName = "messages.store.partial"

    static func directory(applicationSupport: URL) -> URL {
        applicationSupport.appendingPathComponent(directoryPath, isDirectory: true)
    }

    /// The SQLite main file and its WAL and shared-memory siblings.
    static func storeFiles(_ url: URL) -> [URL] {
        [url, sibling(of: url, suffix: "-wal"), sibling(of: url, suffix: "-shm")]
    }

    static func resolve(
        legacy: URL,
        applicationSupport: URL,
        fileManager: FileManager,
        protection: any LocalDataProtecting
    ) -> Resolution {
        let directory = directory(applicationSupport: applicationSupport)
        let store = directory.appendingPathComponent(storeFileName, isDirectory: false)
        let partial = directory.appendingPathComponent(partialFileName, isDirectory: false)
        let prepared = (try? protection.prepareDirectory(
            directory,
            protection: LocalDataProtectionClass.backgroundStore,
            excludeFromBackup: true
        )) != nil
        let legacyExists = fileManager.fileExists(atPath: legacy.path)

        if fileManager.fileExists(atPath: store.path) {
            // The relocated store always wins. The legacy copy is either an
            // empty fallback file or a regenerable cache from an older build.
            try? fileManager.removeItem(at: partial)
            return Resolution(
                url: store,
                removeAfterOpen: legacyExists && prepared ? legacy : nil,
                didCopy: false,
                isLegacyFallback: false
            )
        }
        guard legacyExists else {
            return prepared
                ? Resolution(url: store, removeAfterOpen: nil, didCopy: false, isLegacyFallback: false)
                : fallback(to: legacy)
        }
        guard prepared else { return fallback(to: legacy) }

        let storeWAL = sibling(of: store, suffix: "-wal")
        for leftover in [storeWAL, sibling(of: store, suffix: "-shm"), partial] {
            try? fileManager.removeItem(at: leftover)
        }
        do {
            let legacyWAL = sibling(of: legacy, suffix: "-wal")
            if fileManager.fileExists(atPath: legacyWAL.path) {
                try fileManager.copyItem(at: legacyWAL, to: storeWAL)
            }
            // SQLite rebuilds the shared-memory file, so it is never copied.
            // `store` appears only through this final rename, so its presence
            // proves that the copy completed.
            try fileManager.copyItem(at: legacy, to: partial)
            try fileManager.moveItem(at: partial, to: store)
            return Resolution(url: store, removeAfterOpen: legacy, didCopy: true, isLegacyFallback: false)
        } catch {
            removeFiles(storeFiles(store) + [partial], fileManager: fileManager)
            return fallback(to: legacy)
        }
    }

    /// Resolves the store location, opens it, and finishes the relocation.
    static func open<Container>(
        legacy: URL,
        applicationSupport: URL,
        fileManager: FileManager,
        protection: any LocalDataProtecting,
        using openStore: (URL) throws -> Container
    ) throws -> Container {
        #if DEBUG
        logger.debug("Legacy message store: \(legacy.path, privacy: .public)")
        #endif
        var resolution = resolve(
            legacy: legacy,
            applicationSupport: applicationSupport,
            fileManager: fileManager,
            protection: protection
        )
        let container: Container
        do {
            container = try openStore(resolution.url)
        } catch where resolution.didCopy {
            // Only a store copied during this launch is discarded; the legacy
            // store it came from is still intact.
            removeFiles(storeFiles(resolution.url), fileManager: fileManager)
            resolution = fallback(to: legacy)
            container = try openStore(legacy)
        }

        if resolution.isLegacyFallback {
            // Keep the backup exclusion true while the fallback is in use.
            storeFiles(legacy).forEach { protection.excludeFromBackup($0) }
            return container
        }
        if let removed = resolution.removeAfterOpen {
            removeFiles(storeFiles(removed), fileManager: fileManager)
            #if DEBUG
            if !fileManager.fileExists(atPath: removed.path) {
                logger.debug("Removed relocated legacy message store: \(removed.path, privacy: .public)")
            }
            #endif
        }
        // SQLite creates its WAL and shared-memory files with the directory's
        // default class, so the explicit class matters most for the main file.
        for file in storeFiles(resolution.url) {
            protection.apply(LocalDataProtectionClass.backgroundStore, to: file)
        }
        return container
    }

    private static func fallback(to legacy: URL) -> Resolution {
        Resolution(url: legacy, removeAfterOpen: nil, didCopy: false, isLegacyFallback: true)
    }

    private static func sibling(of url: URL, suffix: String) -> URL {
        url.deletingLastPathComponent()
            .appendingPathComponent(url.lastPathComponent + suffix, isDirectory: false)
    }

    private static func removeFiles(_ urls: [URL], fileManager: FileManager) {
        for url in urls where fileManager.fileExists(atPath: url.path) {
            try? fileManager.removeItem(at: url)
        }
    }

    #if DEBUG
    private static let logger = Logger(subsystem: "ai.kordi.ios", category: "MessageStore")
    #endif
}
