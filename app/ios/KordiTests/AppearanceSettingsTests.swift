import SwiftUI
import XCTest
@testable import Kordi

final class AppearanceSettingsTests: XCTestCase {
    func testSelectionResolvesStoredValuesWithDefaults() {
        XCTAssertEqual(AppearanceSettingsSelection.chatTheme("ocean").label, "Ocean Slate")
        XCTAssertEqual(AppearanceSettingsSelection.chatTheme("unknown"), .quiet)
        XCTAssertEqual(AppearanceSettingsSelection.chatTheme("").label, "Quiet Signal")
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
        XCTAssertEqual(KordiChatTheme.allCases.map(\.label), ["Quiet Signal", "Midnight Violet", "Warm Sand", "Ocean Slate"])
        XCTAssertEqual(MessageLayout.allCases.map(\.title), ["Chat", "Threads"])
        XCTAssertEqual(AppAppearance.allCases.map(\.label), ["System", "Light", "Dark"])

        let identifiers = AppearanceSettingsSelection.optionIdentifiers
        XCTAssertEqual(identifiers.count, 9)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "appearance-option-quiet")
        XCTAssertEqual(identifiers.last, "appearance-option-dark")
    }
}
