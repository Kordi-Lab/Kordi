import Foundation
import ImageIO
import SwiftUI
import UIKit

struct NotoEmoji: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let value: String
    let name: String
    let keywords: [String]
    let category: String

    var searchText: String {
        ([name, category] + keywords).joined(separator: " ")
    }
}

enum NotoEmojiAssetFormat: String, Sendable {
    case png
    case webp
    case gif

    var mediaType: String { "image/\(rawValue)" }
}

enum NotoEmojiCatalog {
    private static let cdnOrigin = "https://fonts.gstatic.com"

    static let all: [NotoEmoji] = {
        guard let url = Bundle.main.url(
            forResource: "catalog",
            withExtension: "json",
            subdirectory: "noto-emoji"
        ),
        let data = try? Data(contentsOf: url),
        let payload = try? JSONDecoder().decode(Payload.self, from: data),
        payload.schema == 1 else { return [] }
        return payload.emoji.filter { validID($0.id) && !$0.value.isEmpty }
    }()

    static let byID = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
    static let byValue = Dictionary(uniqueKeysWithValues: all.map { ($0.value, $0) })
    static let representative = byID["1f600"] ?? all.first

    static func matching(_ query: String) -> [NotoEmoji] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return all }
        return all.filter { $0.searchText.localizedCaseInsensitiveContains(normalized) }
    }

    static func assetURL(for emoji: NotoEmoji, format: NotoEmojiAssetFormat) -> URL? {
        guard byID[emoji.id]?.value == emoji.value else { return nil }
        return URL(string: "\(cdnOrigin)/s/e/notoemoji/latest/\(emoji.id)/512.\(format.rawValue)")
    }

    private static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.split(separator: "_").allSatisfy { codepoint in
            !codepoint.isEmpty && codepoint.allSatisfy(\.isHexDigit)
        }
    }

    private struct Payload: Decodable {
        let schema: Int
        let emoji: [NotoEmoji]
    }
}

enum EmojiPickerItem: Hashable, Identifiable {
    case noto(NotoEmoji)
    case blob(BlobEmoji)

    static let notoItems = NotoEmojiCatalog.all.map(EmojiPickerItem.noto)
    static let blobItems = BlobEmojiCatalog.all.map(EmojiPickerItem.blob)

    var id: String {
        switch self {
        case .noto(let emoji): "noto:\(emoji.id)"
        case .blob(let emoji): "blob:\(emoji.id)"
        }
    }

    var storageID: String {
        switch self {
        case .noto(let emoji): "noto:\(emoji.id)"
        case .blob(let emoji): emoji.id
        }
    }

    var accessibilityName: String {
        switch self {
        case .noto(let emoji): emoji.name
        case .blob(let emoji): emoji.accessibilityName
        }
    }

    var composerValue: String {
        switch self {
        case .noto(let emoji): emoji.value
        case .blob(let emoji): emoji.inlineToken
        }
    }

    var reactionValue: String {
        switch self {
        case .noto(let emoji): emoji.value
        case .blob(let emoji): emoji.reactionValue
        }
    }

    var searchText: String {
        switch self {
        case .noto(let emoji): emoji.searchText
        case .blob(let emoji): emoji.accessibilityName
        }
    }

    var isBlob: Bool {
        if case .blob = self { return true }
        return false
    }

    fileprivate var isStaticBlob: Bool {
        if case .blob(let emoji) = self { return !emoji.animated }
        return false
    }

    init?(storageID: String) {
        if storageID.hasPrefix("noto:"),
           let emoji = NotoEmojiCatalog.byID[String(storageID.dropFirst(5))] {
            self = .noto(emoji)
        } else if let emoji = BlobEmojiCatalog.byID[storageID] {
            self = .blob(emoji)
        } else {
            return nil
        }
    }

    init?(reactionValue: String) {
        if let emoji = BlobEmojiCatalog.emoji(forReactionValue: reactionValue) {
            self = .blob(emoji)
        } else if let emoji = NotoEmojiCatalog.byValue[reactionValue] {
            self = .noto(emoji)
        } else {
            return nil
        }
    }
}

enum EmojiRecentStore {
    static let key = BlobEmojiRecentStore.key

    static func items(from storedValue: String) -> [EmojiPickerItem] {
        rawIDs(from: storedValue).compactMap(EmojiPickerItem.init(storageID:)).prefix(24).map { $0 }
    }

    static func recording(_ item: EmojiPickerItem, in storedValue: String) -> String {
        let existing = rawIDs(from: storedValue).filter {
            $0 != item.storageID && EmojiPickerItem(storageID: $0) != nil
        }
        guard let data = try? JSONEncoder().encode(Array(([item.storageID] + existing).prefix(24))),
              let encoded = String(data: data, encoding: .utf8) else {
            return storedValue
        }
        return encoded
    }

    static func quickReactions(from storedValue: String) -> [EmojiPickerItem] {
        let recent = items(from: storedValue)
        let recentIDs = Set(recent.map(\.id))
        let defaults = EmojiPickerItem.notoItems.prefix(3)
            + EmojiPickerItem.blobItems.lazy.filter(\.isStaticBlob).prefix(3)
        return Array((recent + defaults.filter { !recentIDs.contains($0.id) }).prefix(6))
    }

    private static func rawIDs(from storedValue: String) -> [String] {
        guard let data = storedValue.data(using: .utf8),
              let values = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return values
    }
}

struct NotoEmojiView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let emoji: NotoEmoji
    let size: CGFloat
    let animated: Bool
    @State private var image: UIImage?
    @State private var loadedKey: String?
    @State private var failedKey: String?

    init(emoji: NotoEmoji, size: CGFloat, animated: Bool = true) {
        self.emoji = emoji
        self.size = size
        self.animated = animated
    }

    var body: some View {
        let shouldAnimate = animated && !reduceMotion
        let loadKey = "\(emoji.id):\(shouldAnimate):\(Int(size.rounded()))"
        Group {
            if loadedKey == loadKey, let image {
                if shouldAnimate {
                    AnimatedUIImage(image: image)
                } else {
                    Image(uiImage: image).resizable()
                }
            } else if failedKey == loadKey {
                Text(verbatim: emoji.value)
                    .font(.system(size: size * 0.78))
            } else {
                Circle()
                    .fill(Color.secondary.opacity(0.08))
                    .frame(width: size * 0.55, height: size * 0.55)
            }
        }
        .scaledToFit()
        .frame(width: size, height: size)
        .clipped()
        .task(id: loadKey) {
            let loaded = await NotoEmojiImageLoader.shared.image(
                for: emoji,
                animated: shouldAnimate,
                maximumPixelSize: size * UIScreen.main.scale
            )
            guard !Task.isCancelled else { return }
            image = loaded
            loadedKey = loaded == nil ? nil : loadKey
            failedKey = loaded == nil ? loadKey : nil
        }
        .accessibilityLabel(emoji.name)
    }
}

private enum NotoEmojiImageCache {
    private static let storage: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 48
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()

    static func image(for key: NSString) -> UIImage? {
        storage.object(forKey: key)
    }

    static func insert(_ image: UIImage, for key: NSString, cost: Int) {
        storage.setObject(image, forKey: key, cost: cost)
    }
}

private actor NotoEmojiImageLoader {
    static let shared = NotoEmojiImageLoader()
    private static let maximumBytes = 4 * 1_024 * 1_024

    func image(
        for emoji: NotoEmoji,
        animated: Bool,
        maximumPixelSize: CGFloat
    ) async -> UIImage? {
        let key = "\(emoji.id):\(animated):\(Int(maximumPixelSize.rounded()))" as NSString
        if let cached = NotoEmojiImageCache.image(for: key) { return cached }

        let formats: [NotoEmojiAssetFormat] = animated ? [.webp, .gif] : [.png]
        for format in formats {
            guard !Task.isCancelled,
                  let url = NotoEmojiCatalog.assetURL(for: emoji, format: format),
                  let image = await load(url: url, format: format, animated: animated, maximumPixelSize: maximumPixelSize) else {
                continue
            }
            let cost = (image.images ?? [image]).reduce(0) { total, frame in
                total + (frame.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
            }
            NotoEmojiImageCache.insert(image, for: key, cost: cost)
            return image
        }
        return nil
    }

    private func load(
        url: URL,
        format: NotoEmojiAssetFormat,
        animated: Bool,
        maximumPixelSize: CGFloat
    ) async -> UIImage? {
        var request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad)
        request.timeoutInterval = 15
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              data.count <= Self.maximumBytes,
              let response = response as? HTTPURLResponse,
              response.statusCode == 200,
              response.url?.host == "fonts.gstatic.com",
              response.mimeType == format.mediaType,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return nil
        }
        return AnimatedImageDecoder.image(
            from: source,
            animated: animated,
            maximumPixelSize: maximumPixelSize
        )
    }
}
