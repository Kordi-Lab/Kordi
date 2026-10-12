import XCTest
@testable import Kordi

final class DocumentForwardingTests: XCTestCase {
    private func attachment(_ id: String, _ name: String, _ type: String?) -> ChatAttachment {
        ChatAttachment(attachmentId: id, name: name, kind: .file, mimeType: type, sizeBytes: nil, previewURL: nil)
    }

    func testOnlyDocumentsAreLinkedToTheirSource() {
        let sources = [
            attachment("att_md", "notes.md", "text/markdown"),
            attachment("att_pdf", "report.pdf", "application/pdf"),
            attachment("att_html", "page", "text/html"),
        ]
        let ids = DocumentForwarding.sourceIds(pendingIds: ["p1", "p2", "p3"], sources: sources)
        XCTAssertEqual(ids, ["p1": "att_md", "p3": "att_html"])

        let links = DocumentForwarding.sourceLinks(
            pendingIds: ["p1", "p2", "p3"],
            uploadedIds: ["att_new_md", "att_new_pdf", "att_new_html"],
            sources: ids
        )
        XCTAssertEqual(links, [
            DocumentSourceLink(attachmentId: "att_new_md", sourceAttachmentId: "att_md"),
            DocumentSourceLink(attachmentId: "att_new_html", sourceAttachmentId: "att_html"),
        ])
    }

    func testDraftsThatWereNotForwardedAreNotLinked() {
        XCTAssertTrue(DocumentForwarding.sourceLinks(pendingIds: ["p9"], uploadedIds: ["att_x"], sources: [:]).isEmpty)
        XCTAssertTrue(DocumentForwarding.sourceLinks(pendingIds: ["p1"], uploadedIds: ["att_md"], sources: ["p1": "att_md"]).isEmpty)
    }

    func testSourceRequestBodyShape() throws {
        let data = try JSONEncoder().encode(DocumentSourceLinkRequest(sourceAttachmentId: "att_md"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, ["sourceAttachmentId": "att_md"])
    }

    func testDocumentUpdatedEventBecomesAnUpdate() throws {
        let json = """
        { "stream_seq": 4, "event_id": "evt_1", "protocol_version": 1, "type": "document.updated", "critical": false,
          "conversation_id": null, "entity_id": null, "entity_version": null, "occurred_at": "2026-10-12T09:00:00Z",
          "payload": { "attachmentId": "att_md", "revision": 5, "change": "annotations", "sessionId": "session_example", "updatedByAccountId": "acct_example" } }
        """
        let event = try JSONDecoder().decode(CloudChatEvent.self, from: Data(json.utf8))
        let update = try XCTUnwrap(DocumentUpdate(event: event))
        XCTAssertEqual(update.attachmentId, "att_md")
        XCTAssertEqual(update.revision, 5)
        XCTAssertEqual(update.change, .annotations)

        let other = try JSONDecoder().decode(
            CloudChatEvent.self,
            from: Data(json.replacingOccurrences(of: "document.updated", with: "artifact.upsert").utf8)
        )
        XCTAssertNil(DocumentUpdate(event: other))
    }
}
