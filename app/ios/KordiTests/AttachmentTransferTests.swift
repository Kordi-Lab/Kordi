import UIKit
import XCTest
@testable import Kordi

final class AttachmentTransferTests: XCTestCase {
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
}
