import XCTest

@MainActor
final class MessageDeletionUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTextDeletionClosesMenuAndPreservesNeighbor() {
        let app = launchTextDeletion()
        let target = message("m5", in: app)
        capture("Text before deletion", app: app)
        app.buttons["Delete"].tap()
        let confirm = app.buttons["Delete for me"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        assertRenderedParticles("m5:message", in: app)
        for frame in 1...3 {
            capture("Particle transition frame \(frame)", app: app)
            Thread.sleep(forTimeInterval: 0.15)
        }
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
        XCTAssertTrue(target.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        XCTAssertTrue(revealMessage("m4-voice", in: app))
        XCTAssertFalse(target.exists)
        capture("Text after deletion", app: app)
        app.terminate()
    }

    func testPhotoDeletionForEveryoneClosesMenuAndKeepsComposerInteractive() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        // The grouped photo surface is not exposed as an accessibility element;
        // use the stable, geometry-bound preview hook to exercise its action menu.
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-media-messages", "--preview-message-delete-photo"]
        app.launch()
        XCTAssertTrue(app.buttons["Delete photo"].waitForExistence(timeout: 15))
        capture("Photos before deletion", app: app)
        app.buttons["Delete photo"].tap()
        let confirm = app.buttons["Delete photo for me and Maya Chen"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        for frame in 1...3 {
            capture("Particle transition frame \(frame)", app: app)
            Thread.sleep(forTimeInterval: 0.15)
        }
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        capture("Photos after deletion", app: app)
        let composer = app.buttons["Add photo, video, or file"]
        XCTAssertTrue(composer.isHittable)
        composer.tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5))
        capture("Composer responds after photo deletion", app: app)
        app.terminate()
    }

    func testTextDeletionAnimationHitches() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Hitch metrics require iOS 26.") }
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTHitchMetric(application: app)], options: options) {
            openTextMenu(in: app)
            app.buttons["Delete"].tap()
            XCTAssertTrue(app.buttons["Delete for me"].waitForExistence(timeout: 5))
            startMeasuring()
            app.buttons["Delete for me"].tap()
            XCTAssertTrue(app.buttons["Delete for me"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(message("m5", in: app).waitForNonExistence(timeout: 5))
            stopMeasuring()
            XCTAssertTrue(revealMessage("m4-voice", in: app))
            XCTAssertFalse(message("m5", in: app).exists)
            app.terminate()
        }
    }

    func testReplyReturnsToConversationAndKeepsComposerInteractive() {
        let app = launchTextDeletion()
        app.buttons["Reply in conversation"].tap()
        XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        XCTAssertTrue(message("m5", in: app).exists)
        app.buttons["Cancel reply"].tap()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
        app.terminate()
    }

    func testSelectionAndForwardingAfterMenuDismissal() {
        let app = launchTextDeletion()
        app.buttons["Select"].tap()
        XCTAssertTrue(app.buttons["Forward selected messages"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        app.buttons["Cancel"].tap()
        app.terminate()

        openTextMenu(in: app)
        app.buttons["Forward"].tap()
        XCTAssertTrue(app.navigationBars["Forward"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testBackdropDismissalAllowsReopeningMessageMenu() {
        let app = launchTextDeletion()
        app.buttons["Close message actions"].coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(revealMessage("m5", in: app))
        let target = message("m5", in: app)
        target.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Reply in conversation"].waitForExistence(timeout: 5))
        app.buttons["Reply in conversation"].tap()
        XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testCopyDismissalAnimationHitches() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Hitch metrics require iOS 26.") }
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTHitchMetric(application: app)], options: options) {
            openTextMenu(in: app)
            startMeasuring()
            app.buttons["Copy"].tap()
            XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
            stopMeasuring()
            XCTAssertTrue(revealMessage("m5", in: app))
            app.terminate()
        }
    }

    func testLongMessageKeepsTypographyScrollsAndReturnsWithoutReflow() {
        checkMessagePreviewLayout(isLong: true)
    }

    func testLongMessageQuickAndExpandedReactionsAfterPreviewScroll() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-long-message-actions"]
        app.launch()
        let marker = app.staticTexts["Long message end marker."]
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        marker.press(forDuration: 0.4)
        let quick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "React with ")).firstMatch
        XCTAssertTrue(quick.waitForExistence(timeout: 5))
        let name = String(quick.label.dropFirst("React with ".count))
        let originalY = marker.frame.minY
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.26))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.36)))
        XCTAssertGreaterThan(marker.frame.minY, originalY + 20)
        quick.tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        let reaction = app.buttons["\(name) reaction, 1 people"]
        XCTAssertTrue(reaction.waitForExistence(timeout: 5))
        // The ordinary cancellation path is a tap on one's existing reaction.
        reaction.tap()
        XCTAssertTrue(reaction.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        // Re-add it only to cover the expanded picker's separate hit region.
        marker.press(forDuration: 0.4)
        let sameQuickReaction = app.buttons["React with \(name)"]
        XCTAssertTrue(sameQuickReaction.waitForExistence(timeout: 5))
        sameQuickReaction.tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(reaction.waitForExistence(timeout: 5))
        marker.press(forDuration: 0.4)
        XCTAssertTrue(app.buttons["Show all reactions"].waitForExistence(timeout: 5))
        app.buttons["Show all reactions"].tap()
        XCTAssertTrue(app.buttons["Collapse reaction picker"].waitForExistence(timeout: 5))
        let sameReaction = app.buttons[name].firstMatch
        XCTAssertTrue(sameReaction.waitForExistence(timeout: 5))
        sameReaction.tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(reaction.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
        app.terminate()
    }

    func testShortFormattedMessageReturnsWithoutReflow() {
        checkMessagePreviewLayout(isLong: false)
    }

    func testSelectionKeepsFormattedMessageWidthAndLineBreaks() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-formatted-message-actions"]
        app.launch()
        let marker = app.staticTexts["Long message end marker."]
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        let original = marker.frame
        marker.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Select"].waitForExistence(timeout: 5))
        app.buttons["Select"].tap()
        XCTAssertTrue(app.buttons["Forward selected messages"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(marker.frame.width, original.width, accuracy: 1)
        XCTAssertEqual(marker.frame.height, original.height, accuracy: 1)
        capture("Selection preserves message layout", app: app)
        app.buttons["Cancel"].tap()
        XCTAssertEqual(marker.frame.width, original.width, accuracy: 1)
        app.terminate()
    }

    private func checkMessagePreviewLayout(isLong: Bool) {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat",
                               isLong ? "--preview-long-message-actions" : "--preview-formatted-message-actions"]
        app.launch()
        let marker = app.staticTexts["Long message end marker."]
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        let original = marker.frame
        capture("Long message before menu", app: app)
        marker.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Reply in conversation"].waitForExistence(timeout: 5))
        XCTAssertTrue(marker.exists, "Opening actions must retain the formatted text elements.")
        let lifted = marker.frame
        XCTAssertEqual(lifted.width, original.width, accuracy: 1)
        XCTAssertEqual(lifted.height, original.height, accuracy: 1)
        capture("Long message at original reading size", app: app)
        if isLong {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.26))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.46))
            start.press(forDuration: 0.05, thenDragTo: end)
            XCTAssertGreaterThan(marker.frame.minY, lifted.minY + 20, "The lifted message must scroll independently.")
        }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(marker.frame.width, original.width, accuracy: 1)
        XCTAssertEqual(marker.frame.height, original.height, accuracy: 1)
        XCTAssertEqual(marker.frame.minY, original.minY, accuracy: 2, "Dismissal must preserve the conversation's reading position.")
        capture("Long message after dismissal", app: app)
        app.terminate()
    }

    func testVoiceLongPressDoesNotToggleTranscript() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-voice-message-actions"]
        app.launch()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 10))
        let transcript = app.buttons["Show voice transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        transcript.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Reply in conversation"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Hide voice transcript"].exists, "A hold must not also tap the transcript button.")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Hide voice transcript"].exists)
        transcript.tap()
        XCTAssertTrue(app.buttons["Hide voice transcript"].waitForExistence(timeout: 5), "An intentional tap must still expand the transcript.")
        app.buttons["Hide voice transcript"].tap()
        capture("Voice transcript stays collapsed after long press", app: app)
        app.terminate()
    }

    func testImageAndCaptionHaveIndependentLongPressTargets() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-image-caption-actions"]
        app.launch()
        let photo = app.descendants(matching: .any).matching(identifier: "message-image-image-caption").firstMatch
        let caption = app.staticTexts["A caption with bold text stays independent of the image."]
        XCTAssertTrue(caption.waitForExistence(timeout: 10))
        XCTAssertTrue(photo.exists)
        let photoFrame = photo.frame
        let captionFrame = caption.frame
        caption.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Review"].exists)
        XCTAssertEqual(photo.frame.minY, photoFrame.minY, accuracy: 1)
        XCTAssertEqual(photo.frame.width, photoFrame.width, accuracy: 1)
        capture("Caption menu leaves image in place", app: app)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        photo.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Copy"].exists)
        XCTAssertEqual(caption.frame.minY, captionFrame.minY, accuracy: 1)
        XCTAssertEqual(caption.frame.width, captionFrame.width, accuracy: 1)
        capture("Image menu leaves caption in place", app: app)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(photo.frame.minY, photoFrame.minY, accuracy: 1)
        app.terminate()
    }

    func testBlobAndMarkdownStayRenderedDuringLongPress() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-rich-message-actions"]
        app.launch()
        let marker = app.staticTexts["Rich message end marker."]
        let heading = app.staticTexts["Rendered message"]
        let blob = message("rich-menu", in: app).descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "blobwave")).firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        XCTAssertTrue(blob.exists)
        XCTAssertTrue(heading.exists)
        capture("Blob emoji and Markdown before menu", app: app)
        marker.press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5))
        capture("Rendered inline blob during menu", app: app)
        XCTAssertTrue(blob.exists, "The blob must remain an image, not its raw token.")
        XCTAssertTrue(heading.exists, "The Markdown heading must remain rendered.")
        // Native text selection enlarges AX hit rectangles, which are not glyph
        // bounds. ConversationReadPresentationTests checks actual layout sizes.
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", ":blob:blobwave:")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "**Bold stays bold**")).firstMatch.exists)
        capture("Blob emoji and Markdown stay rendered in menu", app: app)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(blob.exists)
        app.terminate()
    }

    func testExpandedPhotoGroupMovesOnlyTheHeldPhoto() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-image-caption-actions",
                               "--preview-image-caption-group", "--preview-media-expanded"]
        app.launch()
        let first = app.descendants(matching: .any).matching(identifier: "message-photo-image-caption-att_preview_image").firstMatch
        let second = app.descendants(matching: .any).matching(identifier: "message-photo-image-caption-att_preview_image_bars").firstMatch
        let caption = app.staticTexts["A caption with bold text stays independent of the image."]
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(first.exists)
        let firstFrame = first.frame
        let secondFrame = second.frame
        let captionFrame = caption.frame
        // Image gestures are recognized by the enclosing native scroll view.
        // Send the hold to the image's visible center instead of AX hit testing.
        let point = CGPoint(x: secondFrame.midX, y: secondFrame.midY)
        XCTAssertTrue(app.frame.contains(point))
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: point.x, dy: point.y)).press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 5))
        XCTAssertEqual(first.frame.minY, firstFrame.minY, accuracy: 1)
        XCTAssertEqual(first.frame.width, firstFrame.width, accuracy: 1)
        XCTAssertEqual(caption.frame.minY, captionFrame.minY, accuracy: 1)
        let floatingPhoto = app.descendants(matching: .any).matching(identifier: "message-action-photo-preview").firstMatch
        let liftedFrame = floatingPhoto.exists ? floatingPhoto.frame : second.frame
        XCTAssertGreaterThan(abs(liftedFrame.minY - secondFrame.minY), 2, "Only the held image should lift into the preview.")
        capture("Expanded group keeps other photo and caption stationary", app: app)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(first.frame.minY, firstFrame.minY, accuracy: 1)
        XCTAssertEqual(second.frame.minY, secondFrame.minY, accuracy: 1)
        app.terminate()
    }

    func testGroupedPhotosReactAndDeleteIndependently() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-image-caption-actions",
                               "--preview-image-caption-group", "--preview-media-expanded", "--preview-particle-probe"]
        app.launch()
        let first = app.descendants(matching: .any).matching(identifier: "message-photo-image-caption-att_preview_image").firstMatch
        let second = app.descendants(matching: .any).matching(identifier: "message-photo-image-caption-att_preview_image_bars").firstMatch
        let firstReactions = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "photo-reactions-image-caption-att_preview_image::")).firstMatch
        let secondReactions = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "photo-reactions-image-caption-att_preview_image_bars::")).firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        let firstWidth = first.frame.width
        pressCenter(of: second, in: app)
        let quickReaction = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "React with ")).firstMatch
        XCTAssertTrue(quickReaction.waitForExistence(timeout: 5))
        let reactionLabel = quickReaction.label
        quickReaction.tap()
        capture("Photo reaction is scoped to the held image", app: app)
        XCTAssertTrue(secondReactions.waitForExistence(timeout: 5))
        XCTAssertFalse(firstReactions.exists)
        // A chip tap must not also open the image viewer.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo reaction ")).firstMatch.tap()
        XCTAssertTrue(secondReactions.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
        pressCenter(of: first, in: app)
        XCTAssertTrue(app.buttons[reactionLabel].waitForExistence(timeout: 5))
        app.buttons[reactionLabel].tap()
        XCTAssertTrue(firstReactions.waitForExistence(timeout: 5))
        XCTAssertFalse(secondReactions.exists)
        pressCenter(of: second, in: app)
        XCTAssertTrue(app.buttons["Delete photo"].waitForExistence(timeout: 5))
        app.buttons["Delete photo"].tap()
        XCTAssertTrue(app.buttons["Delete photo for me"].waitForExistence(timeout: 5))
        app.buttons["Delete photo for me"].tap()
        assertRenderedParticles("image-caption:att_preview_image_bars", in: app)
        XCTAssertTrue(second.waitForNonExistence(timeout: 5))
        XCTAssertTrue(first.exists)
        XCTAssertEqual(first.frame.width, firstWidth, accuracy: 1)
        XCTAssertTrue(firstReactions.exists)
        XCTAssertTrue(app.staticTexts["A caption with bold text stays independent of the image."].exists)
        capture("One photo deleted, neighbor and its reaction retained", app: app)
        app.terminate()
    }

    func testExpandedPhotosAndSelectionSurviveScrollingOutOfTheViewport() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-menu-test-chat"]
        app.launch()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 10))
        let stack = app.buttons.matching(NSPredicate(format: "label == %@ AND value BEGINSWITH %@",
            "Expand 2 grouped photos", "Photo ")).firstMatch
        for _ in 0..<10 {
            if stack.exists && stack.isHittable && stack.frame.minY > 140
                && stack.frame.maxY < app.frame.height - 120 { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.3))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.55)))
        }
        XCTAssertTrue(stack.isHittable)
        stack.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: stack.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)))
        let selected = app.buttons.matching(NSPredicate(format: "label == %@ AND value == %@",
            "Expand 2 grouped photos", "Photo 2 of 2")).firstMatch
        capture("Selected photo before eviction", app: app)
        XCTAssertTrue(selected.waitForExistence(timeout: 5), "The photo swipe must select the second attachment")
        selected.tap()
        let collapse = app.buttons["Collapse grouped photos"].firstMatch
        XCTAssertTrue(collapse.waitForExistence(timeout: 5))
        let photo = app.descendants(matching: .any).matching(identifier:
            "message-photo-demo-photo-group-att_preview_image_portrait").firstMatch
        for _ in 0..<14 {
            if !photo.exists { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.8)))
        }
        XCTAssertFalse(photo.exists, "The test must evict the photo content, not merely cover it")
        let latest = app.buttons["Go to latest message"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        latest.tap()
        XCTAssertTrue(collapse.waitForExistence(timeout: 5), "The returning group must remain expanded")
        for _ in 0..<8 {
            if collapse.isHittable { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.3))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.55)))
        }
        collapse.tap()
        XCTAssertTrue(selected.waitForExistence(timeout: 5), "The selected attachment must survive eviction and expansion")
        app.terminate()
    }

    func testPhotoHighlightTracksItsBoundsAfterScrollingAndReopening() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-menu-test-chat",
                               "--preview-media-expanded", "--preview-action-geometry"]
        app.launch()
        let photo = app.descendants(matching: .any).matching(identifier:
            "message-photo-demo-photo-group-att_preview_image_portrait").firstMatch
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 10))
        let latest = app.buttons["Go to latest message"]
        var jumpedToLatest = false
        for _ in 0..<10 {
            if photo.exists, photo.frame.minY > 150, photo.frame.maxY < app.frame.height - 110 { break }
            // Restored read positions expose this button after the first scroll.
            if !jumpedToLatest, !photo.exists, latest.exists, latest.isHittable {
                latest.tap()
                jumpedToLatest = true
                continue
            }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.3))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.55)))
        }
        capture("Portrait located in mixed conversation", app: app)
        XCTAssertTrue(photo.exists)
        for attempt in 0..<2 {
            capture("Portrait before menu \(attempt)", app: app)
            let originalFrame = photo.frame
            pressCenter(of: photo, in: app)
            let backdrop = app.buttons["Close message actions"]
            XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
            let mask = NSCoder.cgRect(for: backdrop.value as? String ?? "")
            let floatingPhoto = app.descendants(matching: .any).matching(identifier: "message-action-photo-preview").firstMatch
            let actual = floatingPhoto.exists ? floatingPhoto.frame : photo.frame
            capture("Portrait highlight after scrolling \(attempt)", app: app)
            if floatingPhoto.exists {
                XCTAssertEqual(mask, .zero, "A floating photo must not expose neighboring messages through the backdrop.")
                XCTAssertEqual(actual.width, originalFrame.width, accuracy: 1)
                XCTAssertEqual(actual.height, originalFrame.height, accuracy: 1)
            } else {
                XCTAssertEqual(mask.minX, actual.minX, accuracy: 1)
                XCTAssertEqual(mask.minY, actual.minY, accuracy: 1)
                XCTAssertEqual(mask.width, actual.width, accuracy: 1)
                XCTAssertEqual(mask.height, actual.height, accuracy: 1)
            }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
            XCTAssertTrue(backdrop.waitForNonExistence(timeout: 5))
            capture("Portrait returned to conversation \(attempt)", app: app)
            XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
            XCTAssertEqual(photo.frame.minY, originalFrame.minY, accuracy: 1)
            if attempt == 0 {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.4))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.52)))
            }
        }
        // Returning from a context menu must also restore normal keyboard layout.
        let editor = app.textViews["Message Maya Chen"]
        let editorTop = editor.frame.minY
        let photoTop = photo.frame.minY
        editor.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("Keyboard after returning from photo menus", app: app)
        XCTAssertTrue(photo.exists, "Opening the keyboard must not remove the visible photo from the timeline.")
        XCTAssertEqual(photo.frame.minY, photoTop - (editorTop - editor.frame.minY), accuracy: 14,
                       "Opening the keyboard after dismissal must preserve the visible history.")
        app.terminate()
    }

    func testShortPressCancelsFeedbackAndNextHoldStillOpensMenu() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-formatted-message-actions"]
        app.launch()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 10))
        goToLatestIfNeeded(in: app)
        XCTAssertTrue(revealMessage("m5", in: app))
        message("m5", in: app).press(forDuration: 0.18)
        XCTAssertFalse(app.buttons["Close message actions"].exists)
        message("m5", in: app).press(forDuration: 0.4)
        XCTAssertTrue(app.buttons["Close message actions"].waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.4)).tap()
        XCTAssertTrue(app.buttons["Close message actions"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
        app.terminate()
    }

    func testPhotoDeletionFadeFallbackReleasesRetainedPhoto() {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-image-caption-actions",
                               "--preview-image-caption-group", "--preview-media-expanded", "--preview-particle-fade"]
        app.launch()
        let first = app.descendants(matching: .any).matching(identifier: "message-photo-image-caption-att_preview_image").firstMatch
        let second = app.descendants(matching: .any).matching(identifier: "message-photo-image-caption-att_preview_image_bars").firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        pressCenter(of: second, in: app)
        XCTAssertTrue(app.buttons["Delete photo"].waitForExistence(timeout: 5))
        app.buttons["Delete photo"].tap()
        app.buttons["Delete photo for me"].tap()
        XCTAssertTrue(second.waitForNonExistence(timeout: 8))
        XCTAssertTrue(first.exists)
        XCTAssertTrue(app.staticTexts["A caption with bold text stays independent of the image."].exists)
        XCTAssertTrue(app.buttons["Add photo, video, or file"].isHittable)
        app.terminate()
    }

    private func assertRenderedParticles(_ scope: String, in app: XCUIApplication) {
        let marker = app.descendants(matching: .any).matching(identifier: "deletion-particles-rendered").firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 8), "Deletion must submit a Metal particle frame, not only remove the message.")
        XCTAssertEqual(marker.value as? String, scope)
    }

    private func pressCenter(of element: XCUIElement, in app: XCUIApplication) {
        let frame = element.frame
        let point = CGPoint(x: frame.midX, y: frame.midY)
        XCTAssertTrue(app.frame.contains(point))
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: point.x, dy: point.y)).press(forDuration: 0.6)
    }

    private func launchTextDeletion() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "ai.kordi.ios.beta")
        openTextMenu(in: app)
        return app
    }

    private func openTextMenu(in app: XCUIApplication) {
        app.launchArguments = ["--preview-data", "--preview-contact-chat", "--preview-particle-probe"]
        app.launch()
        XCTAssertTrue(app.buttons["Add photo, video, or file"].waitForExistence(timeout: 10))
        goToLatestIfNeeded(in: app)
        XCTAssertTrue(revealMessage("m5", in: app))
        message("m5", in: app).press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
    }

    private func goToLatestIfNeeded(in app: XCUIApplication) {
        let latest = app.buttons["Go to latest message"]
        if latest.waitForExistence(timeout: 1), latest.isHittable { latest.tap() }
    }

    private func revealMessage(_ id: String, in app: XCUIApplication, towardLatest: Bool = false) -> Bool {
        // Returning a lifted preview can place its source outside a smaller
        // device's viewport. Check preservation after bringing it into view.
        let target = message(id, in: app)
        for _ in 0..<4 {
            if target.exists && target.isHittable { return true }
            if towardLatest { app.scrollViews.firstMatch.swipeUp() }
            else { app.scrollViews.firstMatch.swipeDown() }
        }
        return target.exists && target.isHittable
    }

    private func message(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "message-\(id)").firstMatch
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
