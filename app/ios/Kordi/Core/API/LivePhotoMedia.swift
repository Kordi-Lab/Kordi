import AVFoundation
import Photos
import UIKit
import UniformTypeIdentifiers

enum LivePhotoMedia {
    static let maximumPhotoBytes = 32 * 1024 * 1024
    static let maximumMotionBytes = 256 * 1024 * 1024

    static func fromLibrary(_ asset: PHAsset) async throws -> PHLivePhoto {
        let photo: PHLivePhoto = try await withCheckedThrowingContinuation { continuation in
            let options = PHLivePhotoRequestOptions()
            options.version = .current
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            PHImageManager.default().requestLivePhoto(for: asset, targetSize: PHImageManagerMaximumSize,
                                                      contentMode: .aspectFit, options: options) { photo, info in
                if info?[PHImageResultIsDegradedKey] as? Bool == true { return }
                if let photo { continuation.resume(returning: photo) }
                else { continuation.resume(throwing: info?[PHImageErrorKey] as? Error ?? AttachmentTransferError.invalidImage) }
            }
        }
        try Task.checkCancellation()
        return photo
    }

    static func fromFiles(photo: URL, video: URL) async throws -> PHLivePhoto {
        let live: PHLivePhoto = try await withCheckedThrowingContinuation { continuation in
            PHLivePhoto.request(withResourceFileURLs: [photo, video], placeholderImage: nil,
                                targetSize: .zero, contentMode: .aspectFit) { result, info in
                if info[PHLivePhotoInfoIsDegradedKey] as? Bool == true { return }
                if let result { continuation.resume(returning: result) }
                else { continuation.resume(throwing: AttachmentTransferError.invalidImage) }
            }
        }
        try Task.checkCancellation()
        return live
    }

    static func load(_ asset: PHAsset) async throws -> PendingAttachment {
        let live = try await fromLibrary(asset)
        // Resources from the current PHLivePhoto remain an internally consistent pair, including edits.
        let resources = PHAssetResource.assetResources(for: live)
        guard let photo = resources.first(where: { $0.type == .photo || $0.type == .fullSizePhoto }),
              let video = resources.first(where: { $0.type == .pairedVideo || $0.type == .fullSizePairedVideo }) else {
            throw AttachmentTransferError.invalidImage
        }
        let photoURL = temporaryURL(extension: UTType(photo.uniformTypeIdentifier)?.preferredFilenameExtension ?? "heic")
        let videoURL = temporaryURL(extension: "mov")
        var playbackURL: URL?
        do {
            try await export(photo, to: photoURL)
            try await export(video, to: videoURL)
            let attachment = try await loadPair(photo: photoURL, video: videoURL, name: photo.originalFilename)
            playbackURL = attachment.livePhotoFiles?.playbackURL
            try Task.checkCancellation()
            return attachment
        } catch {
            for url in [photoURL, videoURL, playbackURL].compactMap({ $0 }) { try? FileManager.default.removeItem(at: url) }
            throw error
        }
    }

    static func loadPair(photo: URL, video: URL, name: String) async throws -> PendingAttachment {
        try checkSize(photo, maximum: maximumPhotoBytes)
        try checkSize(video, maximum: maximumMotionBytes)
        _ = try await fromFiles(photo: photo, video: video)
        let data = try Data(contentsOf: photo, options: .mappedIfSafe)
        let preview = try PendingAttachmentLoader.loadImage(data: data, suggestedName: name)
        let output = temporaryURL(extension: "mp4")
        do {
            let asset = AVURLAsset(url: video)
            // H.264/AAC rendition for webviews; the untouched MOV remains the native Live Photo resource.
            guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080) else {
                throw AttachmentTransferError.invalidVideo
            }
            exporter.shouldOptimizeForNetworkUse = true
            try await exporter.export(to: output, as: .mp4)
            try checkSize(output, maximum: maximumMotionBytes)
            try Task.checkCancellation()
            var attachment = PendingAttachment(id: UUID().uuidString, name: name, kind: .image,
                                               mimeType: UTType(filenameExtension: photo.pathExtension)?.preferredMIMEType ?? "image/jpeg",
                                               data: Data(), fileURL: photo, previewURL: preview.previewURL,
                                               widthPixels: preview.widthPixels, heightPixels: preview.heightPixels)
            attachment.livePhotoFiles = LivePhotoFiles(videoURL: video, playbackURL: output)
            return attachment
        } catch {
            try? FileManager.default.removeItem(at: output)
            throw error
        }
    }

    private static func export(_ resource: PHAssetResource, to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = true
            PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        try Task.checkCancellation()
    }

    static func checkSize(_ url: URL, maximum: Int) throws {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= maximum else { throw AttachmentTransferError.fileTooLarge(url.lastPathComponent) }
    }

    static func temporaryURL(extension ext: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("kordi-live-\(UUID().uuidString).\(ext)")
    }
}
