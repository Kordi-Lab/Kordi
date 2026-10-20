import UIKit
import XCTest
@testable import Kordi

final class AppIconSettingsTests: XCTestCase {
    private let expectedKeys = [
        "white", "frosted", "rice", "coral", "sakura", "butter", "mint", "sky", "lavender",
        "night", "midnight", "forest", "plum", "cocoa", "slate", "night-sakura", "midnight-sky",
    ]

    func testIconsKeepDisplayOrderAndUniqueKeys() {
        XCTAssertEqual(KordiAppIcon.all.map(\.key), expectedKeys)
        XCTAssertEqual(Set(KordiAppIcon.all.map(\.key)).count, KordiAppIcon.all.count)
        XCTAssertEqual(KordiAppIcon.all.map(\.displayName), [
            "White", "Frosted Glass", "Rice Paper", "Coral", "Sakura", "Butter", "Mint", "Sky", "Lavender",
            "Night", "Midnight", "Forest", "Plum", "Cocoa", "Slate", "Night Sakura", "Midnight Sky",
        ])
        XCTAssertEqual(KordiAppIcon.primary.key, "white")
    }

    func testWhiteIsThePrimaryIcon() {
        XCTAssertNil(KordiAppIcon.primary.alternateIconName)
        XCTAssertEqual(KordiAppIcon.primary.previewImageName, "AppIconPreview-white")
    }

    func testOtherIconsMapToAlternateIconSets() {
        for icon in KordiAppIcon.all.dropFirst() {
            XCTAssertEqual(icon.alternateIconName, "AppIcon-\(icon.key)")
            XCTAssertEqual(icon.previewImageName, "AppIconPreview-\(icon.key)")
        }
    }

    func testAlternateIconNameResolvesBackToIcon() {
        XCTAssertEqual(KordiAppIcon.resolve(alternateIconName: nil), .primary)
        XCTAssertEqual(KordiAppIcon.resolve(alternateIconName: "AppIcon-unknown"), .primary)
        XCTAssertEqual(KordiAppIcon.resolve(alternateIconName: "night-sakura"), .primary)
        for icon in KordiAppIcon.all {
            XCTAssertEqual(KordiAppIcon.resolve(alternateIconName: icon.alternateIconName), icon)
        }
    }

    func testPreviewImagesShipInTheAppBundle() {
        for icon in KordiAppIcon.all {
            XCTAssertNotNil(UIImage(named: icon.previewImageName), icon.previewImageName)
        }
    }
}
