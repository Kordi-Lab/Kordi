import SwiftUI
import XCTest
@testable import Kordi

final class AppearanceSettingsTests: XCTestCase {
    func testSelectionResolvesStoredValuesWithDefaults() {
        XCTAssertEqual(AppearanceSettingsSelection.chatTheme("ocean").label, "Ocean Slate")
        XCTAssertEqual(AppearanceSettingsSelection.chatTheme("unknown"), .classic)
        XCTAssertEqual(AppearanceSettingsSelection.chatTheme("").label, "Classic")
        XCTAssertEqual(AppearanceSettingsSelection.messageLayout("threads"), .threads)
        XCTAssertEqual(AppearanceSettingsSelection.messageLayout("unknown"), .chat)
        XCTAssertEqual(AppearanceSettingsSelection.colorMode("dark"), .dark)
        XCTAssertEqual(AppearanceSettingsSelection.colorMode("unknown"), .system)
    }

    func testColorModeMapsToPreferredColorScheme() {
        XCTAssertNil(AppearanceSettingsSelection.preferredColorScheme("system"))
        XCTAssertNil(AppearanceSettingsSelection.preferredColorScheme("unknown"))
        XCTAssertEqual(AppearanceSettingsSelection.preferredColorScheme("light"), .light)
        XCTAssertEqual(AppearanceSettingsSelection.preferredColorScheme("dark"), .dark)
    }

    func testOptionsKeepDisplayOrderAndUniqueIdentifiers() {
        XCTAssertEqual(KordiChatTheme.allCases.map(\.label), ["Classic", "Quiet Signal", "Midnight Violet", "Warm Sand", "Ocean Slate"])
        XCTAssertEqual(MessageLayout.allCases.map(\.title), ["Chat", "Threads"])
        XCTAssertEqual(AppAppearance.allCases.map(\.label), ["System", "Light", "Dark"])

        let identifiers = AppearanceSettingsSelection.optionIdentifiers
        XCTAssertEqual(identifiers.count, 10)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "appearance-option-classic")
        XCTAssertEqual(identifiers.last, "appearance-option-dark")
    }

    func testChatThemeMigrationMovesLegacySelectionToV2() throws {
        func migrated(v1: String?, v2: String? = nil) throws -> (String?, String?) {
            let suite = "kordi.tests.chatTheme.\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            if let v1 { defaults.set(v1, forKey: KordiChatTheme.legacyStorageKey) }
            if let v2 { defaults.set(v2, forKey: KordiChatTheme.storageKey) }
            KordiChatTheme.migrateStoredSelection(in: defaults)
            return (
                defaults.string(forKey: KordiChatTheme.storageKey),
                defaults.string(forKey: KordiChatTheme.legacyStorageKey)
            )
        }

        let quiet = try migrated(v1: "quiet")
        XCTAssertEqual(quiet.0, "classic")
        XCTAssertEqual(quiet.1, "quiet")
        XCTAssertEqual(try migrated(v1: "ocean").0, "ocean")
        XCTAssertEqual(try migrated(v1: "midnight").0, "midnight")
        XCTAssertEqual(try migrated(v1: "nonsense").0, "classic")
        XCTAssertEqual(try migrated(v1: nil).0, "classic")
        XCTAssertEqual(try migrated(v1: "ocean", v2: "quiet").0, "quiet")
    }

    func testSelectedChatThemeAccentCoordinatesTheShell() throws {
        let kordiDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi")
        func source(_ path: String) throws -> String {
            try String(contentsOf: kordiDirectory.appendingPathComponent(path), encoding: .utf8)
        }
        let appSource = try source("App/KordiApp.swift")

        XCTAssertTrue(appSource.contains(".tint(selectedChatTheme.accent)"))
        for path in [
            "App/KordiApp.swift",
            "Features/Chats/ConversationRow.swift",
            "Features/Conversation/PinnedMessageBar.swift",
        ] {
            XCTAssertFalse(try source(path).contains("KordiTheme.signalBlue"), path)
        }
    }

    func testChatThemeAccentsMatchTheMacPalette() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let palette = try String(
            contentsOf: repoRoot.appendingPathComponent("app/desktop/src/styles/theme-palette.css"),
            encoding: .utf8
        )
        let themeSource = try String(
            contentsOf: repoRoot.appendingPathComponent("app/ios/Kordi/Core/Design/KordiTheme.swift"),
            encoding: .utf8
        )

        func hex(_ property: String, in block: String) -> String? {
            guard let range = block.range(of: "\(property): #[0-9A-Fa-f]{6}", options: .regularExpression) else {
                return nil
            }
            return String(block[range].suffix(6)).uppercased()
        }

        // Each palette block names its theme in the selector; the unmarked default is Quiet Signal.
        var macAccents: [String: (light: String, dark: String)] = [:]
        for block in palette.components(separatedBy: "}") {
            guard let light = hex("--app-palette-accent-light", in: block),
                  let dark = hex("--app-palette-accent-dark", in: block) else { continue }
            let marker = "data-kordi-chat-theme='"
            let theme: String
            if let range = block.range(of: "\(marker)[a-z]+'", options: .regularExpression) {
                theme = String(block[range].dropFirst(marker.count).dropLast())
            } else {
                theme = KordiChatTheme.quiet.rawValue
            }
            macAccents[theme] = (light, dark)
        }

        XCTAssertEqual(Set(macAccents.keys), Set(KordiChatTheme.allCases.map(\.rawValue)))
        for theme in KordiChatTheme.allCases {
            let accent = try XCTUnwrap(macAccents[theme.rawValue], theme.rawValue)
            XCTAssertTrue(
                themeSource.contains(
                    "case .\(theme.rawValue): KordiTheme.adaptive(light: 0x\(accent.light), dark: 0x\(accent.dark))"
                ),
                "\(theme.rawValue) accent should be 0x\(accent.light) / 0x\(accent.dark) like the Mac palette"
            )
        }
    }
}
