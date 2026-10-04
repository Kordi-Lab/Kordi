import Foundation
import CryptoKit
import UIKit

enum AttachmentCacheVariant: String, Sendable {
    case preview
    case original
}

/// Downloaded attachments are Class B (`completeUnlessOpen`), except audio,
/// which stays Class C. See `LocalDataProtectionClass` for the reasons.
actor AttachmentFileStore {
    private static let memoryEntryLimit = 256
    private static let defaultDiskByteLimit: Int64 = 512 * 1024 * 1024

    private let directory: URL?
    private let diskByteLimit: Int64
    private let protection: any LocalDataProtecting
    private var cachedURLs: [String: URL] = [:]
    private var recentCacheKeys: [String] = []
    /// The one-time protection upgrade for files cached by earlier builds.
    private(set) var protectionUpgrade: Task<Bool, Never>?

    init(
        directory: URL? = nil,
        diskByteLimit: Int64? = nil,
        protection: any LocalDataProtecting = SystemLocalDataProtection()
    ) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        ).first?.appendingPathComponent("Kordi/Attachments", isDirectory: true)
        self.diskByteLimit = diskByteLimit ?? Self.defaultDiskByteLimit
        self.protection = protection
    }

    func cachedURL(
        for attachment: ChatAttachment,
        accountId: String,
        variant: AttachmentCacheVariant = .original
    ) -> URL? {
        scheduleProtectionUpgradeIfNeeded()
        let key = cacheKey(for: attachment, accountId: accountId, variant: variant)
        guard let url = cachedURLs[key]
            ?? cacheURL(for: attachment, accountId: accountId, variant: variant) else {
            return nil
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            cachedURLs[key] = nil
            recentCacheKeys.removeAll { $0 == key }
            return nil
        }
        remember(url, for: key)
        return url
    }

    func bestCachedURL(
        for attachment: ChatAttachment,
        accountId: String,
        preferredVariant: AttachmentCacheVariant
    ) -> URL? {
        scheduleProtectionUpgradeIfNeeded()
        if preferredVariant == .preview,
           let original = cachedURL(
               for: attachment,
               accountId: accountId,
               variant: .original
           ) {
            return original
        }
        return cachedURL(for: attachment, accountId: accountId, variant: preferredVariant)
    }

    func store(
        _ data: Data,
        attachment: ChatAttachment,
        accountId: String,
        variant: AttachmentCacheVariant = .original
    ) throws -> URL {
        scheduleProtectionUpgradeIfNeeded()
        guard let directory = accountDirectory(accountId) else { throw URLError(.cannotCreateFile) }
        try prepareAccountDirectory(directory)
        guard let url = cacheURL(for: attachment, accountId: accountId, variant: variant) else {
            throw URLError(.cannotCreateFile)
        }
        let fileProtection = Self.fileProtection(for: attachment)
        try data.write(
            to: url,
            options: [.atomic, LocalDataProtectionClass.writingOption(for: fileProtection)]
        )
        protection.apply(fileProtection, to: url)
        remember(url, for: cacheKey(for: attachment, accountId: accountId, variant: variant))
        pruneDiskCache(protecting: url)
        return url
    }

    func cacheUploadedOriginals(
        drafts: [PendingAttachment],
        uploaded: [CloudMessageAttachment],
        accountId: String
    ) {
        for (draft, result) in zip(drafts, uploaded) where draft.kind == .image || draft.isMP4Video {
            try? cacheOriginals(draft, attachment: result.chatAttachment, accountId: accountId)
        }
    }

    func cachePendingOriginals(_ drafts: [PendingAttachment], accountId: String) throws {
        for draft in drafts {
            try cacheOriginals(draft, attachment: draft.optimisticAttachment, accountId: accountId)
        }
    }

    private func cacheOriginals(_ draft: PendingAttachment, attachment: ChatAttachment, accountId: String) throws {
        if let fileURL = draft.fileURL {
            _ = try store(fileAt: fileURL, attachment: attachment, accountId: accountId)
        } else if !draft.data.isEmpty {
            _ = try store(draft.data, attachment: attachment, accountId: accountId)
        }
        if let files = draft.livePhotoFiles, let live = attachment.livePhoto {
            for (url, resource) in [(files.videoURL, live.video), (files.playbackURL, live.playback)] {
                _ = try store(fileAt: url, attachment: resource.chatAttachment, accountId: accountId)
            }
        }
    }

    func store(
        fileAt sourceURL: URL,
        attachment: ChatAttachment,
        accountId: String,
        variant: AttachmentCacheVariant = .original
    ) throws -> URL {
        scheduleProtectionUpgradeIfNeeded()
        guard let directory = accountDirectory(accountId) else { throw URLError(.cannotCreateFile) }
        try prepareAccountDirectory(directory)
        guard let url = cacheURL(for: attachment, accountId: accountId, variant: variant) else {
            throw URLError(.cannotCreateFile)
        }
        let temporaryURL = directory.appendingPathComponent(".\(UUID().uuidString).download")
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        try FileManager.default.copyItem(at: sourceURL, to: temporaryURL)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: url)
        // A copy keeps the source file's class, so set the cache class after the move.
        protection.apply(Self.fileProtection(for: attachment), to: url)
        remember(url, for: cacheKey(for: attachment, accountId: accountId, variant: variant))
        pruneDiskCache(protecting: url)
        return url
    }

    private func prepareAccountDirectory(_ directory: URL) throws {
        try protection.prepareDirectory(
            directory,
            protection: LocalDataProtectionClass.downloadedMedia,
            excludeFromBackup: false
        )
    }

    private static func fileProtection(for attachment: ChatAttachment) -> FileProtectionType {
        LocalDataProtectionClass.attachment(fileName: attachment.name, mimeType: attachment.mimeType)
    }

    private func scheduleProtectionUpgradeIfNeeded() {
        guard protectionUpgrade == nil, let directory else { return }
        let protection = protection
        protectionUpgrade = Task.detached(priority: .utility) {
            AttachmentProtectionUpgrade.run(in: directory, protection: protection)
        }
    }

    private func remember(_ url: URL, for key: String) {
        recentCacheKeys.removeAll { $0 == key }
        recentCacheKeys.append(key)
        cachedURLs[key] = url
        while recentCacheKeys.count > Self.memoryEntryLimit {
            cachedURLs[recentCacheKeys.removeFirst()] = nil
        }
    }

    private func pruneDiskCache(protecting protectedURL: URL) {
        guard let directory,
              let enumerator = FileManager.default.enumerator(
                at: directory,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                options: [.skipsHiddenFiles]
              ) else { return }
        let files = enumerator.compactMap { value -> (URL, Int64, Date)? in
            guard let url = value as? URL,
                  let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]),
                  values.isRegularFile == true else { return nil }
            return (url, Int64(values.fileSize ?? 0), values.contentModificationDate ?? .distantPast)
        }
        var total = files.reduce(Int64(0)) { $0 + $1.1 }
        for (url, size, _) in files.sorted(by: { $0.2 < $1.2 })
            where total > diskByteLimit && url != protectedURL {
            if (try? FileManager.default.removeItem(at: url)) != nil {
                total -= size
            }
        }
    }

    private func cacheKey(
        for attachment: ChatAttachment,
        accountId: String,
        variant: AttachmentCacheVariant
    ) -> String {
        "\(accountId):\(attachment.attachmentId):\(variant.rawValue)"
    }

    private func cacheURL(
        for attachment: ChatAttachment,
        accountId: String,
        variant: AttachmentCacheVariant
    ) -> URL? {
        let safeId = sanitized(attachment.attachmentId, fallback: "attachment")
        let safeName = sanitized(
            attachment.name,
            fallback: attachment.kind == .image ? "image.jpg" : "file"
        )
        return accountDirectory(accountId)?.appendingPathComponent(
            "\(safeId)-\(variant.rawValue)-\(safeName)",
            isDirectory: false
        )
    }

    private func accountDirectory(_ accountId: String) -> URL? {
        guard let directory, !accountId.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(accountId.utf8)).prefix(16)
            .map { String(format: "%02x", $0) }
            .joined()
        return directory.appendingPathComponent(digest, isDirectory: true)
    }

    private func sanitized(_ value: String, fallback: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        let result = value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
        return result.nonEmpty ?? fallback
    }
}

/// Upgrades attachment files cached by earlier builds to their current class.
/// The marker is written only when every file succeeds, so a pass that runs
/// before the first unlock, or that hits any other failure, retries on the
/// next launch.
enum AttachmentProtectionUpgrade {
    static let markerName = ".protection-v1"

    @discardableResult
    static func run(
        in directory: URL,
        protection: any LocalDataProtecting,
        fileManager: FileManager = .default
    ) -> Bool {
        let marker = directory.appendingPathComponent(markerName, isDirectory: false)
        var isDirectory: ObjCBool = false
        guard !fileManager.fileExists(atPath: marker.path),
              fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return true }
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        guard let enumerator = fileManager.enumerator(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return false }
        var succeeded = protection.apply(LocalDataProtectionClass.downloadedMedia, to: directory)
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: keys) else {
                // A file pruned during the pass needs no upgrade.
                if fileManager.fileExists(atPath: url.path) { succeeded = false }
                continue
            }
            guard values.isSymbolicLink != true else { continue }
            let target: FileProtectionType
            if values.isDirectory == true {
                target = LocalDataProtectionClass.downloadedMedia
            } else if values.isRegularFile == true {
                target = LocalDataProtectionClass.attachment(fileName: url.lastPathComponent, mimeType: nil)
            } else {
                continue
            }
            if !protection.apply(target, to: url) { succeeded = false }
        }
        guard succeeded else { return false }
        return fileManager.createFile(atPath: marker.path, contents: Data())
    }
}

actor ExpressiveMediaThumbnailLoader {
    static let shared = ExpressiveMediaThumbnailLoader()
    private static let prewarmLimit = 24
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 96
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    static func cachedImage(at url: URL) -> UIImage? {
        cache.object(forKey: cacheKey(for: url) as NSString)
    }

    func image(at url: URL) async -> UIImage? {
        let key = Self.cacheKey(for: url)
        if let cached = Self.cache.object(forKey: key as NSString) { return cached }
        if let task = inFlight[key] { return await task.value }
        let task = Task.detached(priority: .utility) {
            AnimatedImageDecoder.image(at: url, animated: false, maximumPixelSize: 240)
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if let image {
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            Self.cache.setObject(image, forKey: key as NSString, cost: cost)
        }
        return image
    }

    static func prewarm(_ urls: [URL]) async {
        await withTaskGroup(of: Void.self) { group in
            for url in urls.prefix(prewarmLimit) {
                group.addTask { _ = await shared.image(at: url) }
            }
        }
    }

    private static func cacheKey(for url: URL) -> String {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        return [
            url.path,
            values?.fileSize.map(String.init) ?? "",
            values?.contentModificationDate?.timeIntervalSince1970.description ?? "",
        ].joined(separator: "\u{0}")
    }
}

enum MessageAttachmentImageLoader {
    static func image(
        at url: URL,
        attachment: ChatAttachment,
        reduceMotion: Bool
    ) async -> UIImage? {
        let isAnimatedGIF = MessageImageInteraction.isAnimatedGIF(attachment)
        if attachment.subtype == .sticker, !isAnimatedGIF {
            return await ExpressiveMediaThumbnailLoader.shared.image(at: url)
        }
        return await Task.detached(priority: .utility) {
            isAnimatedGIF
                ? AnimatedImageDecoder.image(
                    at: url,
                    animated: !reduceMotion,
                    maximumPixelSize: 512
                )
                : AttachmentImageDecoder.downsampledImage(at: url, maximumPixelSize: 1_200)
        }.value
    }
}

extension ExpressiveMediaLibraryStore {
    func prewarmThumbnails(accountId: String) async {
        await ExpressiveMediaThumbnailLoader.prewarm(
            entries(accountId: accountId).map(\.fileURL)
        )
    }
}
