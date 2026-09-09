import CryptoKit
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

    private static let catalogData: Data? = Bundle.main.url(
        forResource: "catalog", withExtension: "json", subdirectory: "noto-emoji"
    ).flatMap { try? Data(contentsOf: $0) }

    static let assetRevision = catalogData.map {
        SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined()
    } ?? "noto-v1"

    static let all: [NotoEmoji] = {
        guard let data = catalogData,
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
    @Environment(\.displayScale) private var displayScale
    let emoji: NotoEmoji
    let size: CGFloat
    let animated: Bool

    init(emoji: NotoEmoji, size: CGFloat, animated: Bool = true) {
        self.emoji = emoji
        self.size = size
        self.animated = animated
    }

    var body: some View {
        let shouldAnimate = animated && !reduceMotion
        let formats: [NotoEmojiAssetFormat] = shouldAnimate ? [.webp, .gif] : [.png]
        let sources = formats.compactMap { format in
            NotoEmojiCatalog.assetURL(for: emoji, format: format).map {
                EmojiAnimationRequest.Source(url: $0, mediaType: format.mediaType)
            }
        }
        SharedEmojiAnimationView(
            request: EmojiAnimationRequest(
                identifier: "noto:\(emoji.id)", revision: NotoEmojiCatalog.assetRevision,
                pixelSize: min(512, max(1, Int((size * displayScale).rounded(.up)))),
                animated: shouldAnimate, sources: sources
            ),
            fallback: emoji.value,
            size: size
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(emoji.name)
    }
}
