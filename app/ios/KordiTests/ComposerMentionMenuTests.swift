import UIKit
import XCTest
import Testing
@testable import Kordi

@Test
func mentionOwnerCaptionUsesAccountIdentity() {
    let target = ComposerMentionTarget(
        id: "agent:cloud-agent:acct_owner", displayName: "Alex's Kordi", kind: .agent,
        accountId: "acct_owner", agentId: "cloud-agent:acct_owner", ownerName: "Alex", avatarSource: nil
    )
    let item = ComposerMentionMenuItem(kind: .target(target))
    #expect(item.detail(for: "acct_owner") == "Owner · You")
    #expect(item.detail(for: "acct_other") == "Owner · Alex")
    #expect(item.detail() == "Owner · Alex")
    #expect(item.accessibilityLabel(for: "acct_owner") == "Alex's Kordi, Owner · You")
    #expect(item.target?.agentId == target.agentId)
    #expect(item.target?.mentionText == "@KordiAlex")
    let partial = ComposerMentionQuery(range: NSRange(location: 0, length: 7),
        raw: "KordiA", normalized: "kordia", trailingWhitespace: false)
    #expect(ComposerMentionMenuCatalog.items(for: partial, targets: [target]).first?.target?.id == target.id)
    let completed = ComposerMentionQuery(range: NSRange(location: 0, length: 11),
        raw: "KordiAlex ", normalized: "kordialex", trailingWhitespace: true)
    #expect(ComposerMentionMenuCatalog.items(for: completed, targets: [target]).isEmpty)
}

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

        XCTAssertEqual(replacement.text, "Ask \(agent.mentionText) about this")
        XCTAssertEqual(replacement.selection.location, ("Ask \(agent.mentionText)" as NSString).length)
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

    func testComposerHighlightsActiveAndSelectedMentionsOnly() throws {
        let value = "Hello \(agent.mentionText)"
        let query = try XCTUnwrap(ComposerMentionQuery.current(
            in: value,
            selection: ComposerTextSelection(location: (value as NSString).length, length: 0)
        ))
        let activeHighlights = ComposerMentionText.highlights(
            in: value,
            activeQuery: query,
            menuIsPresented: true,
            selectedTarget: nil
        )
        let selectedHighlights = ComposerMentionText.highlights(
            in: value,
            activeQuery: query,
            menuIsPresented: false,
            selectedTarget: agent
        )
        XCTAssertEqual(activeHighlights, [.init(range: query.range, kind: .active)])
        XCTAssertEqual(selectedHighlights, [
            .init(range: NSRange(location: 6, length: (agent.mentionText as NSString).length), kind: .agent),
        ])
        XCTAssertTrue(ComposerMentionText.highlights(
            in: value,
            activeQuery: query,
            menuIsPresented: false,
            selectedTarget: nil
        ).isEmpty)

        let active = ComposerMentionText.attributedString(
            value,
            font: .preferredFont(forTextStyle: .body),
            highlights: selectedHighlights
        )
        let inactive = ComposerMentionText.attributedString(
            value,
            font: .preferredFont(forTextStyle: .body),
            highlights: []
        )
        let light = UITraitCollection(userInterfaceStyle: .light)
        let plain = try XCTUnwrap(
            active.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        ).resolvedColor(with: light)
        let mention = try XCTUnwrap(
            active.attribute(.foregroundColor, at: 7, effectiveRange: nil) as? UIColor
        ).resolvedColor(with: light)
        let inactiveMention = try XCTUnwrap(
            inactive.attribute(.foregroundColor, at: 7, effectiveRange: nil) as? UIColor
        ).resolvedColor(with: light)

        XCTAssertNotEqual(plain, mention)
        XCTAssertEqual(plain, inactiveMention)
    }
}
