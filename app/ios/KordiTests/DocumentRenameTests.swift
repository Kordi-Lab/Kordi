import XCTest
@testable import Kordi

@MainActor
final class DocumentRenameTests: XCTestCase {
    private func document(
        format: DocumentFormat = .markdown,
        viewer: DocumentViewer = .owner,
        edit: Bool? = true,
        blocks: [DocumentBlock] = [DocumentBlock(id: "b0", source: "Notes from the call.", html: "<p>Notes from the call.</p>")],
        title: String = "meeting-notes",
        requestedAttachmentId: String? = nil
    ) -> DocumentResponse {
        DocumentResponse(
            attachmentId: "att_doc",
            title: title,
            fileName: "meeting-notes.md",
            format: format,
            contentType: format == .markdown ? "text/markdown" : "text/html",
            sizeBytes: 120,
            createdAt: "2026-10-12T09:00:00Z",
            updatedAt: "2026-10-12T09:00:00Z",
            sessionId: "session_example",
            sessionTitle: nil,
            author: DocumentAuthor(accountId: "acct_example", displayName: "Alex Morgan", kordiId: "123456789", avatarUrl: nil),
            agent: nil,
            blocks: blocks,
            rawPath: nil,
            reactions: [],
            comments: [],
            share: nil,
            viewer: viewer,
            viewerCan: DocumentViewerCapabilities(share: true, react: true, comment: true, askAgent: false, edit: edit),
            requestedAttachmentId: requestedAttachmentId
        )
    }

    private func event(_ payload: String) throws -> CloudChatEvent {
        let json = """
        { "stream_seq": 9, "event_id": "evt_9", "protocol_version": 1, "type": "document.updated", "critical": false,
          "conversation_id": null, "entity_id": null, "entity_version": null, "occurred_at": "2026-10-12T09:00:00Z",
          "payload": \(payload) }
        """
        return try JSONDecoder().decode(CloudChatEvent.self, from: Data(json.utf8))
    }

    // MARK: Validation

    func testValidTitleTrimsAndCollapsesWhitespace() {
        XCTAssertEqual(DocumentRename.validTitle("  Q4   launch\nplan  "), "Q4 launch plan")
        XCTAssertNil(DocumentRename.validTitle(""))
        XCTAssertNil(DocumentRename.validTitle(" \n\t "))
        XCTAssertEqual(DocumentRename.validTitle(String(repeating: "a", count: 200))?.count, 200)
        XCTAssertNil(DocumentRename.validTitle(String(repeating: "a", count: 201)))
        XCTAssertNil(DocumentRename.validTitle("Plan\u{0007}"))
    }

    func testRenameRequestEncodesTitle() throws {
        let data = try JSONEncoder().encode(DocumentRenameRequest(title: "Launch plan"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, ["title": "Launch plan"])
    }

    // MARK: Availability

    func testRenameNeedsEditPermission() {
        XCTAssertTrue(DocumentRename.isAvailable(for: document()))
        XCTAssertFalse(DocumentRename.isAvailable(for: document(edit: false)))
        XCTAssertFalse(DocumentRename.isAvailable(for: document(edit: nil)))
        XCTAssertFalse(DocumentRename.isAvailable(for: document(viewer: .public)))
    }

    func testRenameIsNotOfferedForHTML() {
        XCTAssertFalse(DocumentRename.isAvailable(for: document(format: .html)))
    }

    func testRenameIsNotOfferedWhenAHeadingIsTheTitle() {
        let atx = DocumentBlock(id: "b0", source: "# Launch plan", html: "<h1>Launch plan</h1>")
        XCTAssertFalse(DocumentRename.isAvailable(for: document(blocks: [atx])))
        let setext = DocumentBlock(id: "b0", source: "Launch plan\n===", html: "")
        XCTAssertFalse(DocumentRename.isAvailable(for: document(blocks: [setext])))
        let second = DocumentBlock(id: "b0", source: "## Agenda", html: "<h2>Agenda</h2>")
        XCTAssertTrue(DocumentRename.isAvailable(for: document(blocks: [second])))
        XCTAssertFalse(DocumentRename.startsWithLevelOneHeading("#hashtag"))
        XCTAssertTrue(DocumentRename.startsWithLevelOneHeading("   # Title"))
        XCTAssertFalse(DocumentRename.startsWithLevelOneHeading("    # Code"))
    }

    // MARK: Title cache

    func testTitleEventUpdatesTheCache() throws {
        let titles = DocumentTitles()
        let update = try XCTUnwrap(DocumentUpdate(event: event(
            #"{ "attachmentId": "att_doc", "revision": 3, "change": "title", "title": "Launch plan" }"#
        )))
        XCTAssertEqual(update.change, .title)
        XCTAssertEqual(update.title, "Launch plan")
        titles.apply(update)
        XCTAssertEqual(titles.title(for: "att_doc"), "Launch plan")

        let annotations = try XCTUnwrap(DocumentUpdate(event: event(
            #"{ "attachmentId": "att_doc", "revision": 3, "change": "annotations" }"#
        )))
        titles.apply(annotations)
        XCTAssertEqual(titles.title(for: "att_doc"), "Launch plan")
    }

    func testCopiesReadTheCanonicalTitle() throws {
        let titles = DocumentTitles()
        titles.record(document(title: "Old", requestedAttachmentId: "att_copy"))
        XCTAssertEqual(titles.title(for: "att_copy"), "Old")
        titles.apply(try XCTUnwrap(DocumentUpdate(event: event(
            #"{ "attachmentId": "att_doc", "change": "title", "title": "New" }"#
        ))))
        XCTAssertEqual(titles.title(for: "att_copy"), "New")
    }

    // MARK: Display names

    func testDisplayNameUsesATitleThatDiffersFromTheFileStem() {
        let titles = DocumentTitles()
        XCTAssertEqual(titles.displayName(attachmentId: "att_doc", fileName: "meeting-notes.md"), "meeting-notes.md")
        titles.record(document(title: "meeting-notes"))
        XCTAssertEqual(titles.displayName(attachmentId: "att_doc", fileName: "meeting-notes.md"), "meeting-notes.md")
        titles.record(document(title: "Launch plan"))
        XCTAssertEqual(titles.displayName(attachmentId: "att_doc", fileName: "meeting-notes.md"), "Launch plan")
        XCTAssertEqual(titles.displayName(attachmentId: nil, fileName: "meeting-notes.md"), "meeting-notes.md")
        XCTAssertEqual(DocumentTitles.fileStem("dir/report v2.final.html"), "report v2.final")
        XCTAssertEqual(DocumentTitles.fileStem(".md"), ".md")
    }

    func testCardsAndPreviewsOnlyRenameDocuments() {
        let titles = DocumentTitles()
        titles.record(document(title: "Launch plan"))
        let markdown = ChatAttachment(attachmentId: "att_doc", name: "meeting-notes.md", kind: .file, mimeType: "text/markdown", sizeBytes: 120, previewURL: nil)
        XCTAssertEqual(titles.displayName(for: markdown), "Launch plan")
        let pdf = ChatAttachment(attachmentId: "att_doc", name: "meeting-notes.pdf", kind: .file, mimeType: "application/pdf", sizeBytes: 120, previewURL: nil)
        XCTAssertEqual(titles.displayName(for: pdf), "meeting-notes.pdf")

        let conversation = ConversationSummary(
            id: "dm:acct_peer", kind: .person, peerAccountId: "acct_peer", agentId: nil, ownerDisplayName: nil,
            displayName: "Priya", lastMessage: "meeting-notes.md", lastAttachment: markdown, lastActivityAt: Date(),
            unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "dm:acct_peer"
        )
        XCTAssertEqual(titles.previewText(conversation.previewText, attachment: conversation.lastAttachment), "Launch plan")
        var withText = conversation
        withText.lastMessage = "See the notes"
        XCTAssertEqual(titles.previewText(withText.previewText, attachment: withText.lastAttachment), "See the notes")
    }

    // MARK: Reader

    func testReaderRenamesOptimisticallyAndRevertsOnFailure() async throws {
        let service = RenameStubService(document: document())
        let titles = DocumentTitles()
        let reader = DocumentReaderModel(request: DocumentReaderRequest(source: .attachment("att_doc"), title: "meeting-notes.md"), service: service, titles: titles)
        await reader.load()
        XCTAssertTrue(reader.canRename)

        service.failure = CloudAPIError(code: "document_edit_forbidden", message: "You can't edit this document.", statusCode: 403)
        XCTAssertTrue(reader.rename(to: "  Launch   plan "))
        XCTAssertEqual(reader.document?.title, "Launch plan")
        XCTAssertEqual(titles.title(for: "att_doc"), "Launch plan")
        try await waitUntil { reader.actionError != nil }
        XCTAssertEqual(reader.document?.title, "meeting-notes")
        XCTAssertEqual(titles.title(for: "att_doc"), "meeting-notes")
        XCTAssertEqual(reader.actionError, "You can't edit this document.")

        reader.actionError = nil
        service.failure = nil
        XCTAssertTrue(reader.rename(to: "Launch plan"))
        try await waitUntil { service.renamedTitles == ["Launch plan", "Launch plan"] }
        XCTAssertEqual(reader.document?.title, "Launch plan")
        XCTAssertNil(reader.actionError)

        XCTAssertFalse(reader.rename(to: "   "))
        XCTAssertEqual(reader.actionError, DocumentRename.invalidTitleMessage)
    }

    func testReaderShowsARenameEvent() async throws {
        let service = RenameStubService(document: document())
        let reader = DocumentReaderModel(request: DocumentReaderRequest(source: .attachment("att_doc"), title: "meeting-notes.md"), service: service, titles: DocumentTitles())
        await reader.load()
        reader.receive(try XCTUnwrap(DocumentUpdate(event: event(
            #"{ "attachmentId": "att_doc", "change": "title", "title": "Launch plan" }"#
        ))))
        XCTAssertEqual(reader.document?.title, "Launch plan")
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<100 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class RenameStubService: DocumentService {
    var document: DocumentResponse
    var failure: Error?
    var renamedTitles: [String] = []

    init(document: DocumentResponse) { self.document = document }

    func load(_ source: DocumentSource) async throws -> DocumentResponse { document }
    func rawContent(_ document: DocumentResponse) async throws -> Data { Data() }

    func rename(attachmentId: String, title: String) async throws -> DocumentResponse {
        renamedTitles.append(title)
        if let failure { throw failure }
        document.title = title
        return document
    }

    func toggleReaction(_ document: DocumentResponse, publicToken: String?, blockId: String, reaction: String, reader: DocumentReaderIdentity?) async throws -> [DocumentReaction] { [] }
    func postComment(_ document: DocumentResponse, publicToken: String?, blockId: String, body: String, parentCommentId: String?, reader: DocumentReaderIdentity?) async throws -> DocumentComment { throw unsupported }
    func updateComment(_ commentId: String, body: String?, resolved: Bool?) async throws -> DocumentComment { throw unsupported }
    func deleteComment(_ commentId: String) async throws {}
    func createShare(attachmentId: String, sessionId: String?) async throws -> DocumentShare { throw unsupported }
    func updateShare(_ shareId: String, readersCanAskAgent: Bool) async throws -> DocumentShare { throw unsupported }
    func deleteShare(_ shareId: String) async throws {}

    private var unsupported: CloudAPIError { CloudAPIError(code: "unsupported", message: "Unsupported.", statusCode: 0) }
}
