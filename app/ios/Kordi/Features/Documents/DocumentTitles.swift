import Foundation
import Observation

/// Titles of shared documents learned this session, by attachment id, so
/// attachment cards, the session Files list, and chat list previews can show
/// a renamed title instead of the file name. Filled from reader loads,
/// `document.updated` title events, and lazy fetches for cards on screen.
/// Nothing is persisted.
@MainActor
@Observable
final class DocumentTitles {
    static let shared = DocumentTitles()

    /// Titles by canonical attachment id.
    private(set) var titles: [String: String] = [:]
    /// Forwarded copy id to the canonical id it reads through.
    private var canonicalIds: [String: String] = [:]

    @ObservationIgnored private var requested: Set<String> = []
    @ObservationIgnored private var queue: [(id: String, load: Loader)] = []
    @ObservationIgnored private var inFlight = 0
    let maxConcurrentLoads: Int

    typealias Loader = @MainActor (String) async throws -> DocumentResponse

    init(maxConcurrentLoads: Int = 2) {
        self.maxConcurrentLoads = maxConcurrentLoads
    }

    func title(for attachmentId: String) -> String? {
        titles[canonicalIds[attachmentId] ?? attachmentId]
    }

    /// Learns the title of a loaded document, and that a forwarded copy
    /// reads through it.
    func record(_ document: DocumentResponse) {
        if let copy = document.requestedAttachmentId?.nonEmpty, copy != document.attachmentId {
            canonicalIds[copy] = document.attachmentId
        }
        set(document.title, for: document.attachmentId)
    }

    /// Applies a rename from `document.updated`; other changes carry no title.
    func apply(_ update: DocumentUpdate) {
        guard update.change == .title, let title = update.title?.nonEmpty else { return }
        set(title, for: canonicalIds[update.attachmentId] ?? update.attachmentId)
    }

    private func set(_ title: String, for attachmentId: String) {
        guard titles[attachmentId] != title else { return }
        titles[attachmentId] = title
    }

    // MARK: Display

    /// The name a card or list shows for an attachment: its known document
    /// title when that differs from the file stem, else the file name.
    func displayName(attachmentId: String?, fileName: String) -> String {
        guard let attachmentId = attachmentId?.nonEmpty, let title = title(for: attachmentId) else { return fileName }
        return Self.displayName(title: title, fileName: fileName)
    }

    func displayName(for attachment: ChatAttachment) -> String {
        guard Self.loadsTitle(attachmentId: attachment.attachmentId, name: attachment.name, contentType: attachment.mimeType) else {
            return attachment.name
        }
        return displayName(attachmentId: attachment.attachmentId, fileName: attachment.name)
    }

    /// A chat list preview: the document title when the last message is a
    /// single document whose file name is the preview.
    func previewText(_ preview: String, attachment: ChatAttachment?) -> String {
        guard let attachment, attachment.kind != .image,
              preview == attachment.name else { return preview }
        return displayName(for: attachment)
    }

    nonisolated static func displayName(title: String, fileName: String) -> String {
        let title = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !title.isEmpty, title != fileStem(fileName) else { return fileName }
        return title
    }

    /// The file name without its extension, as the server derives an
    /// untitled document's title.
    nonisolated static func fileStem(_ fileName: String) -> String {
        let base = fileName.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? fileName
        let stem: String
        if let dot = base.lastIndex(of: "."), dot > base.startIndex {
            stem = String(base[..<dot])
        } else {
            stem = base
        }
        let collapsed = String(stem.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(200))
        return collapsed.isEmpty ? "Document" : collapsed
    }

    /// Cloud Markdown and HTML attachments have a document title; pending
    /// uploads do not yet.
    nonisolated static func loadsTitle(attachmentId: String, name: String, contentType: String?) -> Bool {
        !attachmentId.isEmpty && !attachmentId.hasPrefix("pending:")
            && DocumentReaderRequest.isDocument(name: name, contentType: contentType)
    }

    // MARK: Lazy loads

    /// Fetches the title of a document card on screen, once per session.
    /// At most `maxConcurrentLoads` run at a time; failures are ignored.
    func request(_ attachmentId: String, load: @escaping Loader) {
        guard title(for: attachmentId) == nil, !requested.contains(attachmentId) else { return }
        requested.insert(attachmentId)
        queue.append((attachmentId, load))
        startQueuedLoads()
    }

    /// Drops a queued fetch for a card that left the screen; a fetch already
    /// running finishes.
    func withdraw(_ attachmentId: String) {
        guard let index = queue.firstIndex(where: { $0.id == attachmentId }) else { return }
        queue.remove(at: index)
        requested.remove(attachmentId)
    }

    private func startQueuedLoads() {
        while inFlight < maxConcurrentLoads, !queue.isEmpty {
            let next = queue.removeFirst()
            inFlight += 1
            Task { [weak self] in
                let document = try? await next.load(next.id)
                guard let self else { return }
                self.inFlight -= 1
                if let document { self.record(document) }
                self.startQueuedLoads()
            }
        }
    }
}

/// Who may rename a document on iPhone, and what a valid title is. Mirrors
/// the server: titles are trimmed, whitespace collapsed, 1 to 200
/// characters; a Markdown level-1 heading is the title and wins over a
/// rename, so documents with one are renamed by editing the body.
enum DocumentRename {
    static let maxTitleLength = 200
    static let invalidTitleMessage = "Titles are 1 to 200 characters."

    static func validTitle(_ draft: String) -> String? {
        let collapsed = draft.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !collapsed.isEmpty, collapsed.count <= maxTitleLength,
              !collapsed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return collapsed
    }

    static func isAvailable(for document: DocumentResponse) -> Bool {
        document.viewer != .public
            && document.viewerCan.edit == true
            && document.format == .markdown
            && !hasLevelOneHeading(document)
    }

    /// True when a block is a level-1 heading, which the server takes as
    /// the title.
    static func hasLevelOneHeading(_ document: DocumentResponse) -> Bool {
        document.blocks.contains { block in
            block.html.range(of: "<h1", options: .caseInsensitive) != nil || startsWithLevelOneHeading(block.source)
        }
    }

    /// An ATX `# Title` or setext `Title` over `===` heading at the start of
    /// `source`.
    static func startsWithLevelOneHeading(_ source: String?) -> Bool {
        guard let source else { return false }
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\r")) }
        guard let first = lines.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { return false }
        let indent = first.prefix { $0 == " " }.count
        let text = first.dropFirst(indent)
        if indent <= 3, text.hasPrefix("#") {
            let rest = text.dropFirst()
            if rest.isEmpty || rest.first == " " || rest.first == "\t" { return true }
        }
        guard let index = lines.firstIndex(of: first), index + 1 < lines.count else { return false }
        let underline = lines[index + 1]
        let underlineIndent = underline.prefix { $0 == " " }.count
        let marks = underline.dropFirst(underlineIndent).trimmingCharacters(in: .whitespaces)
        return indent <= 3 && underlineIndent <= 3 && !marks.isEmpty && marks.allSatisfy { $0 == "=" }
    }
}

extension Array where Element == CloudMessageAttachment {
    /// The attachment a chat list row keeps for its preview: the first
    /// image, or a lone document so the row can show its renamed title.
    var chatListPreviewAttachment: CloudMessageAttachment? {
        if let image = first(where: { $0.inferredChatAttachmentKind == .image }) { return image }
        guard count == 1, let only = first,
              DocumentReaderRequest.isDocument(name: only.name, contentType: only.mimeType) else { return nil }
        return only
    }
}
