import XCTest
@testable import Kordi

final class MediaPreviewTests: XCTestCase {
    func testGalleryIncludesOnlyImagesInMessageOrder() {
        let firstImage = attachment(id: "image-1", kind: .image)
        let file = attachment(id: "file-1", kind: .file)
        let secondImage = attachment(id: "image-2", kind: .image)
        let messages = [
            message(id: "message-1", author: .person, attachments: [firstImage, file]),
            message(id: "message-2", author: .me, attachments: [secondImage]),
        ]

        let items = ConversationMediaGallery.items(in: messages)

        XCTAssertEqual(items.map(\.id), ["message-1:image-1", "message-2:image-2"])
        XCTAssertEqual(items.map(\.senderName), ["Maya", "You"])
        XCTAssertEqual(items.map(\.attachment), [firstImage, secondImage])
    }

    func testPresentationSelectsTheExactMessageAttachment() {
        let sharedAttachment = attachment(id: "same-image", kind: .image)
        let first = message(id: "message-1", author: .person, attachments: [sharedAttachment])
        let second = message(id: "message-2", author: .me, attachments: [sharedAttachment])

        let presentation = MediaPreviewPresentation.make(
            opening: sharedAttachment,
            from: second,
            in: [first, second],
            initialImage: nil
        )

        XCTAssertEqual(presentation?.initialItemID, "message-2:same-image")
        XCTAssertEqual(presentation?.items.count, 2)
    }

    func testDismissalRequiresAChieflyDownwardDrag() {
        XCTAssertEqual(
            MediaPreviewDismissal.verticalOffset(for: CGSize(width: 20, height: 140)),
            140
        )
        XCTAssertEqual(
            MediaPreviewDismissal.verticalOffset(for: CGSize(width: 160, height: 80)),
            0
        )
        XCTAssertEqual(
            MediaPreviewDismissal.verticalOffset(for: CGSize(width: 0, height: -140)),
            0
        )
    }

    func testDismissalAcceptsDistanceOrProjectedMomentum() {
        XCTAssertTrue(MediaPreviewDismissal.shouldDismiss(
            translation: CGSize(width: 8, height: 150),
            predictedEndTranslation: CGSize(width: 8, height: 180),
            viewportHeight: 800
        ))
        XCTAssertTrue(MediaPreviewDismissal.shouldDismiss(
            translation: CGSize(width: 8, height: 70),
            predictedEndTranslation: CGSize(width: 12, height: 230),
            viewportHeight: 800
        ))
        XCTAssertFalse(MediaPreviewDismissal.shouldDismiss(
            translation: CGSize(width: 10, height: 70),
            predictedEndTranslation: CGSize(width: 14, height: 120),
            viewportHeight: 800
        ))
    }

    func testInlineImagePreviewDataDecodesForOfflineSharingFallback() {
        let expected = Data("preview".utf8)
        let source = "data:image/png;base64,\(expected.base64EncodedString())"

        XCTAssertEqual(AttachmentPreviewDataURL.decode(source), expected)
        XCTAssertNil(AttachmentPreviewDataURL.decode("data:text/plain;base64,SGVsbG8="))
        XCTAssertNil(AttachmentPreviewDataURL.decode("https://example.com/image.png"))
    }

    func testCombinedPhotoPlanKeepsOneMessageAndOriginalOrder() {
        let first = pendingAttachment(id: "image-1", kind: .image)
        let file = pendingAttachment(id: "file-1", kind: .file)
        let second = pendingAttachment(id: "image-2", kind: .image)

        let batches = OutgoingAttachmentGroupingPlan.batches(
            for: [first, file, second],
            photoGrouping: .combined
        )

        XCTAssertEqual(batches.map { $0.map(\.id) }, [["image-1", "file-1", "image-2"]])
    }

    func testSeparatePhotoPlanCreatesOneImagePerMessage() {
        let first = pendingAttachment(id: "image-1", kind: .image)
        let file = pendingAttachment(id: "file-1", kind: .file)
        let second = pendingAttachment(id: "image-2", kind: .image)
        let third = pendingAttachment(id: "image-3", kind: .image)

        let batches = OutgoingAttachmentGroupingPlan.batches(
            for: [first, file, second, third],
            photoGrouping: .separate
        )

        XCTAssertEqual(
            batches.map { $0.map(\.id) },
            [["image-1", "file-1"], ["image-2"], ["image-3"]]
        )
    }

    func testPhotoLibrarySelectionPreservesOrderAndRemovesSelections() {
        var selected: [String] = []

        selected = PhotoLibrarySelection.toggling("second", in: selected)
        selected = PhotoLibrarySelection.toggling("first", in: selected)
        XCTAssertEqual(selected, ["second", "first"])

        selected = PhotoLibrarySelection.toggling("second", in: selected)
        XCTAssertEqual(selected, ["first"])
        XCTAssertEqual(PhotoLibrarySelection.editingID(in: ["first", "second"]), "second")
        XCTAssertNil(PhotoLibrarySelection.editingID(in: []))
    }

    func testPhotoEditorRotationSwapsImageDimensionsAndKeepsDrawnOutput() throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 8)).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(x: 0, y: 0, width: 12, height: 8))
        }
        let drawn = PhotoEditorRenderer.applying(
            [PhotoEditorStroke(points: [CGPoint(x: 0.1, y: 0.2), CGPoint(x: 0.9, y: 0.8)])],
            to: source
        )
        let rotated = PhotoEditorRenderer.rotatedClockwise(drawn)

        XCTAssertEqual(rotated.size, CGSize(width: 8, height: 12))
        XCTAssertNotNil(rotated.jpegData(compressionQuality: 0.8))
    }

    func testPhotoEditorCropStaysInBoundsAndProducesTheSelectedDimensions() {
        XCTAssertEqual(PhotoEditorCrop.initial, CGRect(x: 0.06, y: 0.06, width: 0.88, height: 0.88))

        let resized = PhotoEditorCrop.resized(
            .init(x: 0, y: 0, width: 1, height: 1),
            corner: .bottomTrailing,
            translation: CGSize(width: -40, height: -20),
            canvasSize: CGSize(width: 100, height: 100)
        )
        XCTAssertEqual(resized, CGRect(x: 0, y: 0, width: 0.6, height: 0.8))

        let source = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 80)).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(x: 0, y: 0, width: 100, height: 80))
        }
        let cropped = PhotoEditorRenderer.cropped(
            source,
            to: CGRect(x: 0.1, y: 0.25, width: 0.6, height: 0.5)
        )
        XCTAssertEqual(cropped.size, CGSize(width: 60, height: 40))
    }

    func testSeparatePhotoPreparationCanEnterChatOnePhotoAtATime() {
        let selected = ["first", "second", "third"]

        XCTAssertEqual(
            PhotoSelectionPreparationPlan.batches(for: selected, grouping: .separate),
            [["first"], ["second"], ["third"]]
        )
        XCTAssertEqual(
            PhotoSelectionPreparationPlan.batches(for: selected, grouping: .combined),
            [selected]
        )
    }

    func testImageOnlyMessageUsesBorderlessMediaSurface() {
        let imageMessage = message(
            id: "image-message",
            author: .me,
            attachments: [attachment(id: "image", kind: .image)]
        )
        var captionedMessage = imageMessage
        captionedMessage.text = "Caption"

        XCTAssertTrue(MessageAttachmentPresentation.usesBorderlessImageSurface(for: imageMessage))
        XCTAssertFalse(MessageAttachmentPresentation.usesBorderlessImageSurface(for: captionedMessage))
    }

    func testTransparentImageKeepsBorderlessSurfaceClear() throws {
        let transparentFormat = UIGraphicsImageRendererFormat()
        transparentFormat.opaque = false
        let transparent = UIGraphicsImageRenderer(
            size: CGSize(width: 20, height: 20),
            format: transparentFormat
        ).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 5, y: 5, width: 10, height: 10))
        }

        let opaqueFormat = UIGraphicsImageRendererFormat()
        opaqueFormat.opaque = true
        let opaque = UIGraphicsImageRenderer(
            size: CGSize(width: 20, height: 20),
            format: opaqueFormat
        ).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 20, height: 20)))
        }

        XCTAssertTrue(AttachmentImageDecoder.hasTransparency(transparent))
        XCTAssertFalse(AttachmentImageDecoder.hasTransparency(opaque))
    }

    func testPromotedAttachmentKeepsTheSameRenderedContentIdentity() {
        let pending = ChatAttachment(
            attachmentId: "pending:sticker",
            name: "sticker.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 26_979,
            previewURL: "data:image/png;base64,pending"
        )
        let canonical = ChatAttachment(
            attachmentId: "att_sticker",
            name: pending.name,
            kind: pending.kind,
            mimeType: pending.mimeType,
            sizeBytes: pending.sizeBytes,
            previewURL: nil
        )

        XCTAssertEqual(
            AttachmentImageDecoder.contentIdentity(pending),
            AttachmentImageDecoder.contentIdentity(canonical)
        )
    }

    func testStickerUsesLongPressActionsWithoutOpeningImagePreview() {
        let sticker = ChatAttachment(
            attachmentId: "att-sticker",
            name: "wave.png",
            kind: .image,
            subtype: .sticker,
            mimeType: "image/png",
            sizeBytes: 120,
            previewURL: nil
        )
        let photo = ChatAttachment(
            attachmentId: "att-photo",
            name: "photo.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 120,
            previewURL: nil
        )

        XCTAssertFalse(MessageImageInteraction.opensPreview(for: sticker))
        XCTAssertTrue(MessageImageInteraction.opensPreview(for: photo))
        let stickerMessage = ChatMessage(
            id: "sticker-message",
            conversationId: "conversation",
            author: .person,
            authorName: "Alice",
            text: "",
            createdAt: Date(),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            attachments: [sticker],
            messageKind: "sticker"
        )
        XCTAssertEqual(
            MessageImageInteraction.stickerAttachment(in: stickerMessage),
            sticker
        )
        let legacySticker = ChatAttachment(
            attachmentId: "att-legacy-sticker",
            name: "wave.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 120,
            previewURL: nil
        )
        let legacyMessage = ChatMessage(
            id: "legacy-sticker-message",
            conversationId: "conversation",
            author: .person,
            authorName: "Alice",
            text: "",
            createdAt: Date(),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            attachments: [legacySticker],
            messageKind: "text"
        )
        let signature = try? XCTUnwrap(ExpressiveMediaAttachmentSignature.value(
            name: legacySticker.name,
            mimeType: legacySticker.mimeType,
            sizeBytes: legacySticker.sizeBytes
        ))
        let marked = MessageImageInteraction.markingKnownStickers(
            in: [legacyMessage],
            matching: Set(signature.map { [$0] } ?? [])
        )
        XCTAssertEqual(marked.first?.messageKind, "sticker")
        XCTAssertEqual(marked.first?.attachments.first?.subtype, .sticker)
        XCTAssertEqual(
            MessageImageInteraction.mediaLibraryActionLabel(
                for: sticker,
                libraryName: "My Stickers",
                isSaved: false
            ),
            "Save to My Stickers"
        )
    }

    func testSingleImageActionFrameUsesTheRenderedImageWidth() {
        XCTAssertNil(MessageImageCollectionLayout.fixedWidth(attachmentCount: 1))
        XCTAssertEqual(
            MessageImageCollectionLayout.fixedWidth(attachmentCount: 2),
            192
        )
    }

    func testGIFsUseOriginalBytesAndCompactExpressiveMediaSizing() {
        let gif = ChatAttachment(
            attachmentId: "att-gif",
            name: "dance.gif",
            kind: .image,
            mimeType: "image/gif",
            sizeBytes: 1_024,
            previewURL: "data:image/png;base64,static-preview"
        )
        let photo = ChatAttachment(
            attachmentId: "att-photo",
            name: "photo.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 1_024,
            previewURL: nil
        )

        XCTAssertTrue(MessageImageInteraction.isAnimatedGIF(gif))
        XCTAssertEqual(MessageImageInteraction.maximumDisplayDimension(for: gif), 180)
        XCTAssertEqual(
            MessageImageInteraction.placeholderSize(
                for: gif,
                defaultSize: CGSize(width: 244, height: 154)
            ),
            CGSize(width: 180, height: 180)
        )
        XCTAssertEqual(
            MessageImageInteraction.placeholderSize(
                for: photo,
                defaultSize: CGSize(width: 244, height: 154)
            ),
            CGSize(width: 244, height: 154)
        )
        XCTAssertNil(MessageImageInteraction.maximumDisplayDimension(for: photo))
        XCTAssertFalse(MessageImageInteraction.usesInlinePreview(for: gif))
        XCTAssertTrue(MessageImageInteraction.usesInlinePreview(for: ChatAttachment(
            attachmentId: "pending:gif",
            name: gif.name,
            kind: gif.kind,
            mimeType: gif.mimeType,
            sizeBytes: gif.sizeBytes,
            previewURL: gif.previewURL
        )))
        XCTAssertFalse(AttachmentDownloadPolicy.usesImagePreview(
            for: gif,
            prefersOriginal: false
        ))
        XCTAssertTrue(AttachmentDownloadPolicy.usesImagePreview(
            for: photo,
            prefersOriginal: false
        ))
        XCTAssertFalse(AttachmentDownloadPolicy.usesImagePreview(
            for: photo,
            prefersOriginal: true
        ))
    }

    func testEverySingleAndGroupedImageDeliveryStatePlacesReceiptOverMedia() {
        for attachmentCount in [1, 2] {
            for state in [
                MessageDeliveryState.sending,
                .sent,
                .delivered,
                .read,
                .cancelled,
            ] {
                var imageMessage = message(
                    id: "image-\(state.rawValue)",
                    author: .me,
                    attachments: (0..<attachmentCount).map {
                        attachment(id: "image-\($0)", kind: .image)
                    }
                )
                imageMessage.deliveryState = state

                XCTAssertTrue(MessageImageStatusPresentation.showsOverlay(for: imageMessage))
            }
        }

        var failedImage = message(
            id: "failed-image-receipt",
            author: .me,
            attachments: [attachment(id: "image", kind: .image)]
        )
        failedImage.deliveryState = .failed
        XCTAssertTrue(MessageImageStatusPresentation.showsOverlay(for: failedImage))
    }

    func testFailedImageRetryUsesTheSharedImageStatusSlot() {
        var imageMessage = message(
            id: "failed-image",
            author: .me,
            attachments: [attachment(id: "image", kind: .image)]
        )
        imageMessage.deliveryState = .failed
        XCTAssertTrue(MessageImageStatusPresentation.showsOverlay(for: imageMessage))

        imageMessage.text = "Caption"
        XCTAssertFalse(MessageImageStatusPresentation.showsOverlay(for: imageMessage))
    }

    func testGroupedImageStackKeepsTheNextPhotosBehindTheSelection() {
        XCTAssertEqual(MessageImageStack.backdropIndices(count: 3, selectedIndex: 0), [2, 1])
        XCTAssertEqual(MessageImageStack.backdropIndices(count: 3, selectedIndex: 1), [0, 2])
        XCTAssertEqual(MessageImageStack.backdropIndices(count: 1, selectedIndex: 0), [])
        XCTAssertEqual(MessageImageStack.targetIndex(count: 3, selectedIndex: 1, direction: 1), 2)
        XCTAssertEqual(MessageImageStack.targetIndex(count: 3, selectedIndex: 0, direction: -1), 2)
    }

    private func attachment(id: String, kind: ChatAttachmentKind) -> ChatAttachment {
        ChatAttachment(
            attachmentId: id,
            name: "\(id).png",
            kind: kind,
            mimeType: kind == .image ? "image/png" : "application/octet-stream",
            sizeBytes: 1_024,
            previewURL: nil
        )
    }

    private func pendingAttachment(id: String, kind: ChatAttachmentKind) -> PendingAttachment {
        PendingAttachment(
            id: id,
            name: "\(id).dat",
            kind: kind,
            mimeType: kind == .image ? "image/jpeg" : "application/octet-stream",
            data: Data(id.utf8),
            previewURL: nil
        )
    }

    private func message(
        id: String,
        author: MessageAuthor,
        attachments: [ChatAttachment]
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: "conversation",
            author: author,
            authorName: "Maya",
            text: "",
            createdAt: Date(timeIntervalSince1970: 1_000),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            attachments: attachments
        )
    }
}
