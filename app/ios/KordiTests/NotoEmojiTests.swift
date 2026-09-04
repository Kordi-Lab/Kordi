import Testing
@testable import Kordi

struct NotoEmojiTests {
    @Test func catalogUsesTrustedCDNMetadataWithoutBundledAnimations() throws {
        #expect(NotoEmojiCatalog.all.count == 881)
        #expect(Set(NotoEmojiCatalog.all.map(\.id)).count == 881)
        #expect(Set(NotoEmojiCatalog.all.map(\.value)).count == 881)

        let smile = try #require(NotoEmojiCatalog.byID["1f600"])
        #expect(smile.value == "😀")
        #expect(
            NotoEmojiCatalog.assetURL(for: smile, format: .webp)?.absoluteString
                == "https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp"
        )
        #expect(NotoEmojiCatalog.assetURL(
            for: NotoEmoji(
                id: "../avatar",
                value: "😀",
                name: "Invalid",
                keywords: [],
                category: "Invalid"
            ),
            format: .png
        ) == nil)
    }

    @Test func recentsPreserveBlobEntriesAndRecordNotoSelections() throws {
        let smile = try #require(NotoEmojiCatalog.byID["1f600"])
        let blob = try #require(BlobEmojiCatalog.byID["blobwave"])
        var stored = "[\"blobwave\"]"

        stored = EmojiRecentStore.recording(.noto(smile), in: stored)
        stored = EmojiRecentStore.recording(.blob(blob), in: stored)
        let recent = EmojiRecentStore.items(from: stored)

        #expect(recent.map(\.id) == ["blob:blobwave", "noto:1f600"])
        #expect(EmojiRecentStore.quickReactions(from: stored).count == 6)
    }

    @Test func markdownRecognizesNotoEmojiAsUnicodeOutsideLinks() throws {
        let rocket = try #require(NotoEmojiCatalog.byID["1f680"])
        let parts = KordiMarkdownParser.parseInline("Ship 🚀 https://example.com/😀")

        #expect(parts.contains(.notoEmoji(rocket)))
        #expect(parts.filter {
            if case .notoEmoji = $0 { return true }
            return false
        }.count == 1)
    }

    @Test func standaloneEmojiLayoutRequiresExactlyOneEmoji() throws {
        let smile = try #require(NotoEmojiCatalog.byValue["😀"])
        let blob = try #require(BlobEmojiCatalog.byID["blobwave"])

        #expect(MessageBubble.emojiOnlyItem(in: "  😀  ") == .noto(smile))
        #expect(MessageBubble.emojiOnlyItem(in: ":blob:blobwave:") == .blob(blob))
        #expect(MessageBubble.emojiOnlyItem(in: "Look 😀") == nil)
        #expect(MessageBubble.emojiOnlyItem(in: "😀😀") == nil)
    }
}
