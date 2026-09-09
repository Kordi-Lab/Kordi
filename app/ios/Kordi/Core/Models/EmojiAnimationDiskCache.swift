import Foundation
import ImageIO
import UIKit

/// Only public emoji assets belong here, never message attachments or account data.
struct EmojiAnimationDiskCache: Sendable {
    let directory: URL?
    var maximumBytes = 128 * 1_024 * 1_024
    var maximumEntries = 512
    private let maximumEntryBytes = 32 * 1_024 * 1_024
    private let maximumAge: TimeInterval = 30 * 24 * 60 * 60

    static var standard: Self {
        Self(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("prepared-emoji-v1", isDirectory: true))
    }

    private struct Manifest: Codable {
        let version: Int
        let key: String
        let createdAt: Date
        let durations: [TimeInterval]
        let frames: [Data]
    }

    func firstFrame(for request: EmojiAnimationRequest) -> UIImage? {
        guard let folder = folder(for: request),
              let data = boundedData(at: folder.appendingPathComponent("first.png")),
              let image = decodePNG(data, pixelSize: request.pixelSize) else { return nil }
        return image
    }

    func animation(for request: EmojiAnimationRequest) -> PreparedEmojiAnimation? {
        guard let folder = folder(for: request),
              let data = boundedData(at: folder.appendingPathComponent("frames.plist")) else { return nil }
        do {
            let manifest = try PropertyListDecoder().decode(Manifest.self, from: data)
            guard manifest.version == 1, manifest.key == request.cacheKey,
                  manifest.createdAt <= Date().addingTimeInterval(300),
                  Date().timeIntervalSince(manifest.createdAt) < maximumAge,
                  !manifest.frames.isEmpty, manifest.frames.count <= 600,
                  manifest.frames.count == manifest.durations.count,
                  manifest.durations.allSatisfy({ $0.isFinite && $0 >= 0.02 }) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            var frames: [UIImage] = []
            var cost = 0
            for data in manifest.frames {
                guard !Task.isCancelled,
                      let frame = decodePNG(data, pixelSize: request.pixelSize),
                      let cgImage = frame.cgImage else { return nil }
                cost += cgImage.bytesPerRow * cgImage.height
                guard cost <= maximumEntryBytes else { return nil }
                frames.append(frame)
            }
            try? FileManager.default.setAttributes(
                [.modificationDate: Date()], ofItemAtPath: folder.path
            )
            return PreparedEmojiAnimation(frames: frames, durations: manifest.durations)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            return nil
        }
    }

    func store(_ animation: PreparedEmojiAnimation, for request: EmojiAnimationRequest) {
        guard !Task.isCancelled, let folder = folder(for: request),
              animation.memoryCost <= maximumEntryBytes else { return }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer { prune() }
            var encoded: [Data] = []
            var bytes = 0
            for (index, image) in animation.frames.enumerated() {
                guard !Task.isCancelled, let data = image.pngData() else { return }
                bytes += data.count
                guard bytes <= maximumEntryBytes else { return }
                if index == 0 {
                    try data.write(to: folder.appendingPathComponent("first.png"), options: .atomic)
                }
                encoded.append(data)
            }
            let manifest = Manifest(
                version: 1, key: request.cacheKey, createdAt: Date(),
                durations: animation.durations, frames: encoded
            )
            let encoder = PropertyListEncoder()
            encoder.outputFormat = .binary
            let data = try encoder.encode(manifest)
            guard data.count <= maximumEntryBytes else { return }
            try data.write(to: folder.appendingPathComponent("frames.plist"), options: .atomic)
        } catch {
            // A full or unavailable disk must not prevent in-memory playback.
        }
    }

    private func folder(for request: EmojiAnimationRequest) -> URL? {
        directory?.appendingPathComponent(request.cacheKey, isDirectory: true)
    }

    private func boundedData(at url: URL) -> Data? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
              let count = values.fileSize, count > 0, count <= maximumEntryBytes,
              let modified = values.contentModificationDate,
              Date().timeIntervalSince(modified) < maximumAge else { return nil }
        return try? Data(contentsOf: url, options: .mappedIfSafe)
    }

    private func decodePNG(_ data: Data, pixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(
            data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary
        ),
              CGImageSourceGetCount(source) == 1 else { return nil }
        return AnimatedImageDecoder.frame(from: source, index: 0, maximumPixelSize: CGFloat(pixelSize))
    }

    private func prune() {
        guard let directory,
              let folders = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey]
              ) else { return }
        var entries: [(url: URL, date: Date, bytes: Int)] = []
        for folder in folders {
            guard let values = try? folder.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey]),
                  values.isDirectory == true,
                  let files = try? FileManager.default.contentsOfDirectory(
                    at: folder, includingPropertiesForKeys: [.fileSizeKey]
                  ) else { continue }
            let bytes = files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
            entries.append((folder, values.contentModificationDate ?? .distantPast, bytes))
        }
        entries.sort { $0.date < $1.date }
        var bytes = entries.reduce(0) { $0 + $1.bytes }
        var count = entries.count
        for entry in entries {
            guard bytes > maximumBytes || count > maximumEntries
                || Date().timeIntervalSince(entry.date) > maximumAge else { continue }
            if (try? FileManager.default.removeItem(at: entry.url)) != nil {
                bytes -= entry.bytes
                count -= 1
            }
        }
    }
}
