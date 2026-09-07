// Run with: swiftc src-tauri/native/LivePhotos.swift tests/livePhotoNativeCheck.swift -o /tmp/kordi-live-photo-check && /tmp/kordi-live-photo-check
// Generates its own small test asset. No personal photo library or network access is used.
import AppKit
import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

private func fixture(in directory: URL) throws -> (URL, URL) {
    let photo = directory.appendingPathComponent("test.jpg")
    let video = directory.appendingPathComponent("different-name.mov")
    let identifier = "36C0A362-8A56-45AC-A293-143200000001"
    let width = 320, height = 240
    let photoWidth = 4000, photoHeight = 3000
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(data: nil, width: photoWidth, height: photoHeight, bitsPerComponent: 8,
                            bytesPerRow: photoWidth * 4, space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    context.setFillColor(NSColor.systemTeal.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: photoWidth, height: photoHeight))
    let destination = CGImageDestinationCreateWithURL(photo as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, [
        kCGImagePropertyMakerAppleDictionary: ["17": identifier]
    ] as CFDictionary)
    precondition(CGImageDestinationFinalize(destination))

    let writer = try AVAssetWriter(outputURL: video, fileType: .mov)
    let identity = AVMutableMetadataItem()
    identity.identifier = .quickTimeMetadataContentIdentifier
    identity.value = identifier as NSString
    writer.metadata = [identity]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height
    ])
    let pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height
    ])
    writer.add(input)
    var description: CMFormatDescription?
    let specs: [[String: Any]] = [[
        kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as String: "mdta/com.apple.quicktime.still-image-time",
        kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as String: kCMMetadataBaseDataType_SInt8 as String
    ]]
    precondition(CMMetadataFormatDescriptionCreateWithMetadataSpecifications(allocator: kCFAllocatorDefault,
        metadataType: kCMMetadataFormatType_Boxed, metadataSpecifications: specs as CFArray,
        formatDescriptionOut: &description) == noErr)
    let metadataInput = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil, sourceFormatHint: description)
    let metadata = AVAssetWriterInputMetadataAdaptor(assetWriterInput: metadataInput)
    writer.add(metadataInput)
    precondition(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    let still = AVMutableMetadataItem()
    still.keySpace = .quickTimeMetadata
    still.key = "com.apple.quicktime.still-image-time" as NSString
    still.value = 0 as NSNumber
    still.dataType = kCMMetadataBaseDataType_SInt8 as String
    precondition(metadata.append(AVTimedMetadataGroup(items: [still], timeRange: CMTimeRange(
        start: CMTime(value: 15, timescale: 30), duration: CMTime(value: 1, timescale: 30)))))
    metadataInput.markAsFinished()
    for frame in 0..<30 {
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pixels.pixelBufferPool!, &buffer) == kCVReturnSuccess)
        let pixel = buffer!
        CVPixelBufferLockBaseAddress(pixel, [])
        let surface = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
        surface.setFillColor(NSColor.systemTeal.cgColor)
        surface.fill(CGRect(x: 0, y: 0, width: width, height: height))
        surface.setFillColor(NSColor.white.cgColor)
        surface.fill(CGRect(x: frame * 6, y: 90, width: 50, height: 50))
        CVPixelBufferUnlockBaseAddress(pixel, [])
        precondition(pixels.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)))
    }
    input.markAsFinished()
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting { finished.signal() }
    precondition(finished.wait(timeout: .now() + 30) == .success && writer.status == .completed)
    return (photo, video)
}

@main struct LivePhotoNativeCheck {
    static func main() {
        DispatchQueue.global().async {
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("kordi-live-check-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: directory) }
                let (photo, video) = try fixture(in: directory)
                let json = try JSONSerialization.data(withJSONObject: ["paths": [photo.path, video.path], "directory": directory.path])
                let raw = String(data: json, encoding: .utf8)!.withCString { prepareLivePhotos($0) }!
                defer { freeLivePhotoResult(raw) }
                let response = try JSONSerialization.jsonObject(with: Data(String(cString: raw).utf8)) as! [String: Any]
                precondition(response["error"] == nil, "Native preparation failed")
                let photos = response["photos"] as! [[String: Any]]
                precondition(photos.count == 1, "Pairing must use metadata, not filenames")
                let result = photos[0]
                precondition(result["widthPixels"] as? Int == 4000 && result["heightPixels"] as? Int == 3000, "Dimensions must describe the original, not its thumbnail")
                let resources = result["livePhotoFiles"] as! [String: String]
                let photoUnchanged = try Data(contentsOf: URL(fileURLWithPath: result["path"] as! String)) == Data(contentsOf: photo)
                let videoUnchanged = try Data(contentsOf: URL(fileURLWithPath: resources["videoPath"]!)) == Data(contentsOf: video)
                precondition(photoUnchanged && videoUnchanged)
                if let output = CommandLine.arguments.dropFirst().first {
                    let target = URL(fileURLWithPath: output)
                    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: photo, to: target.appendingPathComponent("live-photo.jpg"))
                    try FileManager.default.copyItem(at: video, to: target.appendingPathComponent("live-photo.mov"))
                    try FileManager.default.copyItem(at: URL(fileURLWithPath: resources["playbackPath"]!), to: target.appendingPathComponent("live-photo.mp4"))
                }
                precondition(FileManager.default.fileExists(atPath: resources["playbackPath"]!))
                print("PASS: PhotoKit accepts generated pair; import preserves both originals and exports MP4 playback")
                exit(0)
            } catch { print("FAIL: native Live Photo check: \(error)"); exit(1) }
        }
        dispatchMain()
    }
}
