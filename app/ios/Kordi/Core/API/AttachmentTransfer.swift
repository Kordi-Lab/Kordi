import AVFoundation
import Foundation
import ImageIO
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
    static let maximumAttachmentBytes = 2 * 1_024 * 1_024
    static let maximumVideoBytes = 2 * 1_024 * 1_024 * 1_024
    static let maximumBatchBytes = maximumVideoBytes
    static let maximumAttachmentCount = 8
    static let maximumExpressiveMediaSourceBytes = 32 * 1_024 * 1_024
    static let maximumImagePixelDimension = 100_000
    static let cameraVideoExportPresets = [
        AVAssetExportPresetPassthrough,
        AVAssetExportPresetMediumQuality,
    ]

    nonisolated static func imagePixelDimensions(data: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              var width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              var height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              (1...maximumImagePixelDimension).contains(width),
              (1...maximumImagePixelDimension).contains(height) else { return nil }
        if let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue,
           (5...8).contains(orientation) {
            swap(&width, &height)
        }
        return (width, height)
    }

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
            let type = values?.contentType
                ?? UTType(filenameExtension: url.pathExtension)
                ?? .data
            let maximumBytes = type.conforms(to: .movie)
                ? maximumVideoBytes
                : maximumAttachmentBytes
            if let fileSize = values?.fileSize, fileSize > maximumBytes {
                throw AttachmentTransferError.fileTooLarge(url.lastPathComponent)
            }
            if type.conforms(to: .movie) {
                let fileSize = values?.fileSize ?? 0
                totalBytes += fileSize
                guard totalBytes <= maximumBatchBytes else {
                    throw AttachmentTransferError.batchTooLarge
                }
                let fileURL = temporaryVideoURL(
                    fileExtension: url.pathExtension.nonEmpty ?? "mp4"
                )
                try FileManager.default.copyItem(at: url, to: fileURL)
                return PendingAttachment(
                    id: UUID().uuidString.lowercased(),
                    name: url.lastPathComponent.nonEmpty ?? "video.mp4",
                    kind: .file,
                    mimeType: type.preferredMIMEType,
                    data: Data(),
                    fileURL: fileURL,
                    previewURL: nil
                )
            }
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            guard data.count <= maximumBytes else {
                throw AttachmentTransferError.fileTooLarge(url.lastPathComponent)
            }
            totalBytes += data.count
            guard totalBytes <= maximumBatchBytes else {
                throw AttachmentTransferError.batchTooLarge
            }

            let mimeType = type.preferredMIMEType
            let kind: ChatAttachmentKind = type.conforms(to: .image) ? .image : .file
            let dimensions = kind == .image ? imagePixelDimensions(data: data) : nil
            return PendingAttachment(
                id: UUID().uuidString.lowercased(),
                name: url.lastPathComponent.nonEmpty ?? (kind == .image ? "image.jpg" : "attachment"),
                kind: kind,
                mimeType: mimeType,
                data: data,
                previewURL: kind == .image ? compressedPreviewDataURL(data: data) : nil,
                widthPixels: dimensions?.width,
                heightPixels: dimensions?.height
            )
        }
    }

    nonisolated static func loadImage(data: Data, suggestedName: String = "Photo.jpg") throws -> PendingAttachment {
        guard let image = UIImage(data: data) else {
            throw AttachmentTransferError.invalidImage
        }
        let encoded = try encodedJPEG(image)
        let dimensions = imagePixelDimensions(data: encoded)
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: jpegName(suggestedName),
            kind: .image,
            mimeType: "image/jpeg",
            data: encoded,
            previewURL: compressedPreviewDataURL(data: encoded),
            widthPixels: dimensions?.width,
            heightPixels: dimensions?.height
        )
    }

    nonisolated static func loadExpressiveMedia(
        data: Data,
        suggestedName: String,
        mimeType: String?,
        expectedKind: ExpressiveMediaLibraryKind
    ) throws -> PendingAttachment {
        let prepared = try prepareExpressiveMedia(
            data: data,
            suggestedName: suggestedName,
            mimeType: mimeType,
            expectedKind: expectedKind
        )
        let dimensions = imagePixelDimensions(data: prepared.data)
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: prepared.name,
            kind: .image,
            subtype: expectedKind == .sticker ? .sticker : nil,
            mimeType: prepared.mimeType,
            data: prepared.data,
            previewURL: compressedPreviewDataURL(data: prepared.data),
            widthPixels: dimensions?.width,
            heightPixels: dimensions?.height
        )
    }

    nonisolated static func prepareExpressiveMedia(
        data: Data,
        suggestedName: String,
        mimeType: String?,
        expectedKind: ExpressiveMediaLibraryKind
    ) throws -> (data: Data, name: String, mimeType: String?) {
        guard ExpressiveMediaLibraryKind.accepts(
            name: suggestedName,
            mimeType: mimeType,
            as: expectedKind
        ) else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        let actualKind = ExpressiveMediaLibraryKind.supportedKind(
            name: suggestedName,
            mimeType: mimeType
        )
        if actualKind == .gif {
            guard data.count <= maximumAttachmentBytes else {
                throw AttachmentTransferError.animatedMediaTooLarge(suggestedName)
            }
            return (data, suggestedName, mimeType)
        }
        let source = CGImageSourceCreateWithData(data as CFData, nil)
        let properties = source.flatMap {
            CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any]
        }
        let maximumPixelDimension = max(
            (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0,
            (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        )
        if maximumPixelDimension <= 512, data.count <= maximumAttachmentBytes {
            return (data, suggestedName, mimeType)
        }
        guard actualKind == .sticker else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        guard data.count <= maximumExpressiveMediaSourceBytes else {
            throw AttachmentTransferError.expressiveMediaSourceTooLarge(suggestedName)
        }
        guard let source,
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: 512,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else {
            throw AttachmentTransferError.invalidImage
        }
        let image = UIImage(cgImage: thumbnail)
        if imageHasAlpha(image) {
            let encoded = try encodedPNG(image)
            return (encoded, replacingExtension(of: suggestedName, with: "png"), "image/png")
        }
        let encoded = try encodedJPEG(
            image,
            attempts: [(512.0, 0.82), (448.0, 0.74), (384.0, 0.66), (320.0, 0.58)]
        )
        return (encoded, replacingExtension(of: suggestedName, with: "jpg"), "image/jpeg")
    }

    nonisolated static func loadCameraImage(_ image: UIImage) throws -> PendingAttachment {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        let encoded = try encodedJPEG(image)
        let dimensions = imagePixelDimensions(data: encoded)
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: "Camera-\(formatter.string(from: Date())).jpg",
            kind: .image,
            mimeType: "image/jpeg",
            data: encoded,
            previewURL: compressedPreviewDataURL(data: encoded),
            widthPixels: dimensions?.width,
            heightPixels: dimensions?.height
        )
    }

    nonisolated static func loadCameraVideo(_ sourceURL: URL) async throws -> PendingAttachment {
        let outputURL = temporaryVideoURL(fileExtension: "mp4")
        let asset = AVURLAsset(url: sourceURL)
        var exportError: Error = AttachmentTransferError.invalidVideo
        var didExport = false
        for preset in cameraVideoExportPresets {
            guard let exporter = AVAssetExportSession(asset: asset, presetName: preset),
                  exporter.supportedFileTypes.contains(.mp4) else { continue }
            do {
                exporter.shouldOptimizeForNetworkUse = true
                try await exporter.export(to: outputURL, as: .mp4)
                let size = try outputURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0 else { throw AttachmentTransferError.invalidVideo }
                guard size <= maximumVideoBytes else {
                    throw AttachmentTransferError.fileTooLarge("This video")
                }
                didExport = true
                break
            } catch {
                exportError = error
                try? FileManager.default.removeItem(at: outputURL)
            }
        }
        guard didExport else { throw exportError }
        let previewURL = await videoPreviewDataURL(asset: AVURLAsset(url: outputURL))
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return PendingAttachment(
            id: UUID().uuidString.lowercased(),
            name: "Video-\(formatter.string(from: Date())).mp4",
            kind: .file,
            mimeType: "video/mp4",
            data: Data(),
            fileURL: outputURL,
            previewURL: previewURL
        )
    }

    private nonisolated static func temporaryVideoURL(fileExtension: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(
            "kordi-video-\(UUID().uuidString.lowercased()).\(fileExtension.lowercased())"
        )
    }

    private nonisolated static func videoPreviewDataURL(asset: AVAsset) async -> String? {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)
        guard let (image, _) = try? await generator.image(at: .zero),
              let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.68) else {
            return nil
        }
        return compressedPreviewDataURL(data: data)
    }

    private nonisolated static func encodedJPEG(
        _ image: UIImage,
        attempts: [(Double, Double)] = [
            (2048.0, 0.84),
            (1800.0, 0.78),
            (1536.0, 0.72),
            (1280.0, 0.66),
            (960.0, 0.6),
        ]
    ) throws -> Data {
        for (edge, quality) in attempts {
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

    private nonisolated static func encodedPNG(_ image: UIImage) throws -> Data {
        for edge in [512.0, 448.0, 384.0, 320.0, 256.0] {
            let scale = min(1, edge / max(image.size.width, image.size.height))
            let size = CGSize(
                width: max(1, image.size.width * scale),
                height: max(1, image.size.height * scale)
            )
            let format = UIGraphicsImageRendererFormat()
            format.opaque = false
            format.scale = 1
            let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            if let data = rendered.pngData(), data.count <= maximumAttachmentBytes {
                return data
            }
        }
        throw AttachmentTransferError.fileTooLarge("This sticker")
    }

    private nonisolated static func imageHasAlpha(_ image: UIImage) -> Bool {
        guard let alphaInfo = image.cgImage?.alphaInfo else { return true }
        switch alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return false
        default:
            return true
        }
    }

    private nonisolated static func replacingExtension(of name: String, with fileExtension: String) -> String {
        let stem = URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent.nonEmpty ?? "sticker"
        return "\(stem).\(fileExtension)"
    }

    private nonisolated static func jpegName(_ value: String) -> String {
        let stem = URL(fileURLWithPath: value).deletingPathExtension().lastPathComponent.nonEmpty ?? "Photo"
        return "\(stem).jpg"
    }

    private nonisolated static func compressedPreviewDataURL(data: Data) -> String? {
        guard let image = UIImage(data: data) else { return nil }
        let preservesAlpha = imageHasAlpha(image)
        for (edge, quality) in [(480.0, 0.66), (360.0, 0.58), (280.0, 0.5)] {
            let scale = min(1, edge / max(image.size.width, image.size.height))
            let size = CGSize(
                width: max(1, image.size.width * scale),
                height: max(1, image.size.height * scale)
            )
            let format = UIGraphicsImageRendererFormat()
            format.opaque = !preservesAlpha
            format.scale = 1
            let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
                if !preservesAlpha {
                    UIColor.systemBackground.setFill()
                    context.cgContext.fill(CGRect(origin: .zero, size: size))
                }
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            let preview = preservesAlpha
                ? rendered.pngData()
                : rendered.jpegData(compressionQuality: quality)
            guard let preview,
                  preview.count <= 255 * 1_024 else { continue }
            let previewMIMEType = preservesAlpha ? "image/png" : "image/jpeg"
            return "data:\(previewMIMEType);base64,\(preview.base64EncodedString())"
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
    case invalidVideo
    case imagesUsePhotoPicker
    case animatedMediaTooLarge(String)
    case expressiveMediaSourceTooLarge(String)

    var errorDescription: String? {
        switch self {
        case let .tooManyFiles(limit):
            "Choose up to \(limit) files at a time."
        case let .fileTooLarge(name):
            "\(name) is larger than the current mobile upload limit."
        case .batchTooLarge:
            "The selected files are larger than the 2 GB mobile upload limit."
        case .missingSession:
            "Sign in again to download this attachment."
        case .invalidImage:
            "This image could not be read. Choose another photo."
        case .invalidVideo:
            "This video could not be prepared as MP4. Record it again or choose another video."
        case .imagesUsePhotoPicker:
            "Add images with Camera or Photo Library. Files is for documents and other files."
        case let .animatedMediaTooLarge(name):
            "Choose an animated GIF smaller than 2 MB for \(name) so its animation can be preserved."
        case let .expressiveMediaSourceTooLarge(name):
            "Choose a sticker image smaller than 32 MB for \(name)."
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

    nonisolated static func accepts(name: String, mimeType: String?, as expectedKind: Self) -> Bool {
        guard let actualKind = supportedKind(name: name, mimeType: mimeType) else { return false }
        return actualKind == expectedKind || (expectedKind == .sticker && actualKind == .gif)
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

enum ExpressiveMediaAttachmentSignature {
    nonisolated static func value(
        name: String,
        mimeType: String?,
        sizeBytes: Int64?
    ) -> String? {
        guard let sizeBytes, sizeBytes >= 0 else { return nil }
        return [
            name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "",
            String(sizeBytes),
        ].joined(separator: "\u{0}")
    }
}

enum ExpressiveMediaLibraryError: LocalizedError {
    case unsupportedFile
    case unavailableStorage

    var errorDescription: String? {
        switch self {
        case .unsupportedFile:
            "Only PNG, JPEG, WebP, and GIF files can be stickers."
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
        let mimeType = values?.contentType?.preferredMIMEType
            ?? UTType(filenameExtension: sourceURL.pathExtension)?.preferredMIMEType
        if let fileSize = values?.fileSize {
            if ExpressiveMediaLibraryKind.supportedKind(
                name: sourceURL.lastPathComponent,
                mimeType: mimeType
            ) == .gif, fileSize > PendingAttachmentLoader.maximumAttachmentBytes {
                throw AttachmentTransferError.animatedMediaTooLarge(sourceURL.lastPathComponent)
            }
            if fileSize > PendingAttachmentLoader.maximumExpressiveMediaSourceBytes {
                throw AttachmentTransferError.expressiveMediaSourceTooLarge(sourceURL.lastPathComponent)
            }
        }
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

    func attachmentSignatures(
        accountId: String,
        kind: ExpressiveMediaLibraryKind
    ) -> Set<String> {
        Set(items(accountId: accountId).compactMap { item in
            guard item.kind == kind else { return nil }
            return ExpressiveMediaAttachmentSignature.value(
                name: item.name,
                mimeType: item.mimeType,
                sizeBytes: item.sizeBytes
            )
        })
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
        guard ExpressiveMediaLibraryKind.accepts(
            name: cloudItem.name,
            mimeType: cloudItem.mimeType,
            as: cloudItem.kind
        ) else {
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
        let prepared = try PendingAttachmentLoader.prepareExpressiveMedia(
            data: data,
            suggestedName: name,
            mimeType: mimeType,
            expectedKind: expectedKind
        )
        let directory = try scopedDirectory(accountId: accountId)
        if let attachmentId,
           let existing = allItems(in: directory).first(where: { $0.attachmentId == attachmentId }) {
            return existing
        }
        let id = UUID().uuidString.lowercased()
        let relativeFileName = "\(id)-\(sanitized(prepared.name))"
        let destinationURL = directory.appendingPathComponent(relativeFileName, isDirectory: false)

        do {
            try prepared.data.write(to: destinationURL, options: .atomic)
            let item = ExpressiveMediaLibraryItem(
                id: id,
                kind: expectedKind,
                name: prepared.name,
                mimeType: prepared.mimeType,
                sizeBytes: Int64(prepared.data.count),
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
