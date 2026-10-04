import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import Kordi

final class MessageClipboardTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suiteName = "kordi.tests.clipboard.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
    }

    func testLimitedPayloadStaysLocalAndExpiresAfterTenMinutes() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let payload = MessageClipboard.payload(for: "Meeting notes", limitsCopies: true, now: now)

        XCTAssertEqual(payload.items.count, 1)
        XCTAssertEqual(payload.items.first?[UTType.utf8PlainText.identifier] as? String, "Meeting notes")
        XCTAssertEqual(payload.options[.localOnly] as? Bool, true)
        XCTAssertEqual(payload.options[.expirationDate] as? Date, now.addingTimeInterval(600))
        XCTAssertEqual(MessageClipboard.expiration, 600)
    }

    func testUnlimitedPayloadHasNoOptions() {
        let payload = MessageClipboard.payload(for: "Meeting notes", limitsCopies: false)
        XCTAssertTrue(payload.options.isEmpty)
        XCTAssertEqual(payload.items.first?[UTType.utf8PlainText.identifier] as? String, "Meeting notes")
    }

    func testLimitsAreOnUnlessTurnedOff() {
        XCTAssertEqual(MessageClipboard.storageKey, "kordi.privacy.limitCopiedMessages")
        XCTAssertTrue(MessageClipboard.limitsCopies(defaults: defaults))
        defaults.set(false, forKey: MessageClipboard.storageKey)
        XCTAssertFalse(MessageClipboard.limitsCopies(defaults: defaults))
        defaults.set(true, forKey: MessageClipboard.storageKey)
        XCTAssertTrue(MessageClipboard.limitsCopies(defaults: defaults))
    }

    @MainActor
    func testCopyWritesTheTextToTheGivenPasteboard() throws {
        let name = UIPasteboard.Name("kordi.tests.clipboard.\(UUID().uuidString)")
        let pasteboard = try XCTUnwrap(UIPasteboard(name: name, create: true))
        defer { UIPasteboard.remove(withName: name) }

        MessageClipboard.copy("Limited copy", pasteboard: pasteboard, defaults: defaults)
        XCTAssertEqual(pasteboard.string, "Limited copy")

        defaults.set(false, forKey: MessageClipboard.storageKey)
        MessageClipboard.copy("Plain copy", pasteboard: pasteboard, defaults: defaults)
        XCTAssertEqual(pasteboard.string, "Plain copy")
    }

    @MainActor
    func testExpiredLimitedCopyIsNotPasted() throws {
        let name = UIPasteboard.Name("kordi.tests.clipboard.\(UUID().uuidString)")
        let pasteboard = try XCTUnwrap(UIPasteboard(name: name, create: true))
        defer { UIPasteboard.remove(withName: name) }

        MessageClipboard.copy(
            "Old copy",
            pasteboard: pasteboard,
            defaults: defaults,
            now: Date().addingTimeInterval(-MessageClipboard.expiration - 1)
        )
        XCTAssertNil(pasteboard.string)
    }

    func testMessageCopiesUseTheLimitedClipboard() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let conversation = try String(
            contentsOf: directory.appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(conversation.contains("UIPasteboard.general.string = message.text"))
        XCTAssertFalse(conversation.contains("UIPasteboard.general.string = text"))
        XCTAssertEqual(conversation.components(separatedBy: "MessageClipboard.copy(").count - 1, 2)

        let markdown = try String(
            contentsOf: directory.appendingPathComponent("Kordi/Features/Conversation/MarkdownMessageContent.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(markdown.contains("UIPasteboard.general.string"))
        XCTAssertTrue(markdown.contains("MessageClipboard.copy(source)"))
    }
}
