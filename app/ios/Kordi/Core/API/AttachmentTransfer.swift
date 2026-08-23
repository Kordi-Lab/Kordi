import Foundation
import UniformTypeIdentifiers
import UIKit

enum AttachmentPreviewDataURL {
    nonisolated static func decode(_ value: String?) -> Data? {
        guard let value,
              let comma = value.firstIndex(of: ",") else { return nil }
        let metadata = value[..<comma].lowercased()
        guard metadata.hasPrefix("data:image/"), metadata.contains(";base64") else { return nil }
        return Data(
            base64Encoded: String(value[value.index(after: comma)...]),
            options: .ignoreUnknownCharacters
        )
    }
}

enum PendingAttachmentLoader {
    // The authenticated Cloud proxy currently accepts 2 MB request bodies.
    // Keep mobile validation at that contract so uploads fail before leaving
    // the device with a clear, actionable message.
    static let maximumAttachmentBytes = 2 * 1_024 * 1_024
    static let maximumBatchBytes = 12 * 1_024 * 1_024
    static let maximumAttachmentCount = 8

    nonisolated static func loadFiles(urls: [URL]) throws -> [PendingAttachment] {
        let attachments = try load(urls: urls)
        guard attachments.allSatisfy({ $0.kind == .file }) else {
            throw AttachmentTransferError.imagesUsePhotoPicker
        }
        return attachments
    }

    nonisolated static func load(urls: [URL]) throws -> [PendingAttachment] {
        guard urls.count <= maximumAttachmentCount else {
            throw AttachmentTransferError.tooManyFiles(maximumAttachmentCount)
        }

        var totalBytes = 0
        return try urls.map { url in
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }

            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
            if let fileSize = values?.fileSize, fileSize > maximumAttachmentBytes {
                throw AttachmentTransferError.fileTooLarge(url.lastPathComponent)
            }
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            guard data.count <= maximumAttachmentBytes else {
                throw AttachmentTransferError.fileTooLarge(url.lastPathComponent)
            }
            totalBytes += data.count
            guard totalBytes <= maximumBatchBytes else {
                throw AttachmentTransferError.batchTooLarge
            }

            let type = values?.contentType
                ?? UTType(filenameExtension: url.pathExtension)
                ?? .data
            let mimeType = type.preferredMIMEType
            let kind: ChatAttachmentKind = type.conforms(to: .image) ? .image : .file
            return PendingAttachment(
                id: UUID().uuidString.lowercased(),
                name: url.lastPathComponent.nonEmpty ?? (kind == .image ? "image.jpg" : "attachment"),
                kind: kind,
                mimeType: mimeType,
                data: data,
                previewURL: kind == .image ? compressedPreviewDataURL(data: data) : nil
            )
        }
    }

    nonisolated static func loadImage(data: Data, suggestedName: String = "Photo.jpg") throws -> PendingAttachment {
        guard let image = UIImage(data: data) else {
            throw AttachmentTransferError.invalidImage
        }
        let encoded = try encodedJPEG(image)
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: jpegName(suggestedName),
            kind: .image,
            mimeType: "image/jpeg",
            data: encoded,
            previewURL: compressedPreviewDataURL(data: encoded)
        )
    }

    nonisolated static func loadExpressiveMedia(
        data: Data,
        suggestedName: String,
        mimeType: String?,
        expectedKind: ExpressiveMediaLibraryKind
    ) throws -> PendingAttachment {
        guard data.count <= maximumAttachmentBytes else {
            throw AttachmentTransferError.fileTooLarge(suggestedName)
        }
        guard ExpressiveMediaLibraryKind.supportedKind(
            name: suggestedName,
            mimeType: mimeType
        ) == expectedKind else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: suggestedName,
            kind: .image,
            mimeType: mimeType,
            data: data,
            previewURL: compressedPreviewDataURL(data: data)
        )
    }

    nonisolated static func loadCameraImage(_ image: UIImage) throws -> PendingAttachment {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        let encoded = try encodedJPEG(image)
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: "Camera-\(formatter.string(from: Date())).jpg",
            kind: .image,
            mimeType: "image/jpeg",
            data: encoded,
            previewURL: compressedPreviewDataURL(data: encoded)
        )
    }

    private nonisolated static func encodedJPEG(_ image: UIImage) throws -> Data {
        for (edge, quality) in [(2048.0, 0.84), (1800.0, 0.78), (1536.0, 0.72), (1280.0, 0.66), (960.0, 0.6)] {
            let scale = min(1, edge / max(image.size.width, image.size.height))
            let size = CGSize(
                width: max(1, image.size.width * scale),
                height: max(1, image.size.height * scale)
            )
            let format = UIGraphicsImageRendererFormat()
            format.opaque = true
            format.scale = 1
            let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.systemBackground.setFill()
                context.cgContext.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            if let data = rendered.jpegData(compressionQuality: quality),
               data.count <= maximumAttachmentBytes {
                return data
            }
        }
        throw AttachmentTransferError.fileTooLarge("This image")
    }

    private nonisolated static func jpegName(_ value: String) -> String {
        let stem = URL(fileURLWithPath: value).deletingPathExtension().lastPathComponent.nonEmpty ?? "Photo"
        return "\(stem).jpg"
    }

    private nonisolated static func compressedPreviewDataURL(data: Data) -> String? {
        guard let image = UIImage(data: data) else { return nil }
        for (edge, quality) in [(480.0, 0.66), (360.0, 0.58), (280.0, 0.5)] {
            let scale = min(1, edge / max(image.size.width, image.size.height))
            let size = CGSize(
                width: max(1, image.size.width * scale),
                height: max(1, image.size.height * scale)
            )
            let format = UIGraphicsImageRendererFormat()
            format.opaque = true
            format.scale = 1
            let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.systemBackground.setFill()
                context.cgContext.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            guard let preview = rendered.jpegData(compressionQuality: quality),
                  preview.count <= 255 * 1_024 else { continue }
            return "data:image/jpeg;base64,\(preview.base64EncodedString())"
        }
        return nil
    }
}

enum AttachmentTransferError: LocalizedError {
    case tooManyFiles(Int)
    case fileTooLarge(String)
    case batchTooLarge
    case missingSession
    case invalidImage
    case imagesUsePhotoPicker

    var errorDescription: String? {
        switch self {
        case let .tooManyFiles(limit):
            "Choose up to \(limit) files at a time."
        case let .fileTooLarge(name):
            "\(name) is larger than the current 2 MB Cloud upload limit."
        case .batchTooLarge:
            "The selected files are larger than the 12 MB mobile upload limit."
        case .missingSession:
            "Sign in again to download this attachment."
        case .invalidImage:
            "This image could not be read. Choose another photo."
        case .imagesUsePhotoPicker:
            "Add images with Camera or Photo Library. Files is for documents and other files."
        }
    }
}

enum ExpressiveMediaLibraryKind: String, Codable, Hashable {
    case sticker
    case gif

    nonisolated static func supportedKind(name: String, mimeType: String?) -> Self? {
        let normalizedMIMEType = mimeType?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let fileExtension = URL(fileURLWithPath: name).pathExtension.lowercased()
        let stickerMIMETypes: Set<String> = ["image/jpeg", "image/jpg", "image/png", "image/webp"]
        let stickerExtensions: Set<String> = ["jpeg", "jpg", "png", "webp"]
        if let normalizedMIMEType, !normalizedMIMEType.isEmpty {
            if normalizedMIMEType == "image/gif",
               fileExtension.isEmpty || fileExtension == "gif" {
                return .gif
            }
            if stickerMIMETypes.contains(normalizedMIMEType),
               fileExtension.isEmpty || stickerExtensions.contains(fileExtension) {
                return .sticker
            }
            return nil
        }
        if fileExtension == "gif" { return .gif }
        if stickerExtensions.contains(fileExtension) { return .sticker }
        return nil
    }

    var libraryName: String {
        switch self {
        case .sticker: "My Stickers"
        case .gif: "My GIFs"
        }
    }
}

struct ExpressiveMediaLibraryItem: Identifiable, Codable, Hashable {
    let id: String
    let kind: ExpressiveMediaLibraryKind
    let name: String
    let mimeType: String?
    let sizeBytes: Int64
    let relativeFileName: String
    let createdAt: Date
    let cloudItemId: String?
    let attachmentId: String?
}

struct ExpressiveMediaLibraryEntry: Identifiable, Hashable {
    let item: ExpressiveMediaLibraryItem
    let fileURL: URL

    var id: String { item.id }
    var kind: ExpressiveMediaLibraryKind { item.kind }
}

enum ExpressiveMediaLibraryError: LocalizedError {
    case unsupportedFile
    case unavailableStorage

    var errorDescription: String? {
        switch self {
        case .unsupportedFile:
            "Only PNG, JPEG, and WebP files can be stickers. GIF files are saved to My GIFs."
        case .unavailableStorage:
            "Kordi could not access the media library on this device."
        }
    }
}

actor ExpressiveMediaLibraryStore {
    private let rootDirectory: URL?
    private let indexName = "library.json"
    private let legacyMigrationMarkerName = "legacy-library-migrated"

    init(directory: URL? = nil) {
        self.rootDirectory = directory ?? FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first?.appendingPathComponent("Kordi/ExpressiveMedia", isDirectory: true)
    }

    func add(
        accountId: String,
        fileAt sourceURL: URL,
        attachment: ChatAttachment
    ) throws -> ExpressiveMediaLibraryItem {
        guard let kind = ExpressiveMediaLibraryKind.supportedKind(
            name: attachment.name,
            mimeType: attachment.mimeType
        ) else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        let data = try Data(contentsOf: sourceURL, options: [.mappedIfSafe])
        return try add(
            accountId: accountId,
            data: data,
            name: attachment.name,
            mimeType: attachment.mimeType,
            expectedKind: kind,
            attachmentId: attachment.attachmentId
        )
    }

    func add(
        accountId: String,
        fileAt sourceURL: URL,
        expectedKind: ExpressiveMediaLibraryKind
    ) throws -> ExpressiveMediaLibraryItem {
        let accessed = sourceURL.startAccessingSecurityScopedResource()
        defer { if accessed { sourceURL.stopAccessingSecurityScopedResource() } }

        let values = try? sourceURL.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        if let fileSize = values?.fileSize,
           fileSize > PendingAttachmentLoader.maximumAttachmentBytes {
            throw AttachmentTransferError.fileTooLarge(sourceURL.lastPathComponent)
        }
        let mimeType = values?.contentType?.preferredMIMEType
            ?? UTType(filenameExtension: sourceURL.pathExtension)?.preferredMIMEType
        let data = try Data(contentsOf: sourceURL, options: [.mappedIfSafe])
        return try add(
            accountId: accountId,
            data: data,
            name: sourceURL.lastPathComponent,
            mimeType: mimeType,
            expectedKind: expectedKind,
            attachmentId: nil
        )
    }

    func add(
        accountId: String,
        attachment: PendingAttachment,
        expectedKind: ExpressiveMediaLibraryKind
    ) throws -> ExpressiveMediaLibraryItem {
        try add(
            accountId: accountId,
            data: attachment.data,
            name: attachment.name,
            mimeType: attachment.mimeType,
            expectedKind: expectedKind,
            attachmentId: nil
        )
    }

    func items(accountId: String) -> [ExpressiveMediaLibraryItem] {
        guard let directory = try? scopedDirectory(accountId: accountId) else { return [] }
        return allItems(in: directory).filter {
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent($0.relativeFileName).path
            )
        }
    }

    func entries(
        accountId: String,
        kind: ExpressiveMediaLibraryKind? = nil
    ) -> [ExpressiveMediaLibraryEntry] {
        guard let directory = try? scopedDirectory(accountId: accountId) else { return [] }
        return allItems(in: directory).compactMap { item in
            guard kind == nil || item.kind == kind else { return nil }
            let fileURL = directory.appendingPathComponent(item.relativeFileName, isDirectory: false)
            guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
            return ExpressiveMediaLibraryEntry(item: item, fileURL: fileURL)
        }
    }

    func pendingAttachment(
        accountId: String,
        for item: ExpressiveMediaLibraryItem
    ) throws -> PendingAttachment {
        let directory = try scopedDirectory(accountId: accountId)
        let savedItem = allItems(in: directory).first { $0.id == item.id }
        guard let savedItem else { throw ExpressiveMediaLibraryError.unavailableStorage }
        let fileURL = directory.appendingPathComponent(savedItem.relativeFileName, isDirectory: false)
        let data = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
        return try PendingAttachmentLoader.loadExpressiveMedia(
            data: data,
            suggestedName: savedItem.name,
            mimeType: savedItem.mimeType,
            expectedKind: savedItem.kind
        )
    }

    func markSynced(
        accountId: String,
        itemId: String,
        cloudItem: CloudExpressiveMediaItem
    ) throws {
        let directory = try scopedDirectory(accountId: accountId)
        var savedItems = allItems(in: directory)
        guard let index = savedItems.firstIndex(where: { $0.id == itemId }) else { return }
        let local = savedItems[index]
        savedItems[index] = ExpressiveMediaLibraryItem(
            id: local.id,
            kind: cloudItem.kind,
            name: cloudItem.name,
            mimeType: cloudItem.mimeType,
            sizeBytes: cloudItem.sizeBytes,
            relativeFileName: local.relativeFileName,
            createdAt: local.createdAt,
            cloudItemId: cloudItem.itemId,
            attachmentId: cloudItem.attachmentId
        )
        try write(savedItems, to: directory)
    }

    func markUploaded(accountId: String, itemId: String, attachmentId: String) throws {
        let directory = try scopedDirectory(accountId: accountId)
        var savedItems = allItems(in: directory)
        guard let index = savedItems.firstIndex(where: { $0.id == itemId }) else { return }
        let local = savedItems[index]
        savedItems[index] = ExpressiveMediaLibraryItem(
            id: local.id,
            kind: local.kind,
            name: local.name,
            mimeType: local.mimeType,
            sizeBytes: local.sizeBytes,
            relativeFileName: local.relativeFileName,
            createdAt: local.createdAt,
            cloudItemId: local.cloudItemId,
            attachmentId: attachmentId
        )
        try write(savedItems, to: directory)
    }

    func importCloudItem(
        accountId: String,
        cloudItem: CloudExpressiveMediaItem,
        data: Data
    ) throws {
        guard data.count <= PendingAttachmentLoader.maximumAttachmentBytes else {
            throw AttachmentTransferError.fileTooLarge(cloudItem.name)
        }
        guard ExpressiveMediaLibraryKind.supportedKind(
            name: cloudItem.name,
            mimeType: cloudItem.mimeType
        ) == cloudItem.kind else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        let directory = try scopedDirectory(accountId: accountId)
        var savedItems = allItems(in: directory)
        let existingIndex = savedItems.firstIndex {
            $0.attachmentId == cloudItem.attachmentId || $0.cloudItemId == cloudItem.itemId
        }
        let relativeFileName = existingIndex.map { savedItems[$0].relativeFileName }
            ?? "\(sanitized(cloudItem.itemId))-\(sanitized(cloudItem.name))"
        let destinationURL = directory.appendingPathComponent(relativeFileName, isDirectory: false)
        try data.write(to: destinationURL, options: .atomic)

        let item = ExpressiveMediaLibraryItem(
            id: existingIndex.map { savedItems[$0].id } ?? cloudItem.itemId,
            kind: cloudItem.kind,
            name: cloudItem.name,
            mimeType: cloudItem.mimeType,
            sizeBytes: Int64(data.count),
            relativeFileName: relativeFileName,
            createdAt: existingIndex.map { savedItems[$0].createdAt } ?? cloudCreatedAt(cloudItem.createdAt),
            cloudItemId: cloudItem.itemId,
            attachmentId: cloudItem.attachmentId
        )
        if let existingIndex {
            savedItems[existingIndex] = item
        } else {
            savedItems.append(item)
            savedItems.sort { $0.createdAt > $1.createdAt }
        }
        try write(savedItems, to: directory)
    }

    private func add(
        accountId: String,
        data: Data,
        name: String,
        mimeType: String?,
        expectedKind: ExpressiveMediaLibraryKind,
        attachmentId: String?
    ) throws -> ExpressiveMediaLibraryItem {
        guard data.count <= PendingAttachmentLoader.maximumAttachmentBytes else {
            throw AttachmentTransferError.fileTooLarge(name)
        }
        guard ExpressiveMediaLibraryKind.supportedKind(
            name: name,
            mimeType: mimeType
        ) == expectedKind else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        let directory = try scopedDirectory(accountId: accountId)
        if let attachmentId,
           let existing = allItems(in: directory).first(where: { $0.attachmentId == attachmentId }) {
            return existing
        }
        let id = UUID().uuidString.lowercased()
        let relativeFileName = "\(id)-\(sanitized(name))"
        let destinationURL = directory.appendingPathComponent(relativeFileName, isDirectory: false)

        do {
            try data.write(to: destinationURL, options: .atomic)
            let item = ExpressiveMediaLibraryItem(
                id: id,
                kind: expectedKind,
                name: name,
                mimeType: mimeType,
                sizeBytes: Int64(data.count),
                relativeFileName: relativeFileName,
                createdAt: Date(),
                cloudItemId: nil,
                attachmentId: attachmentId
            )
            var savedItems = allItems(in: directory)
            savedItems.insert(item, at: 0)
            try write(savedItems, to: directory)
            return item
        } catch {
            try? FileManager.default.removeItem(at: destinationURL)
            throw error
        }
    }

    private func scopedDirectory(accountId: String) throws -> URL {
        guard let rootDirectory else { throw ExpressiveMediaLibraryError.unavailableStorage }
        try FileManager.default.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        let directory = rootDirectory.appendingPathComponent(
            "account-\(sanitized(accountId))",
            isDirectory: true
        )
        try migrateLegacyLibraryIfNeeded(to: directory, rootDirectory: rootDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func migrateLegacyLibraryIfNeeded(to directory: URL, rootDirectory: URL) throws {
        let destinationIndex = directory.appendingPathComponent(indexName)
        let marker = rootDirectory.appendingPathComponent(legacyMigrationMarkerName)
        guard !FileManager.default.fileExists(atPath: marker.path) else { return }
        let legacyIndex = rootDirectory.appendingPathComponent(indexName)
        guard let data = try? Data(contentsOf: legacyIndex),
              let legacyItems = try? JSONDecoder().decode([ExpressiveMediaLibraryItem].self, from: data) else {
            return
        }
        if !FileManager.default.fileExists(atPath: destinationIndex.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var migratedItems: [ExpressiveMediaLibraryItem] = []
            for item in legacyItems {
                let source = rootDirectory.appendingPathComponent(item.relativeFileName)
                let destination = directory.appendingPathComponent(item.relativeFileName)
                guard FileManager.default.fileExists(atPath: source.path) else { continue }
                if !FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.copyItem(at: source, to: destination)
                }
                migratedItems.append(item)
            }
            try write(migratedItems, to: directory)
        }
        try Data().write(to: marker, options: .atomic)
    }

    private func allItems(in directory: URL) -> [ExpressiveMediaLibraryItem] {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(indexName)),
              let items = try? JSONDecoder().decode([ExpressiveMediaLibraryItem].self, from: data) else {
            return []
        }
        return items
    }

    private func write(_ items: [ExpressiveMediaLibraryItem], to directory: URL) throws {
        let encoded = try JSONEncoder().encode(items)
        try encoded.write(to: directory.appendingPathComponent(indexName), options: .atomic)
    }

    private func cloudCreatedAt(_ value: String) -> Date {
        parseCloudDate(value)
    }

    private func sanitized(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        let result = value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
        return result.nonEmpty ?? "media"
    }
}
