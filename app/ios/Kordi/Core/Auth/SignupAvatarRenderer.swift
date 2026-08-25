import ImageIO
import UIKit

enum SignupAvatarRenderer {
    static let maximumSourceBytes = 2 * 1_024 * 1_024
    private static let maximumSourcePixels = 24_000_000
    private static let uploadTargetBytes = 190_000

    static func uploadedImage(from data: Data) -> (image: UIImage, dataURL: String)? {
        guard !data.isEmpty, data.count <= maximumSourceBytes,
              let source = CGImageSourceCreateWithData(
                data as CFData,
                [kCGImageSourceShouldCache: false] as CFDictionary
              ),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0,
              width.multipliedReportingOverflow(by: height).overflow == false,
              width * height <= maximumSourcePixels,
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: 512
                ] as CFDictionary
              ) else { return nil }
        let sourceImage = UIImage(cgImage: thumbnail)
        for side in [512, 384, 256] {
            let image = squareImage(sourceImage, side: CGFloat(side))
            for quality in stride(from: 0.84, through: 0.34, by: -0.10) {
                if let encoded = image.jpegData(compressionQuality: quality),
                   encoded.count <= uploadTargetBytes {
                    return (image, "data:image/jpeg;base64,\(encoded.base64EncodedString())")
                }
            }
        }
        return nil
    }

    private static func squareImage(_ source: UIImage, side: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(
            size: CGSize(width: side, height: side),
            format: format
        ).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            let scale = max(side / source.size.width, side / source.size.height)
            let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
            source.draw(in: CGRect(
                x: (side - size.width) / 2,
                y: (side - size.height) / 2,
                width: size.width,
                height: size.height
            ))
        }
    }
}
