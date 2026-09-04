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

    static func cachedImage(for emoji: BlobEmoji, animated: Bool) -> UIImage? {
        BlobEmojiImageCache.image(for: emoji, animated: animated)
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

private extension NSAttributedString.Key {
    static let blobEmojiToken = NSAttributedString.Key("ai.kordi.blobEmojiToken")
}

enum BlobEmojiComposerText {
    private static let pattern = try! NSRegularExpression(
        pattern: ":blob:([A-Za-z0-9_-]+):"
    )

    static func plainText(_ value: String) -> String {
        let result = NSMutableString(string: value)
        for match in matches(in: value).reversed() {
            result.replaceCharacters(in: match.range, with: "Emoji")
        }
        return result as String
    }

    static func attributedString(_ value: String, font: UIFont) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let source = value as NSString
        var cursor = 0
        for match in matches(in: value) {
            if match.range.location > cursor {
                result.append(styled(source.substring(with: NSRange(
                    location: cursor,
                    length: match.range.location - cursor
                )), font: font))
            }
            let attachment = NSTextAttachment()
            attachment.image = BlobEmojiCatalog.previewImage(
                for: match.emoji,
                size: font.lineHeight
            ) ?? UIImage(systemName: "face.smiling")
            attachment.bounds = CGRect(
                x: 0,
                y: font.descender * 0.35,
                width: font.lineHeight,
                height: font.lineHeight
            )
            let fragment = NSMutableAttributedString(attachment: attachment)
            fragment.addAttribute(
                .blobEmojiToken,
                value: source.substring(with: match.range),
                range: NSRange(location: 0, length: fragment.length)
            )
            result.append(fragment)
            cursor = NSMaxRange(match.range)
        }
        if cursor < source.length {
            result.append(styled(source.substring(from: cursor), font: font))
        }
        return result
    }

    static func rawText(_ value: NSAttributedString) -> String {
        var result = ""
        var cursor = 0
        while cursor < value.length {
            var range = NSRange()
            if let token = value.attribute(
                .blobEmojiToken,
                at: cursor,
                effectiveRange: &range
            ) as? String {
                result += token
            } else {
                result += (value.string as NSString).substring(with: range)
            }
            cursor = NSMaxRange(range)
        }
        return result
    }

    static func containsUnrenderedToken(_ value: NSAttributedString) -> Bool {
        !matches(in: value.string).isEmpty
    }

    static func resetTypingAttributes(of textView: UITextView) {
        textView.typingAttributes = [
            .font: textView.font ?? UIFont.preferredFont(forTextStyle: .body),
            .foregroundColor: UIColor.label
        ]
    }

    static func renderedSelection(
        forRaw selection: NSRange,
        in value: String
    ) -> NSRange {
        let start = renderedLocation(forRaw: selection.location, in: value)
        let end = renderedLocation(
            forRaw: selection.location + selection.length,
            in: value
        )
        return NSRange(location: start, length: max(0, end - start))
    }

    static func rawSelection(
        forRendered selection: NSRange,
        in value: String
    ) -> NSRange {
        let start = rawLocation(forRendered: selection.location, in: value)
        let end = rawLocation(
            forRendered: selection.location + selection.length,
            in: value
        )
        return NSRange(location: start, length: max(0, end - start))
    }

    private static func renderedLocation(forRaw location: Int, in value: String) -> Int {
        var removed = 0
        for match in matches(in: value) {
            if location < match.range.location { break }
            if location <= NSMaxRange(match.range) {
                return match.range.location - removed
                    + (location - match.range.location > match.range.length / 2 ? 1 : 0)
            }
            removed += match.range.length - 1
        }
        return max(0, min((value as NSString).length - removed, location - removed))
    }

    private static func rawLocation(forRendered location: Int, in value: String) -> Int {
        var removed = 0
        for match in matches(in: value) {
            let renderedStart = match.range.location - removed
            if location < renderedStart { break }
            if location <= renderedStart + 1 {
                return location == renderedStart
                    ? match.range.location
                    : NSMaxRange(match.range)
            }
            removed += match.range.length - 1
        }
        return max(0, min((value as NSString).length, location + removed))
    }

    private static func matches(in value: String) -> [BlobEmojiTokenMatch] {
        let source = value as NSString
        return pattern.matches(
            in: value,
            range: NSRange(location: 0, length: source.length)
        ).compactMap { match in
            guard match.numberOfRanges == 2 else { return nil }
            let id = source.substring(with: match.range(at: 1))
            return BlobEmojiCatalog.byID[id].map {
                BlobEmojiTokenMatch(range: match.range, emoji: $0)
            }
        }
    }

    private static func styled(_ value: String, font: UIFont) -> NSAttributedString {
        NSAttributedString(string: value, attributes: [
            .font: font,
            .foregroundColor: UIColor.label
        ])
    }
}

private struct BlobEmojiTokenMatch {
    let range: NSRange
    let emoji: BlobEmoji
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

private extension BlobEmojiCatalog {
    static let previewImageCache: NSCache<NSString, UIImage> = {
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
    let emoji: BlobEmoji
    let size: CGFloat
    @State private var image: UIImage?

    var body: some View {
        let animated = emoji.animated && !reduceMotion
        let displayedImage = BlobEmojiCatalog.cachedImage(
            for: emoji,
            animated: animated
        ) ?? BlobEmojiCatalog.cachedImage(for: emoji, animated: false) ?? image
        Group {
            if let displayedImage {
                if animated {
                    AnimatedUIImage(image: displayedImage)
                } else {
                    Image(uiImage: displayedImage)
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
                animated: animated
            )
        }
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

    private static func frame(
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

    private static func frameDuration(source: CGImageSource, index: Int) -> TimeInterval {
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
        cache.countLimit = 48
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()

    static func image(for emoji: BlobEmoji, animated: Bool) -> UIImage? {
        storage.object(forKey: key(for: emoji, animated: animated))
    }

    static func insert(_ image: UIImage, for emoji: BlobEmoji, animated: Bool, cost: Int) {
        storage.setObject(image, forKey: key(for: emoji, animated: animated), cost: cost)
    }

    private static func key(for emoji: BlobEmoji, animated: Bool) -> NSString {
        "\(emoji.id):\(animated)" as NSString
    }
}

private actor BlobEmojiImageLoader {
    static let shared = BlobEmojiImageLoader()

    func image(for emoji: BlobEmoji, animated: Bool) -> UIImage? {
        if let cached = BlobEmojiImageCache.image(for: emoji, animated: animated) {
            return cached
        }
        guard let url = BlobEmojiCatalog.assetURL(for: emoji) else { return nil }
        let image = AnimatedImageDecoder.image(at: url, animated: animated)
        if let image {
            let cost = (image.images ?? [image]).reduce(0) { total, frame in
                total + (frame.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
            }
            BlobEmojiImageCache.insert(
                image,
                for: emoji,
                animated: animated,
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
