import XCTest
@testable import Kordi

final class SharedDocumentModelTests: XCTestCase {
    private let fixture = """
    {
      "attachmentId": "att_example",
      "title": "Kordi Related Work",
      "fileName": "related-work.md",
      "format": "markdown",
      "contentType": "text/markdown",
      "sizeBytes": 18432,
      "createdAt": "2026-10-09T09:31:00Z",
      "updatedAt": "2026-10-09T09:32:00.250Z",
      "sessionId": "session_example",
      "sessionTitle": "Related work",
      "author": { "accountId": "acct_example", "displayName": "Alex Morgan", "kordiId": "123456789", "avatarUrl": null },
      "agent": { "displayName": "Lab agent" },
      "blocks": [
        { "id": "b0", "source": "# Kordi Related Work", "html": "<h1>Kordi Related Work</h1>" },
        { "id": "b1", "source": "Almost all published work.", "html": "<p>Almost all published work.</p>" }
      ],
      "rawPath": null,
      "reactions": [
        { "reactionId": "docrx_1", "blockId": "b1", "reaction": "👍", "actor": { "accountId": "acct_example", "readerKey": null, "displayName": "Alex Morgan" }, "mine": true, "createdAt": "2026-10-09T10:00:00Z" },
        { "reactionId": "docrx_2", "blockId": "b1", "reaction": "👍", "actor": { "accountId": null, "readerKey": null, "displayName": "Priya" }, "mine": false, "createdAt": "2026-10-09T10:01:00Z" },
        { "reactionId": "docrx_3", "blockId": "b1", "reaction": "❤️", "actor": { "accountId": null, "readerKey": null, "displayName": "Theo" }, "mine": false, "createdAt": "2026-10-09T10:02:00Z" }
      ],
      "comments": [
        { "commentId": "doccmt_1", "blockId": "b1", "parentCommentId": null, "author": { "accountId": null, "displayName": "Priya", "kordiId": null, "avatarUrl": null }, "body": "@Lab agent what does this mean?", "mentionsAgent": true, "mine": false, "createdAt": "2026-10-09T10:15:00Z", "editedAt": null, "resolvedAt": null },
        { "commentId": "doccmt_2", "blockId": "b1", "parentCommentId": "doccmt_1", "author": { "accountId": "acct_example", "displayName": "Alex Morgan", "kordiId": "123456789", "avatarUrl": "https://example.com/a.png" }, "body": "Good question.", "mentionsAgent": false, "mine": true, "createdAt": "2026-10-09T10:16:00Z", "editedAt": "2026-10-09T10:17:00Z", "resolvedAt": null },
        { "commentId": "doccmt_3", "blockId": "b0", "parentCommentId": null, "author": { "accountId": null, "displayName": "Theo", "kordiId": null, "avatarUrl": null }, "body": "Done.", "mentionsAgent": false, "mine": false, "createdAt": "2026-10-09T10:20:00Z", "editedAt": null, "resolvedAt": "2026-10-09T10:30:00Z" }
      ],
      "share": %SHARE%,
      "viewer": "%VIEWER%",
      "viewerCan": { "share": true, "react": true, "comment": true, "askAgent": false%EDIT% }%EXTRA%
    }
    """

    private func decode(
        share: String,
        viewer: String = "owner",
        agentNull: Bool = false,
        editing: Bool = false
    ) throws -> DocumentResponse {
        var json = fixture.replacingOccurrences(of: "%SHARE%", with: share)
            .replacingOccurrences(of: "%VIEWER%", with: viewer)
            .replacingOccurrences(of: "%EDIT%", with: editing ? #", "edit": true"# : "")
            .replacingOccurrences(
                of: "%EXTRA%",
                with: editing ? #", "revision": 7, "requestedAttachmentId": "att_copy""# : ""
            )
        if agentNull {
            json = json.replacingOccurrences(of: #"{ "displayName": "Lab agent" }"#, with: "null")
        }
        return try JSONDecoder().decode(DocumentResponse.self, from: Data(json.utf8))
    }

    func testDecodesEveryField() throws {
        let share = """
        { "shareId": "docshare_example", "attachmentId": "att_example", "shareUrl": "https://kordi.ai/d/kordi_ds_example", "deepLink": "kordi://document/kordi_ds_example", "accessMode": "link", "readersCanAskAgent": true, "createdAt": "2026-10-09T11:00:00Z", "revokedAt": null }
        """
        let document = try decode(share: share)
        XCTAssertEqual(document.attachmentId, "att_example")
        XCTAssertEqual(document.title, "Kordi Related Work")
        XCTAssertEqual(document.fileName, "related-work.md")
        XCTAssertEqual(document.format, .markdown)
        XCTAssertEqual(document.contentType, "text/markdown")
        XCTAssertEqual(document.sizeBytes, 18_432)
        XCTAssertEqual(document.createdAt, "2026-10-09T09:31:00Z")
        XCTAssertNotNil(DocumentDates.parse(document.updatedAt))
        XCTAssertEqual(document.sessionId, "session_example")
        XCTAssertEqual(document.sessionTitle, "Related work")
        XCTAssertEqual(document.author, DocumentAuthor(accountId: "acct_example", displayName: "Alex Morgan", kordiId: "123456789", avatarUrl: nil))
        XCTAssertEqual(document.agent?.displayName, "Lab agent")
        XCTAssertEqual(document.blocks.map(\.id), ["b0", "b1"])
        XCTAssertEqual(document.blocks[1].html, "<p>Almost all published work.</p>")
        XCTAssertNil(document.rawPath)
        XCTAssertEqual(document.reactions.count, 3)
        XCTAssertEqual(document.reactions[0].actor.accountId, "acct_example")
        XCTAssertNil(document.reactions[1].actor.readerKey)
        XCTAssertEqual(document.comments[1].parentCommentId, "doccmt_1")
        XCTAssertEqual(document.comments[1].author.avatarUrl, "https://example.com/a.png")
        XCTAssertEqual(document.comments[1].editedAt, "2026-10-09T10:17:00Z")
        XCTAssertTrue(document.comments[0].mentionsAgent)
        XCTAssertEqual(document.share?.shareId, "docshare_example")
        XCTAssertEqual(document.share?.readersCanAskAgent, true)
        XCTAssertNil(document.share?.revokedAt)
        XCTAssertEqual(document.viewer, .owner)
        XCTAssertEqual(document.viewerCan, DocumentViewerCapabilities(share: true, react: true, comment: true, askAgent: false))
    }

    func testDecodesNullShareAndNullAgent() throws {
        let document = try decode(share: "null", viewer: "public", agentNull: true)
        XCTAssertNil(document.share)
        XCTAssertNil(document.agent)
        XCTAssertEqual(document.viewer, .public)
    }

    func testDecodesEditingFieldsAndTheForwardedCopyId() throws {
        let edited = try decode(share: "null", viewer: "member", editing: true)
        XCTAssertEqual(edited.revision, 7)
        XCTAssertEqual(edited.viewerCan.edit, true)
        XCTAssertEqual(edited.requestedAttachmentId, "att_copy")
        XCTAssertEqual(edited.attachmentId, "att_example")

        let older = try decode(share: "null", viewer: "member")
        XCTAssertNil(older.revision)
        XCTAssertNil(older.viewerCan.edit)
        XCTAssertNil(older.requestedAttachmentId)
    }

    func testGroupsReactionsAndHidesResolvedThreads() throws {
        var document = try decode(share: "null", viewer: "member")
        XCTAssertEqual(document.reactionSummaries(blockId: "b1"), [
            DocumentReactionSummary(reaction: "👍", count: 2, mine: true),
            DocumentReactionSummary(reaction: "❤️", count: 1, mine: false),
        ])
        XCTAssertEqual(document.openThreads(blockId: "b1").map(\.commentId), ["doccmt_1"])
        XCTAssertTrue(document.openThreads(blockId: "b0").isEmpty)
        XCTAssertEqual(document.replies(to: "doccmt_1").map(\.commentId), ["doccmt_2"])

        document.replaceReactions(blockId: "b1", with: [])
        XCTAssertTrue(document.reactionSummaries(blockId: "b1").isEmpty)
        document.removeComment("doccmt_1")
        XCTAssertEqual(document.comments.map(\.commentId), ["doccmt_3"])
    }

    func testDetectsDocumentAttachments() {
        XCTAssertTrue(DocumentReaderRequest.isDocument(name: "notes.bin", contentType: "text/markdown; charset=utf-8"))
        XCTAssertTrue(DocumentReaderRequest.isDocument(name: "notes", contentType: "text/x-markdown"))
        XCTAssertTrue(DocumentReaderRequest.isDocument(name: "page", contentType: "text/html"))
        XCTAssertTrue(DocumentReaderRequest.isDocument(name: "Review.MD", contentType: nil))
        XCTAssertTrue(DocumentReaderRequest.isDocument(name: "review.markdown", contentType: "application/octet-stream"))
        XCTAssertTrue(DocumentReaderRequest.isDocument(name: "page.html", contentType: nil))
        XCTAssertFalse(DocumentReaderRequest.isDocument(name: "report.pdf", contentType: "application/pdf"))
        XCTAssertFalse(DocumentReaderRequest.isDocument(name: "notes.txt", contentType: "text/plain"))
    }

    func testFormatsKordiIds() {
        XCTAssertEqual(DocumentPeopleCard.formattedKordiId("123456789"), "123 456 789")
        XCTAssertEqual(DocumentPeopleCard.formattedKordiId("12345"), "12345")
    }
}
