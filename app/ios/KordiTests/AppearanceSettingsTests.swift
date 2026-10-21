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
}
