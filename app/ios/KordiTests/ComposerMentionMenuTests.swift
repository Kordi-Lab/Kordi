import UIKit
import XCTest
@testable import Kordi

final class ComposerMentionMenuTests: XCTestCase {
    private let agent = ComposerMentionTarget(
        id: "agent:kordi",
        displayName: "Kordi",
        kind: .agent,
        accountId: "acct_owner",
        agentId: "agent_kordi",
        ownerName: "Alex",
        avatarSource: nil
    )

    func testQueryUsesTheCaretAndTriggersAfterExistingText() throws {
        let text = "Please review@Kor before sending"
        let cursor = ("Please review@Kor" as NSString).length
        let query = try XCTUnwrap(ComposerMentionQuery.current(
            in: text,
            selection: ComposerTextSelection(location: cursor, length: 0)
        ))

        XCTAssertEqual(query.raw, "Kor")
        XCTAssertEqual(query.range.location, ("Please review" as NSString).length)
        XCTAssertEqual(query.range.length, ("@Kor" as NSString).length)
        XCTAssertNotNil(ComposerMentionQuery.current(
            in: "Message@",
            selection: ComposerTextSelection(location: ("Message@" as NSString).length, length: 0)
        ))
    }

    func testWhitespaceImmediatelyAfterAtDoesNotOpenTheMenu() {
        let text = "hello @ hello"
        XCTAssertNil(ComposerMentionQuery.current(
            in: text,
            selection: ComposerTextSelection(location: (text as NSString).length, length: 0)
        ))
    }

    func testInitialMenuOffersFilesAndWebBeforePeopleAndAgents() throws {
        let query = try XCTUnwrap(ComposerMentionQuery.current(
            in: "@",
            selection: ComposerTextSelection(location: 1, length: 0)
        ))
        let items = ComposerMentionMenuCatalog.items(for: query, targets: [agent])

        XCTAssertEqual(items.map(\.section), [.references, .references, .agents])
        XCTAssertEqual(items.map(\.label), ["Attach file…", "Web link", "Kordi"])
    }

    func testMentionInsertionPreservesTextAfterTheCaret() throws {
        let text = "Ask @Kor about this"
        let cursor = ("Ask @Kor" as NSString).length
        let query = try XCTUnwrap(ComposerMentionQuery.current(
            in: text,
            selection: ComposerTextSelection(location: cursor, length: 0)
        ))

        let replacement = ComposerMentionInsertion.replacing(
            text,
            query: query,
            with: ComposerMentionMenuItem(kind: .target(agent))
        )

        XCTAssertEqual(replacement.text, "Ask @Kordi about this")
        XCTAssertEqual(replacement.selection.location, ("Ask @Kordi" as NSString).length)
    }

    func testFileActionRemovesOnlyTheActiveMentionToken() throws {
        let text = "Review @ before sending"
        let cursor = ("Review @" as NSString).length
        let query = try XCTUnwrap(ComposerMentionQuery.current(
            in: text,
            selection: ComposerTextSelection(location: cursor, length: 0)
        ))

        let replacement = ComposerMentionInsertion.replacing(
            text,
            query: query,
            with: ComposerMentionMenuItem(kind: .pickFile)
        )

        XCTAssertEqual(replacement.text, "Review before sending")
        XCTAssertEqual(replacement.selection.location, ("Review " as NSString).length)
    }

    func testCompletedWebLinkDropsTheMentionSigil() throws {
        let text = "Use @https://example.com"
        let query = try XCTUnwrap(ComposerMentionQuery.current(
            in: text,
            selection: ComposerTextSelection(location: (text as NSString).length, length: 0)
        ))
        let item = try XCTUnwrap(
            ComposerMentionMenuCatalog.items(for: query, targets: []).first
        )

        let replacement = ComposerMentionInsertion.replacing(text, query: query, with: item)

        XCTAssertEqual(replacement.text, "Use https://example.com ")
    }

    func testComposerHighlightsTheAtSign() throws {
        let text = ComposerMentionText.attributedString(
            "Hello @Kordi",
            font: .preferredFont(forTextStyle: .body)
        )
        let light = UITraitCollection(userInterfaceStyle: .light)
        let plain = try XCTUnwrap(
            text.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        ).resolvedColor(with: light)
        let mention = try XCTUnwrap(
            text.attribute(.foregroundColor, at: 6, effectiveRange: nil) as? UIColor
        ).resolvedColor(with: light)

        XCTAssertNotEqual(plain, mention)
    }
}
