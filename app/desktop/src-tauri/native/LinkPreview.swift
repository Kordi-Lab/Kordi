import Foundation
import ImageIO
@preconcurrency import LinkPresentation
import UniformTypeIdentifiers

// Rust calls this bridge on a blocking worker. The condition protects every
// access to the result; late framework callbacks cannot overwrite a timeout.
private final class LinkPreviewResult: @unchecked Sendable {
    private let condition = NSCondition()
    private var completed = false
    private var result: Data?

    func preserveTitle(_ value: [String: String]) {
        let data = try? JSONSerialization.data(withJSONObject: value)
        condition.lock()
        defer { condition.unlock() }
        guard !completed else { return }
        result = data
    }

    func finish(_ value: [String: String]) {
        let data = try? JSONSerialization.data(withJSONObject: value)
        condition.lock()
        defer { condition.unlock() }
        guard !completed else { return }
        if !value.isEmpty || result == nil { result = data }
        completed = true
        condition.signal()
    }

    func wait() -> Data? {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(13)
        while !completed {
            if !condition.wait(until: deadline) {
                completed = true
                break
            }
        }
        return result
    }
}

private func previewThumbnail(_ data: Data) -> String? {
    guard data.count <= 8 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 480,
            kCGImageSourceShouldCacheImmediately: true
          ] as CFDictionary) else { return nil }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        output, UTType.jpeg.identifier as CFString, 1, nil
    ) else { return nil }
    CGImageDestinationAddImage(destination, image, [
        kCGImageDestinationLossyCompressionQuality: 0.78
    ] as CFDictionary)
    guard CGImageDestinationFinalize(destination), output.length <= 160 * 1024 else { return nil }
    return "data:image/jpeg;base64," + (output as Data).base64EncodedString()
}

// The returned C string belongs to Rust until kordi_free_link_preview_result.
@_cdecl("kordi_fetch_link_preview")
public func fetchLinkPreview(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    guard !Thread.isMainThread,
          let url = URL(string: String(cString: input)), url.scheme == "https" else { return nil }
    let result = LinkPreviewResult()
    DispatchQueue.main.async {
        let provider = LPMetadataProvider()
        provider.timeout = 10
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            provider.cancel()
            result.finish([:])
        }
        // The main-queue deadline retains and cancels the provider, including
        // when artwork loading stalls. Framework callbacks only share result.
        provider.startFetchingMetadata(for: url) { metadata, _ in
            var value: [String: String] = [:]
            if let title = metadata?.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                value["title"] = String(title.prefix(200))
            }
            guard let artwork = metadata?.imageProvider,
                  let type = artwork.registeredTypeIdentifiers.first(where: {
                      UTType($0)?.conforms(to: .image) == true
                  }) else {
                result.finish(value)
                return
            }
            result.preserveTitle(value)
            let text = value
            artwork.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                var value = text
                if let data, let thumbnail = previewThumbnail(data) {
                    value["imageDataUrl"] = thumbnail
                }
                result.finish(value)
            }
        }
    }
    guard let data = result.wait(), let json = String(data: data, encoding: .utf8) else { return nil }
    return strdup(json)
}

@_cdecl("kordi_free_link_preview_result")
public func freeLinkPreviewResult(_ result: UnsafeMutablePointer<CChar>) { free(result) }
