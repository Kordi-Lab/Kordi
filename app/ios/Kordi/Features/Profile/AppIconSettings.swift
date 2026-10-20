import OSLog
import UIKit

/// One home screen icon the app can switch to. `white` is the primary icon;
/// every other key names an alternate icon set `AppIcon-<key>`.
struct KordiAppIcon: Identifiable, Equatable, Sendable {
    let key: String
    let displayName: String

    var id: String { key }

    /// Name passed to `setAlternateIconName`, or nil for the primary icon.
    var alternateIconName: String? {
        key == Self.primaryKey ? nil : "AppIcon-\(key)"
    }

    /// Opaque square thumbnail shown in the picker.
    var previewImageName: String { "AppIconPreview-\(key)" }

    static let primaryKey = "white"

    static let all: [KordiAppIcon] = [
        KordiAppIcon(key: "white", displayName: "White"),
        KordiAppIcon(key: "frosted", displayName: "Frosted Glass"),
        KordiAppIcon(key: "rice", displayName: "Rice Paper"),
        KordiAppIcon(key: "coral", displayName: "Coral"),
        KordiAppIcon(key: "sakura", displayName: "Sakura"),
        KordiAppIcon(key: "butter", displayName: "Butter"),
        KordiAppIcon(key: "mint", displayName: "Mint"),
        KordiAppIcon(key: "sky", displayName: "Sky"),
        KordiAppIcon(key: "lavender", displayName: "Lavender"),
        KordiAppIcon(key: "night", displayName: "Night"),
        KordiAppIcon(key: "midnight", displayName: "Midnight"),
        KordiAppIcon(key: "forest", displayName: "Forest"),
        KordiAppIcon(key: "plum", displayName: "Plum"),
        KordiAppIcon(key: "cocoa", displayName: "Cocoa"),
        KordiAppIcon(key: "slate", displayName: "Slate"),
        KordiAppIcon(key: "night-sakura", displayName: "Night Sakura"),
        KordiAppIcon(key: "midnight-sky", displayName: "Midnight Sky"),
    ]

    static let primary = all[0]

    /// Icon for a value of `UIApplication.alternateIconName`; nil or unknown names map to the primary icon.
    static func resolve(alternateIconName: String?) -> KordiAppIcon {
        guard let alternateIconName else { return primary }
        return all.first { $0.alternateIconName == alternateIconName } ?? primary
    }
}

private let appIconLogger = Logger(subsystem: "ai.kordi.ios", category: "AppIcon")

/// Reads and changes the home screen icon.
@MainActor
enum AppIconSettings {
    static var isSupported: Bool { UIApplication.shared.supportsAlternateIcons }

    static var current: KordiAppIcon {
        KordiAppIcon.resolve(alternateIconName: UIApplication.shared.alternateIconName)
    }

    /// Switches the home screen icon. Returns the icon in effect afterwards.
    @discardableResult
    static func select(_ icon: KordiAppIcon) async -> KordiAppIcon {
        let application = UIApplication.shared
        guard application.supportsAlternateIcons,
              application.alternateIconName != icon.alternateIconName else {
            return current
        }
        do {
            try await application.setAlternateIconName(icon.alternateIconName)
        } catch {
            appIconLogger.error("App icon change to \(icon.key, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
        return current
    }
}
