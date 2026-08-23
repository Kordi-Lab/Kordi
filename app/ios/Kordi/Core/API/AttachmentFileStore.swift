import Foundation
import CryptoKit

actor AttachmentFileStore {
    private let directory: URL?
    private var cachedURLs: [String: URL] = [:]

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        ).first?.appendingPathComponent("Kordi/Attachments", isDirectory: true)
    }

    func cachedURL(for attachment: ChatAttachment, accountId: String) -> URL? {
        let cacheKey = "\(accountId):\(attachment.attachmentId)"
        guard let url = cachedURLs[cacheKey] ?? cacheURL(for: attachment, accountId: accountId) else {
            return nil
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            cachedURLs[cacheKey] = nil
            return nil
        }
        cachedURLs[cacheKey] = url
        return url
    }

    func store(_ data: Data, attachment: ChatAttachment, accountId: String) throws -> URL {
        guard let directory = accountDirectory(accountId) else { throw URLError(.cannotCreateFile) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let url = cacheURL(for: attachment, accountId: accountId) else {
            throw URLError(.cannotCreateFile)
        }
        try data.write(to: url, options: .atomic)
        cachedURLs["\(accountId):\(attachment.attachmentId)"] = url
        return url
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
