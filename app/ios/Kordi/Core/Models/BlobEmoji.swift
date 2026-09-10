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
        payload.schema == 2 else { return [] }
        return payload.emoji
    }()

    static let byID = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
    static let defaultQuickReactions = Array(all.lazy.filter { !$0.animated }.prefix(6))

    static func quickReactions(storedRecentEmojiIDs: String) -> [BlobEmoji] {
        let recent = BlobEmojiRecentStore.ids(from: storedRecentEmojiIDs)
            .compactMap { byID[$0] }
        return Array(
            (recent + defaultQuickReactions.filter { !recent.contains($0) }).prefix(6)
        )
    }

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

    static func cachedImage(
        for emoji: BlobEmoji,
        animated: Bool,
        maximumPixelSize: CGFloat? = nil
    ) -> UIImage? {
        BlobEmojiImageCache.image(
            for: emoji,
            animated: animated,
            maximumPixelSize: maximumPixelSize
        )
    }

    static func prewarmQuickReactions(storedRecentEmojiIDs: String) async {
        await BlobEmojiImageLoader.shared.prewarm(
            quickReactions(storedRecentEmojiIDs: storedRecentEmojiIDs)
        )
    }

    private struct Payload: Decodable {
        let schema: Int
        let emoji: [BlobEmoji]
    }
}

struct BlobEmojiPreviewText: View {
    @ScaledMetric(relativeTo: .subheadline) private var emojiSize = 18.0
    let text: String

    var body: some View {
        KordiMarkdownParser.parseInline(text).reduce(Text("")) { result, part in
            switch part {
            case let .blobEmoji(emoji):
                guard let image = BlobEmojiCatalog.previewImage(for: emoji, size: emojiSize) else {
                    return result + Text("Emoji")
                }
                return result + Text(Image(uiImage: image)).baselineOffset(-emojiSize / 6)
            case let .notoEmoji(emoji):
                return result + Text(verbatim: emoji.value)
            case let .text(value), let .code(value), let .strong(value), let .emphasis(value):
                return result + Text(value)
            case let .link(label, _):
                return result + Text(label)
            }
        }
    }
}

extension BlobEmojiCatalog {
    private static let previewImageCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 64
        return cache
    }()

    static func previewImage(for emoji: BlobEmoji, size: CGFloat) -> UIImage? {
        let key = "\(emoji.id):\(Int(size.rounded()))" as NSString
        if let cached = previewImageCache.object(forKey: key) { return cached }
        guard let url = assetURL(for: emoji),
              let source = AnimatedImageDecoder.image(
                at: url,
                animated: false,
                maximumPixelSize: size * UIScreen.main.scale
              ) else { return nil }
        let image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
            source.draw(in: CGRect(origin: .zero, size: CGSize(width: size, height: size)))
        }
        previewImageCache.setObject(image, forKey: key)
        return image
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
    @Environment(\.displayScale) private var displayScale
    let emoji: BlobEmoji
    let size: CGFloat

    var body: some View {
        let animated = emoji.animated && !reduceMotion
        let sources = BlobEmojiCatalog.assetURL(for: emoji).map {
            [EmojiAnimationRequest.Source(url: $0, mediaType: nil)]
        } ?? []
        SharedEmojiAnimationView(
            request: EmojiAnimationRequest(
                identifier: "blob:\(emoji.id)", revision: "bundled-v2",
                pixelSize: min(512, max(1, Int((size * displayScale).rounded(.up)))),
                animated: animated, sources: sources
            ),
            fallback: "",
            size: size,
            initialImage: BlobEmojiCatalog.cachedImage(for: emoji, animated: false)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(emoji.accessibilityName)
    }
}

struct AnimatedUIImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> AnimatedUIImageView {
        let view = AnimatedUIImageView()
        view.contentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.image = image
        return view
    }

    func updateUIView(_ uiView: AnimatedUIImageView, context: Context) {
        uiView.image = image
    }
}

final class AnimatedUIImageView: UIImageView {
    override var intrinsicContentSize: CGSize { .zero }
}

enum AnimatedImageDecoder {
    static func isAnimated(at url: URL) -> Bool {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return false }
        return CGImageSourceGetCount(source) > 1
    }

    static func image(
        at url: URL,
        animated: Bool,
        maximumPixelSize: CGFloat? = nil
    ) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return image(from: source, animated: animated, maximumPixelSize: maximumPixelSize)
    }

    static func image(
        from source: CGImageSource,
        animated: Bool,
        maximumPixelSize: CGFloat? = nil
    ) -> UIImage? {
        let count = CGImageSourceGetCount(source)
        guard count > 0 else { return nil }
        if !animated || count == 1 {
            return frame(from: source, index: 0, maximumPixelSize: maximumPixelSize)
        }
        var frames: [UIImage] = []
        var duration = 0.0
        for index in 0..<count {
            guard let frame = frame(
                from: source,
                index: index,
                maximumPixelSize: maximumPixelSize
            ) else { continue }
            frames.append(frame)
            duration += frameDuration(source: source, index: index)
        }
        guard !frames.isEmpty else { return nil }
        return frames.count == 1
            ? frames[0]
            : UIImage.animatedImage(with: frames, duration: max(duration, 0.1))
    }

    static func frame(
        from source: CGImageSource,
        index: Int,
        maximumPixelSize: CGFloat?
    ) -> UIImage? {
        if let maximumPixelSize {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            return CGImageSourceCreateThumbnailAtIndex(
                source,
                index,
                options as CFDictionary
            ).map(UIImage.init(cgImage:))
        }
        return CGImageSourceCreateImageAtIndex(source, index, nil).map(UIImage.init(cgImage:))
    }

    static func frameDuration(source: CGImageSource, index: Int) -> TimeInterval {
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

private enum BlobEmojiImageCache {
    private static let storage: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 192
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()

    static func image(
        for emoji: BlobEmoji,
        animated: Bool,
        maximumPixelSize: CGFloat? = nil
    ) -> UIImage? {
        storage.object(forKey: key(
            for: emoji,
            animated: animated,
            maximumPixelSize: maximumPixelSize
        ))
    }

    static func insert(
        _ image: UIImage,
        for emoji: BlobEmoji,
        animated: Bool,
        maximumPixelSize: CGFloat? = nil,
        cost: Int
    ) {
        storage.setObject(
            image,
            forKey: key(
                for: emoji,
                animated: animated,
                maximumPixelSize: maximumPixelSize
            ),
            cost: cost
        )
    }

    private static func key(
        for emoji: BlobEmoji,
        animated: Bool,
        maximumPixelSize: CGFloat?
    ) -> NSString {
        let pixelSize = maximumPixelSize.map { String(Int($0.rounded(.up))) } ?? "original"
        return "\(emoji.id):\(animated):\(pixelSize)" as NSString
    }
}

private actor BlobEmojiImageLoader {
    static let shared = BlobEmojiImageLoader()

    func image(
        for emoji: BlobEmoji,
        animated: Bool,
        maximumPixelSize: CGFloat? = nil
    ) -> UIImage? {
        if let cached = BlobEmojiImageCache.image(
            for: emoji,
            animated: animated,
            maximumPixelSize: maximumPixelSize
        ) {
            return cached
        }
        guard let url = BlobEmojiCatalog.assetURL(for: emoji) else { return nil }
        let image = AnimatedImageDecoder.image(
            at: url,
            animated: animated,
            maximumPixelSize: maximumPixelSize
        )
        if let image {
            let cost = (image.images ?? [image]).reduce(0) { total, frame in
                total + (frame.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
            }
            BlobEmojiImageCache.insert(
                image,
                for: emoji,
                animated: animated,
                maximumPixelSize: maximumPixelSize,
                cost: cost
            )
        }
        return image
    }

    func prewarm(_ emojis: [BlobEmoji]) {
        for emoji in emojis {
            guard !Task.isCancelled else { return }
            _ = image(for: emoji, animated: false)
        }
    }

}
