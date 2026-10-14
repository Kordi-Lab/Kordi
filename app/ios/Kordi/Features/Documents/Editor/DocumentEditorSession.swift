import Foundation

/// Who is editing, as the room shows them to others.
struct DocumentEditorUser: Equatable {
    let name: String
    let accountId: String
}

/// The app side of the document editor page: answers its requests and
/// carries its collaboration socket through `transport`, and keeps what the
/// toolbar and top bar show.
@MainActor
final class DocumentEditorSession: ObservableObject {
    @Published private(set) var title: String
    @Published private(set) var toolbar = DocumentEditorToolbarState.empty
    @Published private(set) var peers: [DocumentEditorPeer] = []
    /// `connecting`, `connected`, or `offline` for the collaboration room.
    @Published private(set) var roomStatus = "connecting"
    @Published private(set) var isSaving = false
    @Published private(set) var hasPendingSave = false
    @Published private(set) var isFocused = false
    @Published private(set) var isLoaded = false
    @Published var notice: String?
    @Published private(set) var loadError: String?

    let attachmentId: String
    let user: DocumentEditorUser
    /// The page's accent, `#rrggbb`.
    var accentHex = "#2563eb"
    /// Runs JavaScript in the page; set by the web view.
    var evaluate: ((String) -> Void)?
    /// Runs the page's async `close()`; set by the web view.
    var closePage: (() async -> Void)?

    private let transport: any DocumentEditorTransport
    private var sockets: [String: any DocumentEditorSocket] = [:]
    private var readers: [String: Task<Void, Never>] = [:]
    private var sendTails: [String: Task<Void, Never>] = [:]
    private var updateObserver: NSObjectProtocol?

    init(attachmentId: String, title: String, user: DocumentEditorUser, transport: any DocumentEditorTransport) {
        self.attachmentId = attachmentId
        self.title = title
        self.user = user
        self.transport = transport
        updateObserver = NotificationCenter.default.addObserver(
            forName: .kordiDocumentUpdated, object: nil, queue: .main
        ) { [weak self] notification in
            guard let update = notification.object as? DocumentUpdate else { return }
            MainActor.assumeIsolated { self?.forward(update) }
        }
    }

    deinit {
        if let updateObserver { NotificationCenter.default.removeObserver(updateObserver) }
        readers.values.forEach { $0.cancel() }
        sockets.values.forEach { $0.close() }
    }

    func handle(_ message: DocumentEditorMessage) {
        switch message {
        case .ready:
            evaluate?(DocumentEditorScript.call("window.kordiEditor.setAccent", [accentHex]))
            evaluate?(DocumentEditorScript.call("window.kordiEditor.start", [[
                "attachmentId": attachmentId,
                "user": ["name": user.name, "accountId": user.accountId],
            ]]))
        case let .request(id, method, path, body):
            perform(id: id, method: method, path: path, body: body)
        case let .socketOpen(socket, path):
            open(socket: socket, path: path)
        case let .socketSend(socket, data):
            guard let channel = sockets[socket] else { return }
            // Frames keep their order: each send waits for the one before it.
            let previous = sendTails[socket]
            sendTails[socket] = Task {
                await previous?.value
                try? await channel.send(data)
            }
        case .socketClose(let socket):
            drop(socket: socket)
        case let .loaded(title, _):
            if let title = title.nonEmpty { self.title = title }
            isLoaded = true
        case .title(let title):
            if let title = title.nonEmpty { self.title = title }
        case .state(let state):
            toolbar = state
        case let .collab(status, peers):
            roomStatus = status
            self.peers = peers
        case let .save(saving, pending, notice):
            isSaving = saving
            hasPendingSave = pending
            if let notice { self.notice = notice }
        case .notice(let message):
            notice = message
        case .focus(let focused):
            isFocused = focused
        case .error(let message):
            loadError = message
        }
    }

    /// A toolbar button: the same commands as the Mac's selection menu.
    func command(_ name: String, value: String? = nil) {
        evaluate?(DocumentEditorScript.call("window.kordiEditor.command", [name, value]))
    }

    /// Saves pending edits, leaves the room, and waits for those requests.
    func close() async {
        await closePage?()
        readers.values.forEach { $0.cancel() }
        readers.removeAll()
        sendTails.removeAll()
        sockets.values.forEach { $0.close() }
        sockets.removeAll()
    }

    private func forward(_ update: DocumentUpdate) {
        guard update.attachmentId == attachmentId, let revision = update.revision else { return }
        if update.change == .title, let title = update.title?.nonEmpty { self.title = title }
        var payload: [String: Any] = ["attachmentId": attachmentId, "revision": revision]
        if let change = update.change { payload["change"] = change.rawValue }
        evaluate?(DocumentEditorScript.call("window.kordiEditor.documentUpdated", [payload]))
    }

    private func perform(id: String, method: String, path: String, body: String?) {
        guard DocumentEditorRoutes.allowsRequest(method: method, path: path, attachmentId: attachmentId) else {
            evaluate?(DocumentEditorScript.replyError(id: id, message: "This request is not allowed."))
            return
        }
        Task {
            let script: String
            do {
                let response = try await transport.request(method: method, path: path, body: body.map { Data($0.utf8) })
                script = response.status == 0
                    ? DocumentEditorScript.replyError(id: id, message: "Could not reach Kordi Cloud.")
                    : DocumentEditorScript.reply(id: id, status: response.status, body: response.body)
            } catch {
                script = DocumentEditorScript.replyError(id: id, message: (error as? CloudAPIError)?.message ?? "Could not reach Kordi Cloud.")
            }
            evaluate?(script)
        }
    }

    private func open(socket id: String, path: String) {
        guard let target = DocumentEditorRoutes.socketTicket(path: path, attachmentId: attachmentId) else {
            evaluate?(DocumentEditorScript.socket(id, "close", ["code": 4401, "reason": "ticket"]))
            return
        }
        readers[id] = Task { [weak self] in
            guard let channel = try? await self?.transport.socket(path: target.path, ticket: target.ticket) else {
                self?.readers[id] = nil
                self?.evaluate?(DocumentEditorScript.socket(id, "close", ["code": 4401, "reason": "ticket"]))
                return
            }
            guard !Task.isCancelled, let session = self else { return channel.close() }
            session.sockets[id] = channel
            // Sends wait for the handshake, so the page may start its sync step 1 right away.
            session.evaluate?(DocumentEditorScript.socket(id, "open"))
            while !Task.isCancelled {
                do {
                    let data = try await channel.receive()
                    self?.evaluate?(DocumentEditorScript.socket(id, "message", data.base64EncodedString()))
                } catch {
                    break
                }
            }
            guard !Task.isCancelled, let self, self.sockets[id] != nil else { return }
            self.sockets[id] = nil
            self.readers[id] = nil
            self.sendTails[id] = nil
            self.evaluate?(DocumentEditorScript.socket(id, "close", ["code": channel.closeCode, "reason": ""]))
        }
    }

    private func drop(socket id: String) {
        sendTails[id] = nil
        readers.removeValue(forKey: id)?.cancel()
        sockets.removeValue(forKey: id)?.close()
    }
}

extension DocumentEditorSession: Identifiable {}
