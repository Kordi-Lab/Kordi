import AppKit
import AVFoundation
import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

private struct ImportRequest: Decodable { let paths: [String]; let directory: String }
private enum LiveError: Error { case invalid, timeout }

private func validPair(_ photo: URL, _ video: URL) throws -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var valid = false
    let request = PHLivePhoto.request(withResourceFileURLs: [photo, video], placeholderImage: nil,
                                     targetSize: CGSize(width: 64, height: 64), contentMode: .aspectFit) { live, info in
        if info[PHLivePhotoInfoIsDegradedKey] as? Bool == true { return }
        valid = live != nil
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 15) == .success else {
        PHLivePhoto.cancelRequest(withRequestID: request)
        throw LiveError.timeout
    }
    return valid
}

private func exportPlayback(_ source: URL, to output: URL) throws {
    guard let exporter = AVAssetExportSession(asset: AVURLAsset(url: source), presetName: AVAssetExportPreset1920x1080) else {
        throw LiveError.invalid
    }
    exporter.outputURL = output
    exporter.outputFileType = .mp4
    exporter.shouldOptimizeForNetworkUse = true
    let semaphore = DispatchSemaphore(value: 0)
    exporter.exportAsynchronously { semaphore.signal() }
    guard semaphore.wait(timeout: .now() + 120) == .success else {
        exporter.cancelExport()
        throw LiveError.timeout
    }
    guard exporter.status == .completed else { throw LiveError.invalid }
}

private func checkSize(_ url: URL, maximum: Int) throws {
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0, size <= maximum else { throw LiveError.invalid }
}

private func prepare(_ input: ImportRequest) throws -> [[String: Any]] {
    guard input.paths.count <= 16 else { throw LiveError.invalid }
    let urls = input.paths.map { URL(fileURLWithPath: $0) }
    let photos = urls.filter { ["heic", "heif", "jpg", "jpeg"].contains($0.pathExtension.lowercased()) }
    let videos = urls.filter { $0.pathExtension.lowercased() == "mov" }
    var result: [[String: Any]] = []
    var used: Set<URL> = []
    var created: [URL] = []
    var succeeded = false
    defer { if !succeeded { created.forEach { try? FileManager.default.removeItem(at: $0) } } }
    // ponytail: pair scans are bounded to 16 files; batch larger selections if needed. PhotoKit validates metadata.
    for photo in photos {
        try checkSize(photo, maximum: 32 * 1024 * 1024)
        for video in videos where !used.contains(video) {
            try checkSize(video, maximum: 256 * 1024 * 1024)
            guard try validPair(photo, video) else { continue }
            let base = URL(fileURLWithPath: input.directory).appendingPathComponent("kordi-live-\(UUID().uuidString)")
            let storedPhoto = base.appendingPathExtension(photo.pathExtension)
            let storedVideo = base.appendingPathExtension("mov")
            let playback = base.appendingPathExtension("mp4")
            created += [storedPhoto, storedVideo, playback]
            try FileManager.default.copyItem(at: photo, to: storedPhoto)
            try FileManager.default.copyItem(at: video, to: storedVideo)
            try exportPlayback(storedVideo, to: playback)
            try checkSize(playback, maximum: 256 * 1024 * 1024)
            guard let source = CGImageSourceCreateWithURL(storedPhoto as CFURL, nil) else { throw LiveError.invalid }
            var thumbnail: CGImage?
            var preview: Data?
            for (dimension, quality) in [(960, 0.72), (640, 0.58), (320, 0.5)] {
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: dimension
                ] as CFDictionary) else { throw LiveError.invalid }
                let bytes = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { throw LiveError.invalid }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { throw LiveError.invalid }
                if bytes.length <= 260_000 { thumbnail = image; preview = bytes as Data; break }
            }
            guard let image = thumbnail, let preview else { throw LiveError.invalid }
            result.append([
                "sourcePhotoPath": photo.path, "sourceVideoPath": video.path,
                "path": storedPhoto.path, "name": photo.lastPathComponent,
                "kind": "image", "mimeType": UTType(filenameExtension: photo.pathExtension)?.preferredMIMEType ?? "image/jpeg",
                "sizeBytes": try storedPhoto.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0,
                "previewUrl": "data:image/jpeg;base64," + preview.base64EncodedString(),
                "widthPixels": image.width, "heightPixels": image.height,
                "livePhotoFiles": ["videoPath": storedVideo.path, "playbackPath": playback.path]
            ])
            used.insert(video)
            break
        }
    }
    succeeded = true
    return result
}

// Called on a Rust blocking worker, never on the AppKit main thread. Photos callbacks remain free to run.
@_cdecl("kordi_prepare_live_photos")
public func prepareLivePhotos(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let output: [String: Any]
    do {
        let request = try JSONDecoder().decode(ImportRequest.self, from: Data(String(cString: input).utf8))
        output = ["photos": try prepare(request)]
    } catch {
        output = ["error": "Could not prepare this Live Photo. Select a matching original photo and MOV (photo up to 32 MiB, motion up to 256 MiB) and try again."]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: output), let json = String(data: data, encoding: .utf8) else { return nil }
    return strdup(json)
}

@_cdecl("kordi_free_live_photo_result")
public func freeLivePhotoResult(_ result: UnsafeMutablePointer<CChar>) { free(result) }
