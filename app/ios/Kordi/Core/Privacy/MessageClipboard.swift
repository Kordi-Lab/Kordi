import Foundation
import UIKit
import UniformTypeIdentifiers

/// Copies message text. With "Limit copied messages" on (the default), the
/// text stays on this device (no Universal Clipboard) and expires after ten
/// minutes. With it off, copying behaves like a plain pasteboard string.
enum MessageClipboard {
    static let storageKey = "kordi.privacy.limitCopiedMessages"
    static let expiration: TimeInterval = 600

    struct Payload {
        let items: [[String: Any]]
        let options: [UIPasteboard.OptionsKey: Any]
    }

    static func limitsCopies(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: storageKey) as? Bool ?? true
    }

    static func payload(for text: String, limitsCopies: Bool, now: Date = Date()) -> Payload {
        Payload(
            items: [[UTType.utf8PlainText.identifier: text]],
            options: limitsCopies
                ? [.localOnly: true, .expirationDate: now.addingTimeInterval(expiration)]
                : [:]
        )
    }

    @MainActor
    static func copy(
        _ text: String,
        pasteboard: UIPasteboard = .general,
        defaults: UserDefaults = .standard,
        now: Date = Date()
    ) {
        guard limitsCopies(defaults: defaults) else {
            pasteboard.string = text
            return
        }
        let payload = payload(for: text, limitsCopies: true, now: now)
        pasteboard.setItems(payload.items, options: payload.options)
    }
}
