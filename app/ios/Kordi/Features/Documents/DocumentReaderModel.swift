import Foundation

/// State and actions for one open document: loading, reactions, comments,
/// and the owner's link.
@MainActor
final class DocumentReaderModel: ObservableObject {
    static let readerKeyDefaultsKey = "kordi.documents.readerKey"
    static let readerNameDefaultsKey = "kordi.documents.readerName"

    let request: DocumentReaderRequest
    private let service: any DocumentService
    private let defaults: UserDefaults

    @Published private(set) var document: DocumentResponse?
    @Published private(set) var htmlData: Data?
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    @Published var actionError: String?
    @Published private(set) var isUpdatingShare = false
    /// A public write waiting for the reader to enter a name.
    @Published var pendingNamedAction: (() -> Void)?
    /// The signed-in account's name, used on public writes before asking for one.
    var accountDisplayName: String?

    init(request: DocumentReaderRequest, service: any DocumentService, defaults: UserDefaults = .standard) {
        self.request = request
        self.service = service
        self.defaults = defaults
    }

    /// The share token when the document was opened through the public route.
    var publicToken: String? {
        guard document?.viewer == .public, case .link(let link) = request.source else { return nil }
        return link.token
    }

    /// The link a person can copy or send: the owner's live share, or the
    /// link this reader was opened from.
    var shareURL: URL? {
        if let share = document?.share, share.revokedAt == nil { return URL(string: share.shareUrl) }
        if case .link(let link) = request.source { return link.shareURL }
        return nil
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            let loaded = try await service.load(request.source)
            document = loaded
            if loaded.format == .html {
                htmlData = try await service.rawContent(loaded)
            }
        } catch is CancellationError {
            return
        } catch let error as CloudAPIError where error.code == "document_link_off" {
            loadError = "This link is off"
        } catch {
            loadError = (error as? CloudAPIError)?.message ?? "Could not open this document."
        }
    }

    // MARK: Reactions and comments

    func toggleReaction(blockId: String, reaction: String) {
        guard let document, document.viewerCan.react else { return }
        runNamed { [weak self] reader in
            guard let self else { return }
            let next = try await self.service.toggleReaction(
                document, publicToken: self.publicToken, blockId: blockId, reaction: reaction, reader: reader
            )
            self.document?.replaceReactions(blockId: blockId, with: next)
        }
    }

    func postComment(blockId: String, body: String, parentCommentId: String? = nil) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let document, document.viewerCan.comment, !text.isEmpty else { return }
        runNamed { [weak self] reader in
            guard let self else { return }
            let comment = try await self.service.postComment(
                document, publicToken: self.publicToken, blockId: blockId, body: text,
                parentCommentId: parentCommentId, reader: reader
            )
            self.document?.upsert(comment)
        }
    }

    func editComment(_ comment: DocumentComment, body: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard comment.mine, !text.isEmpty, text != comment.body else { return }
        perform { [weak self] in
            guard let self else { return }
            self.document?.upsert(try await self.service.updateComment(comment.commentId, body: text, resolved: nil))
        }
    }

    func deleteComment(_ comment: DocumentComment) {
        guard comment.mine else { return }
        perform { [weak self] in
            guard let self else { return }
            try await self.service.deleteComment(comment.commentId)
            self.document?.removeComment(comment.commentId)
        }
    }

    func resolve(_ comment: DocumentComment) {
        guard canResolve(comment) else { return }
        perform { [weak self] in
            guard let self else { return }
            self.document?.upsert(try await self.service.updateComment(comment.commentId, body: nil, resolved: true))
        }
    }

    /// The attachment owner or the comment's author can resolve it.
    func canResolve(_ comment: DocumentComment) -> Bool {
        guard let document, document.viewer != .public else { return false }
        return document.viewer == .owner || comment.mine
    }

    /// A link to one comment, when the document has a link to point at.
    func commentLink(_ comment: DocumentComment) -> URL? {
        guard let shareURL else { return nil }
        return URL(string: "\(shareURL.absoluteString)#\(comment.commentId)")
    }

    // MARK: Share

    var isLinkOn: Bool { document?.share.map { $0.revokedAt == nil } ?? false }

    func setLinkOn(_ on: Bool) {
        guard let document, document.viewerCan.share, on != isLinkOn else { return }
        isUpdatingShare = true
        perform { [weak self] in
            guard let self else { return }
            defer { self.isUpdatingShare = false }
            if on {
                self.document?.share = try await self.service.createShare(
                    attachmentId: document.attachmentId, sessionId: document.sessionId
                )
            } else if let share = document.share {
                try await self.service.deleteShare(share.shareId)
                self.document?.share = nil
            }
        }
    }

    func setReadersCanAskAgent(_ enabled: Bool) {
        guard let share = document?.share, share.readersCanAskAgent != enabled else { return }
        isUpdatingShare = true
        perform { [weak self] in
            guard let self else { return }
            defer { self.isUpdatingShare = false }
            self.document?.share = try await self.service.updateShare(share.shareId, readersCanAskAgent: enabled)
        }
    }

    // MARK: Public reader identity

    var storedReaderName: String? { defaults.string(forKey: Self.readerNameDefaultsKey)?.nonEmpty }

    func saveReaderName(_ name: String) {
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        guard !trimmed.isEmpty else { pendingNamedAction = nil; return }
        defaults.set(trimmed, forKey: Self.readerNameDefaultsKey)
        let action = pendingNamedAction
        pendingNamedAction = nil
        action?()
    }

    private var readerKey: String {
        if let key = defaults.string(forKey: Self.readerKeyDefaultsKey), key.count >= 16 { return key }
        let key = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        defaults.set(key, forKey: Self.readerKeyDefaultsKey)
        return key
    }

    /// Public writes need a reader key and a name; other writes need neither.
    private func runNamed(_ action: @escaping (DocumentReaderIdentity?) async throws -> Void) {
        guard publicToken != nil else {
            perform { try await action(nil) }
            return
        }
        guard let name = storedReaderName ?? accountDisplayName?.nonEmpty else {
            pendingNamedAction = { [weak self] in self?.runNamed(action) }
            return
        }
        let reader = DocumentReaderIdentity(readerKey: readerKey, readerName: name)
        perform { try await action(reader) }
    }

    private func perform(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
            } catch is CancellationError {
                return
            } catch {
                actionError = (error as? CloudAPIError)?.message ?? "Something went wrong. Try again."
            }
        }
    }
}
