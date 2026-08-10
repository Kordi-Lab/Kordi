import UIKit

enum SignupAvatarRenderer {
    static let colors: [(background: UIColor, foreground: UIColor)] = [
        (UIColor(red: 0.96, green: 0.28, blue: 0.58, alpha: 1), .white),
        (UIColor(red: 0.15, green: 0.66, blue: 0.74, alpha: 1), .white),
        (UIColor(red: 0.96, green: 0.64, blue: 0.12, alpha: 1), UIColor(red: 0.16, green: 0.13, blue: 0.06, alpha: 1)),
        (UIColor(red: 0.50, green: 0.45, blue: 0.76, alpha: 1), .white)
    ]

    static func initials(for displayName: String) -> String {
        let parts = displayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace)
        let initials = parts.prefix(2).compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "K" : initials.uppercased()
    }

    static func generatedDataURL(displayName: String, paletteIndex: Int) -> String? {
        let side: CGFloat = 256
        let palette = colors[abs(paletteIndex) % colors.count]
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let image = renderer.image { context in
            palette.background.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))

            let value = initials(for: displayName) as NSString
            let font = UIFont.systemFont(ofSize: value.length > 1 ? 82 : 98, weight: .semibold)
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: palette.foreground
            ]
            let textSize = value.size(withAttributes: attributes)
            value.draw(
                at: CGPoint(x: (side - textSize.width) / 2, y: (side - textSize.height) / 2),
                withAttributes: attributes
            )
        }
        guard let data = image.pngData() else { return nil }
        return "data:image/png;base64,\(data.base64EncodedString())"
    }

    static func uploadedImage(from data: Data) -> (image: UIImage, dataURL: String)? {
        guard let source = UIImage(data: data) else { return nil }
        let side: CGFloat = 384
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let image = renderer.image { _ in
            let scale = max(side / source.size.width, side / source.size.height)
            let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
            source.draw(in: CGRect(
                x: (side - size.width) / 2,
                y: (side - size.height) / 2,
                width: size.width,
                height: size.height
            ))
        }
        for quality in stride(from: 0.82, through: 0.42, by: -0.10) {
            if let encoded = image.jpegData(compressionQuality: quality), encoded.count <= 190_000 {
                return (image, "data:image/jpeg;base64,\(encoded.base64EncodedString())")
            }
        }
        return nil
    }
}
