import XCTest
@testable import Kordi

/// The message delete confirmation: choices, helper lines that name storage
/// only when the server deletes stored copies, the footnote, and the menu
/// layout that fits wrapping helper text.
final class MessageDeletePresentationTests: XCTestCase {
    func testOwnGroupMessageNamesStorageOnlyWhenTheServerDeletesStoredCopies() {
        let capable = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: false, isGroup: true,
            peerName: "Design", serverDeletesStoredCopies: true
        )
        XCTAssertEqual(capable.forEveryone?.title, "Delete for everyone")
        XCTAssertEqual(
            capable.forEveryone?.helper,
            "Removes it for everyone in this chat, and Kordi deletes its text and files from chat storage."
        )
        XCTAssertEqual(capable.forEveryone?.identifier, "message-delete-for-everyone")
        XCTAssertEqual(capable.forMe.title, "Remove from my view")
        XCTAssertEqual(capable.forMe.helper, "Hides it on your devices. Others in the chat still see it.")
        XCTAssertEqual(capable.forMe.identifier, "message-delete-for-me")
        XCTAssertEqual(
            capable.footnote,
            "People who already saw it may have saved a copy or taken a screenshot. "
                + "If an agent already read it, the agent's reply and what it received stay."
        )

        let conservative = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: false, isGroup: true,
            peerName: "Design", serverDeletesStoredCopies: false
        )
        XCTAssertEqual(
            conservative.forEveryone?.helper,
            "Removes it for everyone in this chat. Copies may remain on the server."
        )
        XCTAssertEqual(conservative.footnote, capable.footnote)
    }

    func testDirectAndAgentChatsNameThePersonInsteadOfSayingDeleteForMeAndThem() {
        let direct = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: false, isGroup: false,
            peerName: "Maya Chen", serverDeletesStoredCopies: true
        )
        XCTAssertEqual(direct.forEveryone?.title, "Delete for everyone")
        XCTAssertEqual(
            direct.forEveryone?.helper,
            "Removes it for you and Maya Chen, and Kordi deletes its text and files from chat storage."
        )
        let conservative = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: false, isGroup: false,
            peerName: "Maya Chen", serverDeletesStoredCopies: false
        )
        XCTAssertEqual(
            conservative.forEveryone?.helper,
            "Removes it for everyone in this chat. Copies may remain on the server."
        )
    }

    func testPhotoChoicesUseThePhotoLabelsAndIdentifiers() {
        let capable = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: true, isGroup: false,
            peerName: "Maya Chen", serverDeletesStoredCopies: true
        )
        XCTAssertEqual(capable.forEveryone?.title, "Delete photo for everyone")
        XCTAssertEqual(
            capable.forEveryone?.helper,
            "Removes this photo for everyone in this chat, and Kordi deletes the file from chat storage."
        )
        XCTAssertEqual(capable.forEveryone?.identifier, "photo-delete-for-everyone")
        XCTAssertEqual(capable.forMe.title, "Remove photo from my view")
        XCTAssertEqual(capable.forMe.identifier, "photo-delete-for-me")

        let conservative = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: true, isGroup: true,
            peerName: "Design", serverDeletesStoredCopies: false
        )
        XCTAssertEqual(
            conservative.forEveryone?.helper,
            "Removes this photo for everyone in this chat. Copies may remain on the server."
        )
    }

    func testOthersMessagesOfferOnlyRemoveFromMyView() {
        let others = MessageDeletePresentation.make(
            isOwnMessage: false, isLocalFailedSend: false, isPhoto: false, isGroup: true,
            peerName: "Design", serverDeletesStoredCopies: true
        )
        XCTAssertNil(others.forEveryone)
        XCTAssertEqual(others.forMe.title, "Remove from my view")
        XCTAssertEqual(others.forMe.helper, "Hides it on your devices. Others in the chat still see it.")
        XCTAssertNil(others.footnote)
    }

    func testConversationPassesTheServerCapabilityToTheChoices() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let conversation = try String(
            contentsOf: root.appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(conversation.contains("serverDeletesStoredCopies: model.serverContentRemovalVersion >= 1"))
        XCTAssertTrue(conversation.contains("isGroup: conversation.kind == .group, peerName: conversation.displayName"))
        let model = try String(contentsOf: root.appendingPathComponent("Kordi/App/AppModel.swift"), encoding: .utf8)
        XCTAssertTrue(model.contains("fallback: MessageDeletePresentation.deleteFailedText"))
        XCTAssertTrue(model.contains("fallback: MessageDeletePresentation.photoDeleteFailedText"))
        XCTAssertTrue(conversation.contains("model.errorMessage ?? MessageDeletePresentation.deleteFailedText"))
        XCTAssertFalse(model.contains("Could not delete this photo."))
        XCTAssertFalse(conversation.contains("Could not delete this message."))
    }

    func testDeleteFailuresUseTheRetryWording() {
        XCTAssertEqual(MessageDeletePresentation.deleteFailedText, "Could not delete the message. Try again.")
        XCTAssertEqual(MessageDeletePresentation.photoDeleteFailedText, "Could not delete the photo. Try again.")
    }

    func testFailedSendKeepsTheRemoveFailedMessageChoice() {
        let failed = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: true, isPhoto: false, isGroup: false,
            peerName: "Maya Chen", serverDeletesStoredCopies: true
        )
        XCTAssertNil(failed.forEveryone)
        XCTAssertEqual(failed.forMe.title, "Remove failed message")
        XCTAssertNil(failed.forMe.helper)
        XCTAssertNil(failed.footnote)
    }

    func testCopyNeverMakesUnsupportedClaims() {
        var texts: [String] = []
        for own in [true, false] {
            for photo in [true, false] {
                for group in [true, false] {
                    for capable in [true, false] {
                        let presentation = MessageDeletePresentation.make(
                            isOwnMessage: own, isLocalFailedSend: false, isPhoto: photo, isGroup: group,
                            peerName: "Maya", serverDeletesStoredCopies: capable
                        )
                        texts += [presentation.forEveryone?.title, presentation.forEveryone?.helper,
                                  presentation.forMe.title, presentation.forMe.helper, presentation.footnote]
                            .compactMap { $0 }
                    }
                }
            }
        }
        let joined = texts.joined(separator: "\n").lowercased()
        for phrase in ["permanently", "all servers", "securely", "forever", "backup", "cannot be undone"] {
            XCTAssertFalse(joined.contains(phrase), phrase)
        }
    }

    func testConfirmationMenuUsesItsMeasuredHeight() {
        let presentation = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: false, isGroup: true,
            peerName: "Design", serverDeletesStoredCopies: true
        )
        let source = CGRect(x: 190, y: 120, width: 180, height: 70)
        let container = CGSize(width: 390, height: 844)
        let measured = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: container, showsReactions: false,
            reactionCount: 0, actionCount: 9, menuContentHeight: 251
        )
        XCTAssertEqual(measured.menuHeight, 253)
        let estimated = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: container, showsReactions: false,
            reactionCount: 0, actionCount: 9, menuContentHeight: presentation.estimatedHeight
        )
        XCTAssertGreaterThan(estimated.menuHeight, 2 * 44)
        let tall = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: CGSize(width: 390, height: 400), showsReactions: false,
            reactionCount: 0, actionCount: 9, menuContentHeight: 900
        )
        XCTAssertLessThanOrEqual(tall.menuCenter.y + tall.menuHeight / 2, 400 - 12)
    }

    func testConfirmationWithHelperTextKeepsTheSelectedBubbleInPlace() {
        let presentation = MessageDeletePresentation.make(
            isOwnMessage: true, isLocalFailedSend: false, isPhoto: false, isGroup: false,
            peerName: "Maya Chen", serverDeletesStoredCopies: true
        )
        let source = CGRect(x: 20, y: -60, width: 300, height: 820)
        let size = CGSize(width: 390, height: 700)
        let regular = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: size, showsReactions: true, reactionCount: 6, actionCount: 8)
        let confirmation = MessageActionOverlayLayout.make(
            sourceFrame: source, containerSize: size, showsReactions: false, reactionCount: 0, actionCount: 8,
            forcedMenuIsBelow: regular.menuIsBelow, fixedPreviewFrame: regular.previewFrame,
            menuContentHeight: presentation.estimatedHeight)
        XCTAssertEqual(confirmation.previewFrame, regular.previewFrame)
        XCTAssertEqual(confirmation.menuHeight, presentation.estimatedHeight + 2)
        XCTAssertTrue(regular.menuIsBelow)
        XCTAssertGreaterThanOrEqual(confirmation.menuCenter.y - confirmation.menuHeight / 2, regular.previewFrame.maxY + 8)
    }
}
