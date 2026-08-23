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

        do {
            _ = try await store.add(
                accountId: accountId,
                fileAt: gifURL,
                expectedKind: .sticker
            )
            XCTFail("A GIF must not be added to My Stickers.")
        } catch {
            XCTAssertEqual(
                error.localizedDescription,
                ExpressiveMediaLibraryError.unsupportedFile.localizedDescription
            )
        }
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
