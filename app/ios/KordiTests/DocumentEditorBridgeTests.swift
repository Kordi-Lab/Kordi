import XCTest
@testable import Kordi

@MainActor
final class DocumentEditorBridgeTests: XCTestCase {
    private let attachmentId = "att_doc"

    // MARK: Messages from the page

    func testParsesRequestsSocketsAndToolbarState() {
        XCTAssertEqual(DocumentEditorMessage(body: ["type": "ready"]), .ready)
        XCTAssertEqual(
            DocumentEditorMessage(body: ["type": "request", "id": "r1", "method": "PUT", "path": "/v1/cloud/documents/att_doc/content", "body": "{}"]),
            .request(id: "r1", method: "PUT", path: "/v1/cloud/documents/att_doc/content", body: "{}")
        )
        XCTAssertEqual(
            DocumentEditorMessage(body: ["type": "socket.send", "socket": "s1", "data": Data([0, 1, 255]).base64EncodedString()]),
            .socketSend(socket: "s1", data: Data([0, 1, 255]))
        )
        XCTAssertEqual(
            DocumentEditorMessage(body: ["type": "state", "formats": ["bold", "italic"], "block": "h2", "list": true, "link": false]),
            .state(DocumentEditorToolbarState(formats: ["bold", "italic"], block: "h2", list: true))
        )
        XCTAssertEqual(
            DocumentEditorMessage(body: ["type": "collab", "status": "connected", "peers": [["name": "Alex", "color": "#2563eb"], ["name": ""]]]),
            .collab(status: "connected", peers: [DocumentEditorPeer(name: "Alex", color: "#2563eb")])
        )
        XCTAssertNil(DocumentEditorMessage(body: ["type": "request", "id": "r1"]))
        XCTAssertNil(DocumentEditorMessage(body: ["type": "socket.send", "socket": "s1", "data": "%%%"]))
        XCTAssertNil(DocumentEditorMessage(body: ["type": "navigate"]))
        XCTAssertNil(DocumentEditorMessage(body: "ready"))
    }

    // MARK: Routes the page may reach

    func testRequestsAreLimitedToThisDocumentsEditorRoutes() {
        let allowed = [
            ("GET", "/v1/cloud/documents/att_doc"),
            ("PUT", "/v1/cloud/documents/att_doc/content"),
            ("POST", "/v1/cloud/documents/att_doc/collab/ticket"),
            ("POST", "/v1/cloud/documents/att_doc/collab/init"),
        ]
        for (method, path) in allowed {
            XCTAssertTrue(DocumentEditorRoutes.allowsRequest(method: method, path: path, attachmentId: attachmentId), path)
        }
        let refused = [
            ("GET", "/v1/cloud/documents/att_other"),
            ("DELETE", "/v1/cloud/documents/att_doc"),
            ("PATCH", "/v1/cloud/documents/att_doc"),
            ("POST", "/v1/cloud/documents/att_doc/shares"),
            ("POST", "/v1/cloud/documents/att_doc/comments"),
            ("GET", "/v1/cloud/documents/att_doc?x=1"),
            ("GET", "/v1/cloud/documents/att_doc%2F..%2Fshares"),
            ("GET", "/v2/chat/bootstrap"),
            ("GET", "https://example.com/v1/cloud/documents/att_doc"),
        ]
        for (method, path) in refused {
            XCTAssertFalse(DocumentEditorRoutes.allowsRequest(method: method, path: path, attachmentId: attachmentId), path)
        }
    }

    func testSocketPathsCarryExactlyOneTicketForThisDocument() throws {
        let target = try XCTUnwrap(DocumentEditorRoutes.socketTicket(path: "/v1/cloud/documents/att_doc/collab?ticket=dct_abc", attachmentId: attachmentId))
        XCTAssertEqual(target.path, "/v1/cloud/documents/att_doc/collab")
        XCTAssertEqual(target.ticket, "dct_abc")
        XCTAssertNil(DocumentEditorRoutes.socketTicket(path: "/v1/cloud/documents/att_doc/collab", attachmentId: attachmentId))
        XCTAssertNil(DocumentEditorRoutes.socketTicket(path: "/v1/cloud/documents/att_other/collab?ticket=t", attachmentId: attachmentId))
        XCTAssertNil(DocumentEditorRoutes.socketTicket(path: "/v1/cloud/documents/att_doc/collab?ticket=t&token=x", attachmentId: attachmentId))
        XCTAssertNil(DocumentEditorRoutes.socketTicket(path: "/v2/chat/realtime?ticket=t", attachmentId: attachmentId))
    }

    // MARK: Calls into the page

    func testScriptArgumentsAreJSONEncoded() throws {
        let script = DocumentEditorScript.call("window.kordiEditor.command", ["link", "https://example.com/a\"b\n</script>"])
        XCTAssertTrue(script.hasPrefix("window.kordiEditor.command(\"link\","))
        XCTAssertTrue(script.contains(#"a\"b\n"#))
        XCTAssertFalse(script.contains("\n"))
        XCTAssertEqual(DocumentEditorScript.call("f", [nil]), "f(null);")
        let reply = DocumentEditorScript.reply(id: "r1", status: 409, body: Data(#"{"title":"Plan"}"#.utf8))
        let json = try XCTUnwrap(reply.dropFirst("window.kordiNative.reply(\"r1\",".count).dropLast(2).data(using: .utf8))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        XCTAssertEqual(object["status"] as? Int, 409)
        XCTAssertEqual(object["body"] as? String, #"{"title":"Plan"}"#)
    }

    func testOnlyEditorsOfMarkdownDocumentsGetTheEditor() {
        XCTAssertTrue(DocumentEditing.isAvailable(for: document()))
        XCTAssertFalse(DocumentEditing.isAvailable(for: document(edit: false)))
        XCTAssertFalse(DocumentEditing.isAvailable(for: document(edit: nil)))
        XCTAssertFalse(DocumentEditing.isAvailable(for: document(viewer: .public)))
        XCTAssertFalse(DocumentEditing.isAvailable(for: document(format: .html)))
    }

    // MARK: Session

    func testReadyStartsThePageWithTheDocumentAndViewerButNoToken() {
        let (session, scripts, _) = makeSession()
        session.accentHex = "#847ac4"
        session.handle(.ready)
        XCTAssertEqual(scripts.values.count, 2)
        XCTAssertTrue(scripts.values[0].contains("setAccent(\"#847ac4\")"))
        XCTAssertTrue(scripts.values[1].hasPrefix("window.kordiEditor.start("))
        XCTAssertTrue(scripts.values[1].contains("att_doc"))
        XCTAssertTrue(scripts.values[1].contains("acct_priya"))
        XCTAssertFalse(scripts.values.joined().contains("secret_token"))
    }

    func testRequestsGoThroughTheTransportAndRefusedOnesNeverLeave() async throws {
        let (session, scripts, transport) = makeSession()
        transport.responses["/v1/cloud/documents/att_doc/content"] = (409, Data(#"{"attachmentId":"att_doc"}"#.utf8))
        session.handle(.request(id: "r1", method: "PUT", path: "/v1/cloud/documents/att_doc/content", body: #"{"source":"Hi"}"#))
        session.handle(.request(id: "r2", method: "POST", path: "/v1/cloud/documents/att_doc/shares", body: "{}"))
        try await waitUntil { scripts.values.count == 2 }
        XCTAssertEqual(transport.requests.map(\.path), ["/v1/cloud/documents/att_doc/content"])
        XCTAssertEqual(transport.requests.first?.body, Data(#"{"source":"Hi"}"#.utf8))
        XCTAssertTrue(scripts.values.contains { $0.hasPrefix("window.kordiNative.reply(\"r2\"") && $0.contains("not allowed") })
        XCTAssertTrue(scripts.values.contains { $0.hasPrefix("window.kordiNative.reply(\"r1\"") && $0.contains("409") })
    }

    func testSocketFramesFlowBothWaysInOrderAndCloseIsReported() async throws {
        let (session, scripts, transport) = makeSession()
        session.handle(.socketOpen(socket: "s1", path: "/v1/cloud/documents/att_doc/collab?ticket=dct_1"))
        try await waitUntil { scripts.values.contains(DocumentEditorScript.socket("s1", "open")) }
        XCTAssertEqual(transport.openedTickets, ["dct_1"])
        let socket = try XCTUnwrap(transport.sockets.first)
        for byte in UInt8(0)..<20 { session.handle(.socketSend(socket: "s1", data: Data([byte]))) }
        try await waitUntil { socket.sent.count == 20 }
        XCTAssertEqual(socket.sent, (UInt8(0)..<20).map { Data([$0]) })
        socket.deliver(Data([7, 8]))
        try await waitUntil { scripts.values.contains(DocumentEditorScript.socket("s1", "message", Data([7, 8]).base64EncodedString())) }
        socket.finish(code: 4403)
        try await waitUntil { scripts.values.contains { $0.hasPrefix("window.kordiNative.socket(\"s1\",\"close\"") && $0.contains("4403") } }
    }

    func testSocketWithoutATicketClosesAtOnce() {
        let (session, scripts, transport) = makeSession()
        session.handle(.socketOpen(socket: "s1", path: "/v1/cloud/documents/att_doc/collab"))
        XCTAssertTrue(transport.openedTickets.isEmpty)
        XCTAssertTrue(scripts.values.last?.contains("4401") == true)
    }

    func testDocumentUpdatesReachThePageAndPageStateReachesTheToolbar() throws {
        let (session, scripts, _) = makeSession()
        let event = try JSONDecoder().decode(CloudChatEvent.self, from: Data("""
        { "stream_seq": 9, "event_id": "evt_9", "protocol_version": 1, "type": "document.updated", "critical": false,
          "conversation_id": null, "entity_id": null, "entity_version": null, "occurred_at": "2026-10-12T09:00:00Z",
          "payload": { "attachmentId": "att_doc", "revision": 5, "change": "content" } }
        """.utf8))
        NotificationCenter.default.post(name: .kordiDocumentUpdated, object: try XCTUnwrap(DocumentUpdate(event: event)))
        XCTAssertTrue(scripts.values.last?.hasPrefix("window.kordiEditor.documentUpdated(") == true)
        XCTAssertTrue(scripts.values.last?.contains("\"revision\":5") == true)

        session.handle(.state(DocumentEditorToolbarState(formats: ["bold"], block: "h1")))
        session.handle(.collab(status: "connected", peers: [DocumentEditorPeer(name: "Alex", color: "#2563eb")]))
        session.handle(.loaded(title: "Launch plan", canEdit: true))
        session.handle(.save(saving: false, pending: true, notice: "Updated elsewhere"))
        XCTAssertEqual(session.toolbar.formats, ["bold"])
        XCTAssertEqual(session.roomStatus, "connected")
        XCTAssertEqual(session.peers.map(\.name), ["Alex"])
        XCTAssertEqual(session.title, "Launch plan")
        XCTAssertTrue(session.isLoaded)
        XCTAssertTrue(session.hasPendingSave)
        XCTAssertEqual(session.notice, "Updated elsewhere")
        session.command("block", value: "h2")
        XCTAssertEqual(scripts.values.last, #"window.kordiEditor.command("block","h2");"#)
    }

    func testPreviewTransportSavesInMemoryAndRefusesTheRoom() async throws {
        let transport = PreviewDocumentEditorTransport(document: document())
        let ticket = try await transport.request(method: "POST", path: "/v1/cloud/documents/att_doc/collab/ticket", body: Data("{}".utf8))
        XCTAssertEqual(ticket.status, 403)
        let saved = try await transport.request(method: "PUT", path: "/v1/cloud/documents/att_doc/content", body: Data(##"{"source":"# Plan","baseRevision":1}"##.utf8))
        XCTAssertEqual(saved.status, 200)
        XCTAssertEqual(transport.savedSources, ["# Plan"])
        XCTAssertEqual(try JSONDecoder().decode(DocumentResponse.self, from: saved.body).revision, 2)
    }

    // MARK: Helpers

    private final class Scripts { var values: [String] = [] }

    private func makeSession() -> (DocumentEditorSession, Scripts, StubTransport) {
        let transport = StubTransport()
        let session = DocumentEditorSession(
            attachmentId: attachmentId, title: "Plan",
            user: DocumentEditorUser(name: "Priya", accountId: "acct_priya"),
            transport: transport
        )
        let scripts = Scripts()
        session.evaluate = { scripts.values.append($0) }
        return (session, scripts, transport)
    }

    private func document(format: DocumentFormat = .markdown, viewer: DocumentViewer = .member, edit: Bool? = true) -> DocumentResponse {
        DocumentResponse(
            attachmentId: attachmentId, title: "Plan", fileName: "plan.md", format: format,
            contentType: "text/markdown", sizeBytes: 12, createdAt: "2026-10-12T09:00:00Z", updatedAt: "2026-10-12T09:00:00Z",
            sessionId: nil, sessionTitle: nil,
            author: DocumentAuthor(accountId: "acct_alex", displayName: "Alex", kordiId: "123456789", avatarUrl: nil),
            agent: nil, blocks: [DocumentBlock(id: "b0", source: "Hello", html: "<p>Hello</p>")], rawPath: nil,
            reactions: [], comments: [], share: nil, viewer: viewer,
            viewerCan: DocumentViewerCapabilities(share: false, react: true, comment: true, askAgent: false, edit: edit),
            revision: 1
        )
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class StubTransport: DocumentEditorTransport {
    var responses: [String: (Int, Data)] = [:]
    var requests: [(method: String, path: String, body: Data?)] = []
    var openedTickets: [String] = []
    var sockets: [StubSocket] = []

    func request(method: String, path: String, body: Data?) async throws -> (status: Int, body: Data) {
        requests.append((method, path, body))
        let response = responses[path] ?? (200, Data("{}".utf8))
        return (response.0, response.1)
    }

    func socket(path: String, ticket: String) async throws -> any DocumentEditorSocket {
        openedTickets.append(ticket)
        let socket = StubSocket()
        sockets.append(socket)
        return socket
    }
}

private final class StubSocket: DocumentEditorSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var _sent: [Data] = []
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var iterator: AsyncThrowingStream<Data, Error>.AsyncIterator
    private(set) var closeCode = 1006

    init() {
        var captured: AsyncThrowingStream<Data, Error>.Continuation?
        let stream = AsyncThrowingStream<Data, Error> { captured = $0 }
        continuation = captured
        iterator = stream.makeAsyncIterator()
    }

    var sent: [Data] { lock.withLock { _sent } }

    func send(_ data: Data) async throws {
        // A short, varying delay: frames still have to arrive in order.
        try await Task.sleep(for: .milliseconds(Int.random(in: 0...3)))
        lock.withLock { _sent.append(data) }
    }

    func receive() async throws -> Data {
        guard let next = try await iterator.next() else { throw URLError(.networkConnectionLost) }
        return next
    }

    func deliver(_ data: Data) { continuation?.yield(data) }

    func finish(code: Int) {
        closeCode = code
        continuation?.finish()
    }

    func close() { continuation?.finish() }
}
