import Foundation

/// Applies iOS Data Protection classes and backup exclusion to local caches.
///
/// Only directory creation can throw. Every other step is best effort so a
/// protection or backup-flag failure never stops a cache from opening.
protocol LocalDataProtecting: Sendable {
    /// Creates `url` with `protection`, or updates an existing directory, and
    /// optionally excludes it from iCloud and computer backups.
    func prepareDirectory(_ url: URL, protection: FileProtectionType, excludeFromBackup: Bool) throws

    /// Sets `protection` on an existing file or directory. Returns `false`
    /// only when an existing item could not be updated.
    @discardableResult
    func apply(_ protection: FileProtectionType, to url: URL) -> Bool

    /// Excludes an existing file or directory from backups.
    func excludeFromBackup(_ url: URL)
}

struct SystemLocalDataProtection: LocalDataProtecting {
    func prepareDirectory(_ url: URL, protection: FileProtectionType, excludeFromBackup: Bool) throws {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
            try? fileManager.setAttributes([.protectionKey: protection], ofItemAtPath: url.path)
        } else {
            try fileManager.createDirectory(
                at: url,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: protection]
            )
        }
        if excludeFromBackup {
            self.excludeFromBackup(url)
        }
    }

    @discardableResult
    func apply(_ protection: FileProtectionType, to url: URL) -> Bool {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: url.path) else { return true }
        do {
            try fileManager.setAttributes([.protectionKey: protection], ofItemAtPath: url.path)
            return true
        } catch {
            return false
        }
    }

    func excludeFromBackup(_ url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try? target.setResourceValues(values)
    }
}

/// Data Protection classes for Kordi's local caches. The names follow Apple's
/// Data Protection model: Class B is `completeUnlessOpen`, Class C is
/// `completeUntilFirstUserAuthentication`.
enum LocalDataProtectionClass {
    /// Class C for stores written in the background while the device is locked.
    /// A VoIP push can launch the app on a locked device and open the message
    /// store, and the audio background mode keeps the realtime socket writing
    /// during calls. Under Class A those writes would fail and the store would
    /// not open. The data is a regenerable copy of Cloud state.
    static let backgroundStore = FileProtectionType.completeUntilFirstUserAuthentication

    /// Class B for downloaded attachments. New downloads can still be written
    /// while the device is locked, and a file that is already open stays
    /// readable. A locked read returns nil and only shows the placeholder.
    static let downloadedMedia = FileProtectionType.completeUnlessOpen

    /// Audio cache names end in the attachment name, so the extension
    /// identifies voice and audio files when no MIME type is available.
    static let audioFileExtensions: Set<String> = ["m4a", "aac", "mp3", "wav", "caf", "opus", "ogg"]

    /// Audio stays Class C so auto-advancing voice playback and playback during
    /// a call on a locked screen never fail. Everything else is Class B.
    static func attachment(fileName: String, mimeType: String?) -> FileProtectionType {
        if let mimeType, mimeType.lowercased().hasPrefix("audio/") {
            return backgroundStore
        }
        let fileExtension = (fileName as NSString).pathExtension.lowercased()
        return audioFileExtensions.contains(fileExtension) ? backgroundStore : downloadedMedia
    }

    /// The `Data.write` option that creates a file with `protection`.
    static func writingOption(for protection: FileProtectionType) -> Data.WritingOptions {
        switch protection {
        case .complete:
            return .completeFileProtection
        case .completeUnlessOpen:
            return .completeFileProtectionUnlessOpen
        case .completeUntilFirstUserAuthentication:
            return .completeFileProtectionUntilFirstUserAuthentication
        case FileProtectionType.none:
            return .noFileProtection
        default:
            return []
        }
    }
}
