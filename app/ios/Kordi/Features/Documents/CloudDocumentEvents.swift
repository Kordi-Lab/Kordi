import Foundation

extension Notification.Name {
    /// Posted for the user sync event `document.updated`. The object is a
    /// `DocumentUpdate`.
    static let kordiDocumentUpdated = Notification.Name("kordi.document.updated")
}

/// A document changed on the server: its content (a save) or its
/// annotations (a reaction or comment).
struct DocumentUpdate: Equatable, Sendable {
    enum Change: String, Sendable {
        case content
        case annotations
    }

    let attachmentId: String
    let revision: Int64?
    let change: Change?

    init?(event: CloudChatEvent) {
        guard event.eventType == "document.updated",
              let attachmentId = event.payload.attachmentId?.nonEmpty ?? event.entityId?.nonEmpty else { return nil }
        self.attachmentId = attachmentId
        revision = event.payload.revision
        change = event.payload.change.flatMap(Change.init(rawValue:))
    }
}

enum CloudDocumentEvents {
    /// Turns a `document.updated` sync event into `kordiDocumentUpdated`.
    /// Other events are ignored.
    static func publish(_ event: CloudChatEvent) {
        guard let update = DocumentUpdate(event: event) else { return }
        Task { @MainActor in
            NotificationCenter.default.post(name: .kordiDocumentUpdated, object: update)
        }
    }
}
