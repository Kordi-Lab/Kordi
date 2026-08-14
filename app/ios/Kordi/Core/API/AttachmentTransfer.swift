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

actor AttachmentFileStore {
    private let directory: URL?
    private var cachedURLs: [String: URL] = [:]

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        ).first?.appendingPathComponent("Kordi/Attachments", isDirectory: true)
    }

    func cachedURL(for attachmentId: String) -> URL? {
        guard let url = cachedURLs[attachmentId], FileManager.default.fileExists(atPath: url.path) else {
            cachedURLs[attachmentId] = nil
            return nil
        }
        return url
    }

    func store(_ data: Data, attachment: ChatAttachment) throws -> URL {
        guard let directory else { throw URLError(.cannotCreateFile) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeId = sanitized(attachment.attachmentId, fallback: "attachment")
        let safeName = sanitized(attachment.name, fallback: attachment.kind == .image ? "image.jpg" : "file")
        let url = directory.appendingPathComponent("\(safeId)-\(safeName)", isDirectory: false)
        try data.write(to: url, options: .atomic)
        cachedURLs[attachment.attachmentId] = url
        return url
    }

    private func sanitized(_ value: String, fallback: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        let result = value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
        return result.nonEmpty ?? fallback
    }
}
