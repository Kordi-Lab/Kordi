import UIKit
import XCTest
@testable import Kordi

final class MediaCacheTests: XCTestCase {
    func testAttachmentCacheKeepsPreviewAndOriginalVariantsSeparate() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-attachment-variants-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let attachment = ChatAttachment(
            attachmentId: "att-variants",
            name: "image.jpg",
            kind: .image,
            mimeType: "image/jpeg",
            sizeBytes: 4,
            previewURL: nil
        )
        let store = AttachmentFileStore(directory: directory)
        let preview = try await store.store(
            Data([1]), attachment: attachment, accountId: "acct_a", variant: .preview
        )
        let original = try await store.store(
            Data([2, 3, 4]), attachment: attachment, accountId: "acct_a", variant: .original
        )
        let restoredStore = AttachmentFileStore(directory: directory)
        let restoredPreview = await restoredStore.cachedURL(
            for: attachment, accountId: "acct_a", variant: .preview
        )
        let restoredOriginal = await restoredStore.cachedURL(
            for: attachment, accountId: "acct_a", variant: .original
        )

        XCTAssertNotEqual(preview, original)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(restoredPreview)), Data([1]))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(restoredOriginal)), Data([2, 3, 4]))
    }

    func testExpressiveMediaThumbnailLoaderCoalescesAndCachesDecodedImages() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-sticker-thumbnail-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 512, height: 512)).image {
            UIColor.systemPink.setFill()
            $0.fill(CGRect(x: 32, y: 32, width: 448, height: 448))
        }
        try XCTUnwrap(image.pngData()).write(to: url)

        async let firstLoad = ExpressiveMediaThumbnailLoader.shared.image(at: url)
        async let secondLoad = ExpressiveMediaThumbnailLoader.shared.image(at: url)
        let (firstResult, secondResult) = await (firstLoad, secondLoad)
        let first = try XCTUnwrap(firstResult)
        let second = try XCTUnwrap(secondResult)

        XCTAssertTrue(first === second)
        XCTAssertTrue(ExpressiveMediaThumbnailLoader.cachedImage(at: url) === first)
        XCTAssertLessThanOrEqual(max(first.size.width, first.size.height), 240)
    }

    func testFullScreenPreviewKeepsThePreviewWhileLoadingTheOriginal() throws {
        let source = try sourceFile("Features/Conversation/MediaPreviewView.swift")
        let loadStart = try XCTUnwrap(source.range(of: "private func loadImage() async"))
        let loadSource = source[loadStart.lowerBound...]

        XCTAssertTrue(loadSource.contains("AvatarImageLoader.image(from: source)"))
        XCTAssertTrue(loadSource.contains("prepareAttachmentForSharing"))
        XCTAssertFalse(loadSource.contains("previewURL?.lowercased().hasPrefix"))
        XCTAssertFalse(loadSource.contains("attachmentId.hasPrefix(\"pending:\")"))
    }

    func testSuccessfulImageUploadCachesTheSentOriginalByCanonicalAttachment() throws {
        let source = try sourceFile("Core/API/AttachmentFileStore.swift")
        let cacheStart = try XCTUnwrap(source.range(of: "func cacheUploadedOriginals"))
        let cacheSource = source[cacheStart.lowerBound...]

        XCTAssertTrue(cacheSource.contains("zip(drafts, uploaded)"))
        XCTAssertTrue(cacheSource.contains("attachment: result.chatAttachment"))
        XCTAssertTrue(cacheSource.contains("variant: .original"))
    }

    func testStaticStickerMessagesReuseTheExpressiveThumbnailCache() throws {
        let source = try sourceFile("Core/API/AttachmentFileStore.swift")

        XCTAssertTrue(source.contains("attachment.subtype == .sticker, !isAnimatedGIF"))
        XCTAssertTrue(source.contains("ExpressiveMediaThumbnailLoader.shared.image(at: url)"))
    }

    private func sourceFile(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/\(relativePath)")
        return try String(contentsOf: url, encoding: .utf8)
    }
}
