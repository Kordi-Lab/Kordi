import AVFoundation
import UIKit
import XCTest
@testable import Kordi

final class AttachmentTransferTests: XCTestCase {
    func testAttachmentCacheRestoresAcrossStoreInstances() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-attachment-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let attachment = ChatAttachment(
            attachmentId: "att-cache",
            name: "preview.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 4,
            previewURL: nil
        )
        let firstStore = AttachmentFileStore(directory: directory)
        let stored = try await firstStore.store(
            Data([1, 2, 3, 4]),
            attachment: attachment,
            accountId: "acct_a"
        )

        let restored = await AttachmentFileStore(directory: directory).cachedURL(
            for: attachment,
            accountId: "acct_a"
        )

        XCTAssertEqual(restored, stored)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(restored)), Data([1, 2, 3, 4]))
    }

    func testAttachmentCacheCopiesDownloadedFilesWithoutLoadingThemIntoMemory() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-attachment-file-cache-\(UUID().uuidString)")
        let sourceURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-downloaded-video-\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.removeItem(at: sourceURL)
        }
        try Data([1, 2, 3, 4]).write(to: sourceURL)
        let attachment = ChatAttachment(
            attachmentId: "att-video",
            name: "video.mp4",
            kind: .file,
            mimeType: "video/mp4",
            sizeBytes: 4,
            previewURL: nil
        )

        let stored = try await AttachmentFileStore(directory: directory).store(
            fileAt: sourceURL,
            attachment: attachment,
            accountId: "acct_a"
        )

        XCTAssertEqual(try Data(contentsOf: stored), Data([1, 2, 3, 4]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sourceURL.path))
    }

    func testAttachmentCacheIsAccountScoped() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-attachment-account-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let attachment = ChatAttachment(
            attachmentId: "att-shared",
            name: "preview.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 1,
            previewURL: nil
        )
        let store = AttachmentFileStore(directory: directory)

        let first = try await store.store(Data([1]), attachment: attachment, accountId: "acct_a")
        let second = try await store.store(Data([2]), attachment: attachment, accountId: "acct_b")

        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: first), Data([1]))
        XCTAssertEqual(try Data(contentsOf: second), Data([2]))
    }

    func testAttachmentCachePrunesOlderFilesToItsDiskBudget() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-attachment-budget-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AttachmentFileStore(directory: directory, diskByteLimit: 3)
        func attachment(_ id: String) -> ChatAttachment {
            ChatAttachment(
                attachmentId: id,
                name: "\(id).bin",
                kind: .file,
                mimeType: "application/octet-stream",
                sizeBytes: 3,
                previewURL: nil
            )
        }

        let firstAttachment = attachment("first")
        let firstURL = try await store.store(
            Data([1, 2, 3]),
            attachment: firstAttachment,
            accountId: "acct_a"
        )
        let secondURL = try await store.store(
            Data([4, 5, 6]),
            attachment: attachment("second"),
            accountId: "acct_a"
        )

        let restoredFirst = await store.cachedURL(for: firstAttachment, accountId: "acct_a")
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: secondURL.path))
        XCTAssertNil(restoredFirst)
    }

    func testPhotoLoaderProducesACloudSafeJPEG() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2_600, height: 1_900))
        let image = renderer.image { context in
            UIColor.systemIndigo.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2_600, height: 1_900))
        }
        let source = try XCTUnwrap(image.pngData())

        let attachment = try PendingAttachmentLoader.loadImage(
            data: source,
            suggestedName: "Library Photo.png"
        )

        XCTAssertEqual(attachment.kind, .image)
        XCTAssertEqual(attachment.mimeType, "image/jpeg")
        XCTAssertEqual(attachment.name, "Library Photo.jpg")
        XCTAssertLessThanOrEqual(attachment.data.count, PendingAttachmentLoader.maximumAttachmentBytes)
        XCTAssertNotNil(attachment.previewURL)
        let dimensions = try XCTUnwrap(PendingAttachmentLoader.imagePixelDimensions(data: attachment.data))
        XCTAssertEqual(attachment.widthPixels, dimensions.width)
        XCTAssertEqual(attachment.heightPixels, dimensions.height)
    }

    func testTransparentStickerPreviewPreservesAlphaInsteadOfAddingWhite() throws {
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        let image = UIGraphicsImageRenderer(
            size: CGSize(width: 256, height: 256),
            format: format
        ).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 64, y: 64, width: 128, height: 128))
        }
        let source = try XCTUnwrap(image.pngData())

        let attachment = try PendingAttachmentLoader.loadExpressiveMedia(
            data: source,
            suggestedName: "transparent-sticker.png",
            mimeType: "image/png",
            expectedKind: .sticker
        )

        XCTAssertEqual(attachment.subtype, .sticker)
        let dimensions = try XCTUnwrap(PendingAttachmentLoader.imagePixelDimensions(data: attachment.data))
        XCTAssertEqual(attachment.widthPixels, dimensions.width)
        XCTAssertEqual(attachment.heightPixels, dimensions.height)
        XCTAssertTrue(try XCTUnwrap(attachment.previewURL).hasPrefix("data:image/png;base64,"))
    }

    func testFilesLoaderRejectsImagesSoTheAttachmentSourcesStaySeparate() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-attachment-source-test.png")
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10))
        let data = try XCTUnwrap(renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
        }.pngData())
        try data.write(to: url, options: .atomic)
        defer { try? FileManager.default.removeItem(at: url) }

        XCTAssertThrowsError(try PendingAttachmentLoader.loadFiles(urls: [url])) { error in
            XCTAssertEqual(
                error.localizedDescription,
                AttachmentTransferError.imagesUsePhotoPicker.localizedDescription
            )
        }
    }

    func testMP4AttachmentsUseVideoPresentationWithoutASeparateMessageType() {
        let verified = ChatAttachment(
            attachmentId: "video-1",
            name: "clip.bin",
            kind: .file,
            mimeType: "video/mp4",
            sizeBytes: 12,
            previewURL: nil
        )
        let legacy = ChatAttachment(
            attachmentId: "video-2",
            name: "clip.mp4",
            kind: .file,
            mimeType: nil,
            sizeBytes: 12,
            previewURL: nil
        )
        let mismatch = ChatAttachment(
            attachmentId: "video-3",
            name: "clip.mp4",
            kind: .file,
            mimeType: "application/pdf",
            sizeBytes: 12,
            previewURL: nil
        )

        XCTAssertTrue(verified.isMP4Video)
        XCTAssertTrue(legacy.isMP4Video)
        XCTAssertFalse(mismatch.isMP4Video)
    }

    func testLargeMP4DraftsStayFileBacked() throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("source-\(UUID().uuidString).mp4")
        try Data(repeating: 7, count: 3 * 1_024 * 1_024).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let attachment = try XCTUnwrap(PendingAttachmentLoader.loadFiles(urls: [source]).first)
        let storedURL = try XCTUnwrap(attachment.fileURL)
        defer { attachment.discardOwnedFile() }

        XCTAssertTrue(attachment.data.isEmpty)
        XCTAssertNotEqual(storedURL, source)
        XCTAssertEqual(attachment.sizeBytes, 3 * 1_024 * 1_024)
        XCTAssertTrue(FileManager.default.fileExists(atPath: storedURL.path))
    }

    func testMultipartUploadRangesCoverEveryByteOnce() {
        XCTAssertEqual(
            AttachmentUploadChunking.ranges(totalBytes: 17, chunkSizeBytes: 8),
            [0..<8, 8..<16, 16..<17]
        )
        XCTAssertTrue(
            AttachmentUploadChunking.ranges(totalBytes: 0, chunkSizeBytes: 8).isEmpty
        )
        XCTAssertTrue(
            AttachmentUploadChunking.ranges(totalBytes: 17, chunkSizeBytes: 0).isEmpty
        )
        XCTAssertEqual(AttachmentUploadChunking.parallelParts, 3)
    }

    func testCameraVideoAvoidsASecondEncodeWhenMP4PassthroughIsAvailable() {
        XCTAssertEqual(
            PendingAttachmentLoader.cameraVideoExportPresets,
            [AVAssetExportPresetPassthrough, AVAssetExportPresetMediumQuality]
        )
    }

    func testAttachmentUploadProgressStaysTransient() throws {
        let message = ChatMessage(
            id: "uploading-video",
            conversationId: "person:test",
            author: .me,
            authorName: "You",
            text: "",
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .sending,
            errorMessage: nil,
            requestMessageId: nil,
            attachmentUploadProgress: 0.42
        )

        let restored = try JSONDecoder().decode(
            ChatMessage.self,
            from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(message.attachmentUploadProgress, 0.42)
        XCTAssertNil(restored.attachmentUploadProgress)
    }

    func testMemePolicyRequiresAccessibleSupportedImageAndRightsConfirmation() {
        let valid = PendingAttachment(
            id: "meme-1",
            name: "reaction.png",
            kind: .image,
            subtype: .meme,
            altText: "A surprised cat watches the test suite turn green.",
            memeRightsConfirmed: true,
            mimeType: "image/png",
            data: Data([0x89, 0x50, 0x4e, 0x47]),
            previewURL: nil
        )

        XCTAssertNil(MemeAttachmentPolicy.draftError(for: [valid]))

        var missingAltText = valid
        missingAltText.altText = "  "
        XCTAssertEqual(
            MemeAttachmentPolicy.draftError(for: [missingAltText]),
            "Add alt text for reaction.png before sending."
        )

        var missingRights = valid
        missingRights.memeRightsConfirmed = false
        XCTAssertNotNil(MemeAttachmentPolicy.draftError(for: [missingRights]))

        var unsupported = valid
        unsupported = PendingAttachment(
            id: unsupported.id,
            name: "reaction.svg",
            kind: unsupported.kind,
            subtype: unsupported.subtype,
            altText: unsupported.altText,
            memeRightsConfirmed: unsupported.memeRightsConfirmed,
            mimeType: "image/svg+xml",
            data: unsupported.data,
            previewURL: unsupported.previewURL
        )
        XCTAssertNotNil(MemeAttachmentPolicy.draftError(for: [unsupported]))
    }

    func testExpressiveMediaLibraryPreservesOriginalStickerAndGIFFiles() async throws {
        XCTAssertNil(
            ExpressiveMediaLibraryKind.supportedKind(
                name: "renamed.gif",
                mimeType: "image/png"
            )
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-expressive-library-\(UUID().uuidString)", isDirectory: true)
        let sourceDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-expressive-source-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.removeItem(at: sourceDirectory)
        }
        let store = ExpressiveMediaLibraryStore(directory: directory)
        let accountId = "acct-media-owner"
        let accountDirectory = directory.appendingPathComponent("account-acct-media-owner")

        let stickerURL = sourceDirectory.appendingPathComponent("wave.webp")
        let stickerData = Data([0x52, 0x49, 0x46, 0x46])
        try stickerData.write(to: stickerURL)
        let sticker = ChatAttachment(
            attachmentId: "sticker-1",
            name: "wave.webp",
            kind: .image,
            mimeType: "image/webp",
            sizeBytes: Int64(stickerData.count),
            previewURL: nil
        )

        let gifURL = sourceDirectory.appendingPathComponent("party.gif")
        let gifData = Data("GIF89a".utf8)
        try gifData.write(to: gifURL)
        let gif = ChatAttachment(
            attachmentId: "gif-1",
            name: "party.gif",
            kind: .image,
            mimeType: "image/gif",
            sizeBytes: Int64(gifData.count),
            previewURL: nil
        )

        let savedSticker = try await store.add(
            accountId: accountId,
            fileAt: stickerURL,
            attachment: sticker
        )
        let savedGIF = try await store.add(
            accountId: accountId,
            fileAt: gifURL,
            attachment: gif
        )
        let items = await store.items(accountId: accountId)

        XCTAssertEqual(savedSticker.kind, .sticker)
        XCTAssertEqual(savedGIF.kind, .gif)
        XCTAssertEqual(items.map(\.kind), [.gif, .sticker])
        XCTAssertEqual(
            try Data(contentsOf: accountDirectory.appendingPathComponent(savedGIF.relativeFileName)),
            gifData
        )

        let entries = await store.entries(accountId: accountId, kind: .gif)
        let savedEntry = try XCTUnwrap(entries.first)
        let pendingGIF = try await store.pendingAttachment(accountId: accountId, for: savedEntry.item)
        XCTAssertEqual(pendingGIF.name, "party.gif")
        XCTAssertEqual(pendingGIF.mimeType, "image/gif")
        XCTAssertEqual(pendingGIF.data, gifData)

        let savedGIFURL = accountDirectory.appendingPathComponent(savedGIF.relativeFileName)
        try await store.remove(accountId: accountId, itemId: savedGIF.id)
        let itemsAfterRemoval = await store.items(accountId: accountId)
        XCTAssertFalse(itemsAfterRemoval.contains { $0.id == savedGIF.id })
        XCTAssertFalse(FileManager.default.fileExists(atPath: savedGIFURL.path))

        let savedGIFSticker = try await store.add(
            accountId: accountId,
            fileAt: gifURL,
            expectedKind: .sticker
        )
        XCTAssertEqual(savedGIFSticker.kind, .sticker)
        XCTAssertEqual(savedGIFSticker.mimeType, "image/gif")
        XCTAssertEqual(
            try Data(contentsOf: accountDirectory.appendingPathComponent(savedGIFSticker.relativeFileName)),
            gifData
        )
    }

    func testExpressiveMediaLibraryNormalizesOversizedStaticStickerBeforeSync() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-expressive-compression-\(UUID().uuidString)", isDirectory: true)
        let sourceURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("oversized-sticker-\(UUID().uuidString).png")
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.removeItem(at: sourceURL)
        }

        let side = 1_024
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        var randomState: UInt32 = 0x5eed
        for offset in stride(from: 0, to: pixels.count, by: 4) {
            randomState = randomState &* 1_664_525 &+ 1_013_904_223
            pixels[offset] = UInt8(truncatingIfNeeded: randomState >> 24)
            randomState = randomState &* 1_664_525 &+ 1_013_904_223
            pixels[offset + 1] = UInt8(truncatingIfNeeded: randomState >> 24)
            randomState = randomState &* 1_664_525 &+ 1_013_904_223
            pixels[offset + 2] = UInt8(truncatingIfNeeded: randomState >> 24)
            pixels[offset + 3] = 255
        }
        let image = try pixels.withUnsafeMutableBytes { bytes -> UIImage in
            let context = try XCTUnwrap(CGContext(
                data: bytes.baseAddress,
                width: side,
                height: side,
                bitsPerComponent: 8,
                bytesPerRow: side * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            return UIImage(cgImage: try XCTUnwrap(context.makeImage()))
        }
        let sourceData = try XCTUnwrap(image.pngData())
        XCTAssertGreaterThan(sourceData.count, PendingAttachmentLoader.maximumAttachmentBytes)
        try sourceData.write(to: sourceURL, options: .atomic)

        let store = ExpressiveMediaLibraryStore(directory: directory)
        let saved = try await store.add(
            accountId: "acct-compressed-sticker",
            fileAt: sourceURL,
            expectedKind: .sticker
        )
        let savedEntries = await store.entries(accountId: "acct-compressed-sticker", kind: .sticker)
        let savedURL = try XCTUnwrap(savedEntries.first?.fileURL)
        let savedData = try Data(contentsOf: savedURL)
        let savedImage = try XCTUnwrap(UIImage(data: savedData)?.cgImage)
        let pending = try await store.pendingAttachment(
            accountId: "acct-compressed-sticker",
            for: saved
        )

        XCTAssertEqual(saved.name, sourceURL.lastPathComponent)
        XCTAssertLessThanOrEqual(saved.sizeBytes, Int64(PendingAttachmentLoader.maximumAttachmentBytes))
        XCTAssertLessThanOrEqual(max(savedImage.width, savedImage.height), 512)
        XCTAssertEqual(savedData, pending.data)
    }

    func testExpressiveMediaLibraryScopesItemsByAccountAndImportsCloudMedia() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-expressive-sync-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ExpressiveMediaLibraryStore(directory: directory)
        let localAttachment = PendingAttachment(
            id: "pending-sticker",
            name: "local.png",
            kind: .image,
            mimeType: "image/png",
            data: Data([0x89, 0x50, 0x4e, 0x47]),
            previewURL: nil
        )

        let localItem = try await store.add(
            accountId: "acct-a",
            attachment: localAttachment,
            expectedKind: .sticker
        )
        let accountAItems = await store.items(accountId: "acct-a")
        let accountBItems = await store.items(accountId: "acct-b")
        XCTAssertEqual(accountAItems.map(\.name), ["local.png"])
        XCTAssertTrue(accountBItems.isEmpty)

        let cloudItem = CloudExpressiveMediaItem(
            itemId: "media-cloud",
            attachmentId: "attachment-cloud",
            kind: .gif,
            name: "cloud.gif",
            mimeType: "image/gif",
            sizeBytes: 6,
            createdAt: "2026-08-17T10:00:00.123Z",
            updatedAt: "2026-08-17T10:00:00.123Z"
        )
        try await store.importCloudItem(
            accountId: "acct-a",
            cloudItem: cloudItem,
            data: Data("GIF89a".utf8)
        )
        try await store.markUploaded(
            accountId: "acct-a",
            itemId: localItem.id,
            attachmentId: "attachment-local"
        )

        let synchronizedItems = await store.items(accountId: "acct-a")
        XCTAssertEqual(Set(synchronizedItems.map(\.name)), Set(["local.png", "cloud.gif"]))
        XCTAssertEqual(
            synchronizedItems.first(where: { $0.id == localItem.id })?.attachmentId,
            "attachment-local"
        )
        let cloudEntries = await store.entries(accountId: "acct-a", kind: .gif)
        let cloudEntry = try XCTUnwrap(cloudEntries.first)
        XCTAssertEqual(
            cloudEntry.item.createdAt.timeIntervalSince1970,
            parseCloudDate(cloudItem.createdAt).timeIntervalSince1970,
            accuracy: 0.001
        )
        let restoredCloudAttachment = try await store.pendingAttachment(
            accountId: "acct-a",
            for: cloudEntry.item
        )
        XCTAssertEqual(restoredCloudAttachment.data, Data("GIF89a".utf8))
    }

    func testLegacyExpressiveMediaMigrationCannotLeakToASecondAccount() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-expressive-migration-\(UUID().uuidString)", isDirectory: true)
        let firstAccountDirectory = directory.appendingPathComponent("account-acct-first", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: firstAccountDirectory, withIntermediateDirectories: true)

        let legacyItem = ExpressiveMediaLibraryItem(
            id: "legacy-item",
            kind: .sticker,
            name: "legacy.png",
            mimeType: "image/png",
            sizeBytes: 4,
            relativeFileName: "legacy.png",
            createdAt: Date(timeIntervalSince1970: 100),
            cloudItemId: nil,
            attachmentId: nil
        )
        let existingItem = ExpressiveMediaLibraryItem(
            id: "existing-item",
            kind: .sticker,
            name: "existing.png",
            mimeType: "image/png",
            sizeBytes: 4,
            relativeFileName: "existing.png",
            createdAt: Date(timeIntervalSince1970: 200),
            cloudItemId: nil,
            attachmentId: nil
        )
        try JSONEncoder().encode([legacyItem]).write(
            to: directory.appendingPathComponent("library.json"),
            options: .atomic
        )
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: directory.appendingPathComponent("legacy.png"))
        try JSONEncoder().encode([existingItem]).write(
            to: firstAccountDirectory.appendingPathComponent("library.json"),
            options: .atomic
        )
        try Data([0x89, 0x50, 0x4e, 0x47]).write(
            to: firstAccountDirectory.appendingPathComponent("existing.png")
        )

        let store = ExpressiveMediaLibraryStore(directory: directory)
        let firstAccountItems = await store.items(accountId: "acct-first")
        let secondAccountItems = await store.items(accountId: "acct-second")

        XCTAssertEqual(firstAccountItems.map(\.id), ["existing-item"])
        XCTAssertTrue(secondAccountItems.isEmpty)
    }

    func testPublicStickerCatalogRejectsUntrustedImageHosts() throws {
        let data = Data(
            """
            {
              "query": {
                "pages": [
                  {
                    "pageid": 20,
                    "title": "File:Success Kid.png",
                    "index": 1,
                    "imageinfo": [{
                      "url": "https://upload.wikimedia.org/success.png",
                      "thumburl": "https://upload.wikimedia.org/success-preview.png",
                      "mime": "image/png",
                      "size": 1048576,
                      "extmetadata": {"LicenseShortName": {"value": "Public domain"}}
                    }]
                  },
                  {
                    "pageid": 21,
                    "title": "File:Untrusted.jpg",
                    "index": 2,
                    "imageinfo": [{
                      "url": "https://example.com/sticker.jpg",
                      "mime": "image/jpeg",
                      "size": 1024,
                      "extmetadata": {"LicenseShortName": {"value": "CC0"}}
                    }]
                  },
                  {
                    "pageid": 22,
                    "title": "File:Attribution required.jpg",
                    "index": 3,
                    "imageinfo": [{
                      "url": "https://upload.wikimedia.org/attribution.jpg",
                      "mime": "image/jpeg",
                      "size": 1024,
                      "extmetadata": {"LicenseShortName": {"value": "CC BY-SA 4.0"}}
                    }]
                  }
                ]
              }
            }
            """.utf8
        )

        let templates = try ExpressiveMediaCatalog.parsePublicStickerTemplates(data)

        XCTAssertEqual(templates.map(\.id), ["20"])
        XCTAssertEqual(templates.first?.name, "Success Kid")
        XCTAssertEqual(templates.first?.license, "Public domain")

        let searchURL = try ExpressiveMediaCatalog.publicStickerSearchURL(query: "success reaction")
        let queryItems = try XCTUnwrap(URLComponents(url: searchURL, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(
            queryItems.first(where: { $0.name == "gsrsearch" })?.value,
            "success reaction filetype:bitmap"
        )
    }

    func testPublicGIFCatalogOnlyKeepsCloudSafePublicMedia() throws {
        let data = Data(
            """
            {
              "query": {
                "pages": [
                  {
                    "pageid": 10,
                    "title": "File:Happy dance.gif",
                    "index": 2,
                    "imageinfo": [{
                      "url": "https://upload.wikimedia.org/happy.gif",
                      "thumburl": "https://upload.wikimedia.org/happy-preview.png",
                      "mime": "image/gif",
                      "size": 1048576,
                      "extmetadata": {"LicenseShortName": {"value": "CC0"}}
                    }]
                  },
                  {
                    "pageid": 11,
                    "title": "File:Too large.gif",
                    "index": 1,
                    "imageinfo": [{
                      "url": "https://upload.wikimedia.org/large.gif",
                      "mime": "image/gif",
                      "size": 3145728,
                      "extmetadata": {"LicenseShortName": {"value": "Public domain"}}
                    }]
                  },
                  {
                    "pageid": 12,
                    "title": "File:Wrong host.gif",
                    "index": 3,
                    "imageinfo": [{
                      "url": "https://example.com/wrong.gif",
                      "mime": "image/gif",
                      "size": 1024,
                      "extmetadata": {"LicenseShortName": {"value": "CC0"}}
                    }]
                  },
                  {
                    "pageid": 13,
                    "title": "File:Restricted.gif",
                    "index": 4,
                    "imageinfo": [{
                      "url": "https://upload.wikimedia.org/restricted.gif",
                      "mime": "image/gif",
                      "size": 1024,
                      "extmetadata": {"LicenseShortName": {"value": "CC BY-SA 4.0"}}
                    }]
                  }
                ]
              }
            }
            """.utf8
        )

        let results = try ExpressiveMediaCatalog.parsePublicGIFResults(data)

        XCTAssertEqual(results.map(\.id), ["10"])
        XCTAssertEqual(results.first?.title, "Happy dance")
        XCTAssertEqual(results.first?.license, "CC0")
        XCTAssertLessThanOrEqual(
            results.first?.sizeBytes ?? .max,
            Int64(PendingAttachmentLoader.maximumAttachmentBytes)
        )

        let searchURL = try ExpressiveMediaCatalog.publicGIFSearchURL(query: "celebration")
        let queryItems = try XCTUnwrap(URLComponents(url: searchURL, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(
            queryItems.first(where: { $0.name == "gsrsearch" })?.value,
            "celebration filemime:image/gif"
        )
    }
}
