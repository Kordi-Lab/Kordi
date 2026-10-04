import Foundation

enum MessageLayout: String, CaseIterable, Identifiable {
    case chat
    case threads

    static let storageKey = "kordi.messageLayout.v1"
    var id: String { rawValue }
    var title: String { self == .chat ? "Chat" : "Threads" }

    static func resolve(_ rawValue: String) -> Self {
        Self(rawValue: rawValue) ?? .chat
    }
}
