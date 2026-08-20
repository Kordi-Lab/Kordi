import UIKit

enum SignupAvatarRenderer {
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
