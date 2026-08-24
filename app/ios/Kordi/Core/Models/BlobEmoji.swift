import ImageIO
import SwiftUI
import UIKit

struct BlobEmoji: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let file: String
    let animated: Bool

    var reactionValue: String { "blob:\(id)" }
    var inlineToken: String { ":blob:\(id):" }
    var accessibilityName: String { id.replacingOccurrences(of: "_", with: " ") }

    static func id(fromReactionValue value: String) -> String? {
        guard value.hasPrefix("blob:") else { return nil }
        return String(value.dropFirst(5)).nonEmpty
    }
}

enum BlobEmojiCatalog {
    static let all: [BlobEmoji] = {
        guard let url = Bundle.main.url(
            forResource: "catalog",
            withExtension: "json",
            subdirectory: "blob-emoji"
        ),
        let data = try? Data(contentsOf: url),
        let payload = try? JSONDecoder().decode(Payload.self, from: data),
        payload.schema == 1 else { return [] }
        return payload.emoji
    }()

    static let byID = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    static func emoji(forReactionValue value: String) -> BlobEmoji? {
        BlobEmoji.id(fromReactionValue: value).flatMap { byID[$0] }
    }

    static func matching(_ query: String) -> [BlobEmoji] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return all }
        return all.filter {
            $0.id.localizedCaseInsensitiveContains(normalized)
                || $0.accessibilityName.localizedCaseInsensitiveContains(normalized)
        }
    }

    static func assetURL(for emoji: BlobEmoji) -> URL? {
        Bundle.main.url(
            forResource: emoji.file,
            withExtension: nil,
            subdirectory: "blob-emoji/assets"
        )
    }

    private struct Payload: Decodable {
        let schema: Int
        let emoji: [BlobEmoji]
    }
}

enum BlobEmojiRecentStore {
    static let key = "kordi.blob-emoji.recents"

    static func ids(from storedValue: String) -> [String] {
        guard let data = storedValue.data(using: .utf8),
              let values = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return values.filter { BlobEmojiCatalog.byID[$0] != nil }
    }

    static func recording(_ id: String, in storedValue: String) -> String {
        guard BlobEmojiCatalog.byID[id] != nil else { return storedValue }
        var recent = ids(from: storedValue).filter { $0 != id }
        recent.insert(id, at: 0)
        guard let data = try? JSONEncoder().encode(Array(recent.prefix(24))),
              let encoded = String(data: data, encoding: .utf8) else {
            return storedValue
        }
        return encoded
    }
}

struct BlobEmojiView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let emoji: BlobEmoji
    let size: CGFloat
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                if emoji.animated, !reduceMotion {
                    AnimatedBlobEmojiImage(image: image)
                } else {
                    Image(uiImage: image)
                        .resizable()
                }
            } else {
                Color.clear
            }
        }
        .scaledToFit()
        .frame(width: size, height: size)
        .clipped()
        .task(id: "\(emoji.id):\(reduceMotion)") {
            image = await BlobEmojiImageLoader.shared.image(
                for: emoji,
                animated: emoji.animated && !reduceMotion
            )
        }
        .accessibilityLabel(emoji.accessibilityName)
    }
}

private struct AnimatedBlobEmojiImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> AnimatedBlobUIImageView {
        let view = AnimatedBlobUIImageView()
        view.contentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.image = image
        return view
    }

    func updateUIView(_ uiView: AnimatedBlobUIImageView, context: Context) {
        uiView.image = image
    }
}

private final class AnimatedBlobUIImageView: UIImageView {
    override var intrinsicContentSize: CGSize { .zero }
}

private actor BlobEmojiImageLoader {
    static let shared = BlobEmojiImageLoader()
    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 48
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()

    func image(for emoji: BlobEmoji, animated: Bool) -> UIImage? {
        let key = "\(emoji.id):\(animated)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let url = BlobEmojiCatalog.assetURL(for: emoji),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetCount(source) > 0 else { return nil }
        let image = animated
            ? animatedImage(from: source)
            : CGImageSourceCreateImageAtIndex(source, 0, nil).map(UIImage.init(cgImage:))
        if let image {
            let cost = (image.images ?? [image]).reduce(0) { total, frame in
                total + (frame.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
            }
            cache.setObject(image, forKey: key, cost: cost)
        }
        return image
    }

    private func animatedImage(from source: CGImageSource) -> UIImage? {
        var frames: [UIImage] = []
        var duration = 0.0
        for index in 0..<CGImageSourceGetCount(source) {
            guard let cgImage = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append(UIImage(cgImage: cgImage))
            duration += frameDuration(source: source, index: index)
        }
        guard !frames.isEmpty else { return nil }
        return frames.count == 1
            ? frames[0]
            : UIImage.animatedImage(with: frames, duration: max(duration, 0.1))
    }

    private func frameDuration(source: CGImageSource, index: Int) -> TimeInterval {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let animation = properties[kCGImagePropertyWebPDictionary] as? [CFString: Any]
                ?? properties[kCGImagePropertyGIFDictionary] as? [CFString: Any] else {
            return 0.1
        }
        let duration = animation[kCGImagePropertyWebPUnclampedDelayTime] as? TimeInterval
            ?? animation[kCGImagePropertyWebPDelayTime] as? TimeInterval
            ?? animation[kCGImagePropertyGIFUnclampedDelayTime] as? TimeInterval
            ?? animation[kCGImagePropertyGIFDelayTime] as? TimeInterval
            ?? 0.1
        return max(duration, 0.02)
    }
}
