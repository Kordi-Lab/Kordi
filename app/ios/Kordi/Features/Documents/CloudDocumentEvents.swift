import Foundation

extension Notification.Name {
    /// Posted for the user sync event `document.updated`. The object is a
    /// `DocumentUpdate`.
    static let kordiDocumentUpdated = Notification.Name("kordi.document.updated")
}

/// A document changed on the server: its content (a save), its
/// annotations (a reaction or comment), or its title (a rename).
struct DocumentUpdate: Equatable, Sendable {
    enum Change: String, Sendable {
        case content
        case annotations
        case title
    }

    let attachmentId: String
    let revision: Int64?
    let change: Change?
    /// The new title when `change` is `.title`.
    let title: String?

    init?(event: CloudChatEvent) {
        guard event.eventType == "document.updated",
              let attachmentId = event.payload.attachmentId?.nonEmpty ?? event.entityId?.nonEmpty else { return nil }
        self.attachmentId = attachmentId
        revision = event.payload.revision
        change = event.payload.change.flatMap(Change.init(rawValue:))
        title = event.payload.title
    }
}

enum CloudDocumentEvents {
    /// Turns a `document.updated` sync event into `kordiDocumentUpdated`,
    /// after noting a renamed title. Other events are ignored.
    static func publish(_ event: CloudChatEvent) {
        guard let update = DocumentUpdate(event: event) else { return }
        Task { @MainActor in
            DocumentTitles.shared.apply(update)
            NotificationCenter.default.post(name: .kordiDocumentUpdated, object: update)
        }
    }
}
