import Foundation
import ImageIO
import UIKit

struct PhotoLibraryEdit {
    let image: UIImage
    let data: Data
    let suggestedName: String
}

struct PhotoEditorStroke: Identifiable, Equatable {
    let id = UUID()
    var points: [CGPoint]
}

enum PhotoEditorCropCorner {
    case topLeading
    case topTrailing
    case bottomLeading
    case bottomTrailing
}

enum PhotoEditorCrop {
    static let full = CGRect(x: 0, y: 0, width: 1, height: 1)
    static let initial = CGRect(x: 0.06, y: 0.06, width: 0.88, height: 0.88)
    static let minimumSide: CGFloat = 0.12

    static func moved(_ rect: CGRect, translation: CGSize, canvasSize: CGSize) -> CGRect {
        guard canvasSize.width > 0, canvasSize.height > 0 else { return rect }
        return CGRect(
            x: min(max(0, rect.minX + translation.width / canvasSize.width), 1 - rect.width),
            y: min(max(0, rect.minY + translation.height / canvasSize.height), 1 - rect.height),
            width: rect.width,
            height: rect.height
        )
    }

    static func resized(
        _ rect: CGRect,
        corner: PhotoEditorCropCorner,
        translation: CGSize,
        canvasSize: CGSize
    ) -> CGRect {
        guard canvasSize.width > 0, canvasSize.height > 0 else { return rect }
        let dx = translation.width / canvasSize.width
        let dy = translation.height / canvasSize.height
        var minX = rect.minX
        var minY = rect.minY
        var maxX = rect.maxX
        var maxY = rect.maxY
        switch corner {
        case .topLeading:
            minX = min(max(0, minX + dx), maxX - minimumSide)
            minY = min(max(0, minY + dy), maxY - minimumSide)
        case .topTrailing:
            maxX = max(min(1, maxX + dx), minX + minimumSide)
            minY = min(max(0, minY + dy), maxY - minimumSide)
        case .bottomLeading:
            minX = min(max(0, minX + dx), maxX - minimumSide)
            maxY = max(min(1, maxY + dy), minY + minimumSide)
        case .bottomTrailing:
            maxX = max(min(1, maxX + dx), minX + minimumSide)
            maxY = max(min(1, maxY + dy), minY + minimumSide)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

enum PhotoEditorRenderer {
    static func downsampledImage(data: Data, maximumPixelSize: CGFloat = 4_096) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: image)
    }

    static func applying(_ strokes: [PhotoEditorStroke], to image: UIImage) -> UIImage {
        guard !strokes.isEmpty else { return image }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = 1
        return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: image.size))
            image.draw(in: CGRect(origin: .zero, size: image.size))

            let cgContext = context.cgContext
            cgContext.setStrokeColor(UIColor.systemRed.cgColor)
            cgContext.setFillColor(UIColor.systemRed.cgColor)
            cgContext.setLineCap(.round)
            cgContext.setLineJoin(.round)
            let lineWidth = max(3, min(image.size.width, image.size.height) * 0.006)
            cgContext.setLineWidth(lineWidth)
            for stroke in strokes where !stroke.points.isEmpty {
                let points = stroke.points.map {
                    CGPoint(x: $0.x * image.size.width, y: $0.y * image.size.height)
                }
                if points.count == 1, let point = points.first {
                    let radius = lineWidth / 2
                    cgContext.fillEllipse(
                        in: CGRect(
                            x: point.x - radius,
                            y: point.y - radius,
                            width: radius * 2,
                            height: radius * 2
                        )
                    )
                    continue
                }
                cgContext.beginPath()
                cgContext.move(to: points[0])
                for point in points.dropFirst() {
                    cgContext.addLine(to: point)
                }
                cgContext.strokePath()
            }
        }
    }

    static func rotatedClockwise(_ image: UIImage) -> UIImage {
        let size = CGSize(width: image.size.height, height: image.size.width)
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))
            context.cgContext.translateBy(x: size.width / 2, y: size.height / 2)
            context.cgContext.rotate(by: .pi / 2)
            image.draw(
                in: CGRect(
                    x: -image.size.width / 2,
                    y: -image.size.height / 2,
                    width: image.size.width,
                    height: image.size.height
                )
            )
        }
    }

    static func cropped(_ image: UIImage, to normalizedRect: CGRect) -> UIImage {
        let normalized = normalizedRect.standardized.intersection(PhotoEditorCrop.full)
        guard normalized.width > 0,
              normalized.height > 0,
              normalized.width < 0.999 || normalized.height < 0.999 else { return image }
        let cropRect = CGRect(
            x: normalized.minX * image.size.width,
            y: normalized.minY * image.size.height,
            width: normalized.width * image.size.width,
            height: normalized.height * image.size.height
        ).integral
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = 1
        return UIGraphicsImageRenderer(size: cropRect.size, format: format).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: cropRect.size))
            image.draw(at: CGPoint(x: -cropRect.minX, y: -cropRect.minY))
        }
    }
}
