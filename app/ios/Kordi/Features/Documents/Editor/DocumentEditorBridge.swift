import Foundation

/// The name the editor page posts to (`window.webkit.messageHandlers`).
let documentEditorMessageHandler = "kordiDocumentEditor"

/// Formatting under the caret, as the editor page reports it.
struct DocumentEditorToolbarState: Equatable {
    var formats: Set<String> = []
    /// `text`, `h1`, `h2`, `h3`, or `quote`.
    var block = "text"
    var list = false
    var orderedList = false
    var checklist = false
    var link = false
    var linkHref: String?

    static let empty = DocumentEditorToolbarState()
}

/// Someone else in the document's collaboration room.
struct DocumentEditorPeer: Equatable, Identifiable {
    let name: String
    /// `#rrggbb`, the color of their caret.
    let color: String
    var id: String { "\(name)|\(color)" }
}

/// A message the editor page sends to the app.
enum DocumentEditorMessage: Equatable {
    case ready
    case request(id: String, method: String, path: String, body: String?)
    case socketOpen(socket: String, path: String)
    case socketSend(socket: String, data: Data)
    case socketClose(socket: String)
    case loaded(title: String, canEdit: Bool)
    case title(String)
    case state(DocumentEditorToolbarState)
    case collab(status: String, peers: [DocumentEditorPeer])
    case save(saving: Bool, pending: Bool, notice: String?)
    case notice(String)
    case focus(Bool)
    case error(String)

    init?(body: Any) {
        guard let fields = body as? [String: Any], let type = fields["type"] as? String else { return nil }
        let text = { (key: String) in fields[key] as? String }
        let flag = { (key: String) in fields[key] as? Bool ?? false }
        switch type {
        case "ready":
            self = .ready
        case "request":
            guard let id = text("id"), let method = text("method"), let path = text("path") else { return nil }
            self = .request(id: id, method: method, path: path, body: text("body"))
        case "socket.open":
            guard let socket = text("socket"), let path = text("path") else { return nil }
            self = .socketOpen(socket: socket, path: path)
        case "socket.send":
            guard let socket = text("socket"), let data = text("data").flatMap({ Data(base64Encoded: $0) }) else { return nil }
            self = .socketSend(socket: socket, data: data)
        case "socket.close":
            guard let socket = text("socket") else { return nil }
            self = .socketClose(socket: socket)
        case "loaded":
            self = .loaded(title: text("title") ?? "", canEdit: flag("canEdit"))
        case "title":
            guard let title = text("title") else { return nil }
            self = .title(title)
        case "state":
            self = .state(DocumentEditorToolbarState(
                formats: Set(fields["formats"] as? [String] ?? []),
                block: text("block") ?? "text",
                list: flag("list"),
                orderedList: flag("orderedList"),
                checklist: flag("checklist"),
                link: flag("link"),
                linkHref: text("linkHref")
            ))
        case "collab":
            let peers = (fields["peers"] as? [[String: Any]] ?? []).compactMap { peer -> DocumentEditorPeer? in
                guard let name = (peer["name"] as? String)?.nonEmpty else { return nil }
                return DocumentEditorPeer(name: name, color: peer["color"] as? String ?? "#847ac4")
            }
            self = .collab(status: text("status") ?? "offline", peers: peers)
        case "save":
            self = .save(saving: flag("saving"), pending: flag("pending"), notice: text("notice")?.nonEmpty)
        case "notice":
            guard let message = text("message") else { return nil }
            self = .notice(message)
        case "focus":
            self = .focus(flag("focused"))
        case "error":
            self = .error(text("message") ?? "Could not open this document.")
        default:
            return nil
        }
    }
}

/// The document routes the editor page may reach through the app, for the
/// one document it edits: load, save, and the collaboration room.
enum DocumentEditorRoutes {
    private static let prefix = "/v1/cloud/documents/"
    private static let requests: [String: String] = [
        "": "GET",
        "/content": "PUT",
        "/collab/ticket": "POST",
        "/collab/init": "POST",
    ]

    /// The decoded attachment id and the rest of the path, for `/v1/cloud/documents/<id><rest>`.
    private static func split(_ path: String) -> (id: String, rest: String)? {
        guard path.hasPrefix(prefix), !path.contains("?"), !path.contains("#") else { return nil }
        let tail = path.dropFirst(prefix.count)
        let encodedId = tail.prefix { $0 != "/" }
        guard let id = String(encodedId).removingPercentEncoding?.nonEmpty else { return nil }
        return (id, String(tail.dropFirst(encodedId.count)))
    }

    static func allowsRequest(method: String, path: String, attachmentId: String) -> Bool {
        guard let (id, rest) = split(path), id == attachmentId else { return false }
        return requests[rest] == method.uppercased()
    }

    /// The socket path without its query, when the query is exactly one ticket.
    static func socketTicket(path: String, attachmentId: String) -> (path: String, ticket: String)? {
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        guard parts.count == 2, let (id, rest) = split(parts[0]), id == attachmentId, rest == "/collab",
              let items = URLComponents(string: "?\(parts[1])")?.queryItems, items.count == 1,
              items[0].name == "ticket", let ticket = items[0].value?.nonEmpty else { return nil }
        return (parts[0], ticket)
    }
}

/// JavaScript calls into the editor page, with arguments encoded as JSON.
enum DocumentEditorScript {
    static func call(_ function: String, _ arguments: [Any?]) -> String {
        let encoded = arguments.map { argument -> String in
            guard let argument else { return "null" }
            if let data = try? JSONSerialization.data(withJSONObject: [argument], options: [.fragmentsAllowed]),
               let array = String(data: data, encoding: .utf8) {
                return String(array.dropFirst().dropLast())
            }
            return "null"
        }
        return "\(function)(\(encoded.joined(separator: ",")));"
    }

    static func reply(id: String, status: Int, body: Data) -> String {
        call("window.kordiNative.reply", [id, ["status": status, "body": String(decoding: body, as: UTF8.self)]])
    }

    static func replyError(id: String, message: String) -> String {
        call("window.kordiNative.reply", [id, ["error": message]])
    }

    static func socket(_ id: String, _ kind: String, _ payload: Any? = nil) -> String {
        call("window.kordiNative.socket", [id, kind, payload])
    }
}
