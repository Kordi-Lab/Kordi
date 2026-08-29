import Foundation
import CryptoKit

actor AttachmentFileStore {
    private static let memoryEntryLimit = 256
    private static let defaultDiskByteLimit: Int64 = 512 * 1024 * 1024

    private let directory: URL?
    private let diskByteLimit: Int64
    private var cachedURLs: [String: URL] = [:]
    private var recentCacheKeys: [String] = []

    init(directory: URL? = nil, diskByteLimit: Int64? = nil) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        ).first?.appendingPathComponent("Kordi/Attachments", isDirectory: true)
        self.diskByteLimit = diskByteLimit ?? Self.defaultDiskByteLimit
    }

    func cachedURL(for attachment: ChatAttachment, accountId: String) -> URL? {
        let cacheKey = "\(accountId):\(attachment.attachmentId)"
        guard let url = cachedURLs[cacheKey] ?? cacheURL(for: attachment, accountId: accountId) else {
            return nil
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            cachedURLs[cacheKey] = nil
            recentCacheKeys.removeAll { $0 == cacheKey }
            return nil
        }
        remember(url, for: cacheKey)
        return url
    }

    func store(_ data: Data, attachment: ChatAttachment, accountId: String) throws -> URL {
        guard let directory = accountDirectory(accountId) else { throw URLError(.cannotCreateFile) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let url = cacheURL(for: attachment, accountId: accountId) else {
            throw URLError(.cannotCreateFile)
        }
        try data.write(to: url, options: .atomic)
        remember(url, for: "\(accountId):\(attachment.attachmentId)")
        pruneDiskCache(protecting: url)
        return url
    }

    func store(fileAt sourceURL: URL, attachment: ChatAttachment, accountId: String) throws -> URL {
        guard let directory = accountDirectory(accountId) else { throw URLError(.cannotCreateFile) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let url = cacheURL(for: attachment, accountId: accountId) else {
            throw URLError(.cannotCreateFile)
        }
        let temporaryURL = directory.appendingPathComponent(".\(UUID().uuidString).download")
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        try FileManager.default.copyItem(at: sourceURL, to: temporaryURL)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: url)
        remember(url, for: "\(accountId):\(attachment.attachmentId)")
        pruneDiskCache(protecting: url)
        return url
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

    private func cacheURL(for attachment: ChatAttachment, accountId: String) -> URL? {
        let safeId = sanitized(attachment.attachmentId, fallback: "attachment")
        let safeName = sanitized(
            attachment.name,
            fallback: attachment.kind == .image ? "image.jpg" : "file"
        )
        return accountDirectory(accountId)?.appendingPathComponent("\(safeId)-\(safeName)", isDirectory: false)
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
