import XCTest
@testable import Kordi

@MainActor
final class ContactsGroupsSectionTests: XCTestCase {
    func testShowsFirstFiveUntilExpandedOrSearching() {
        let items = Array(1...12)
        XCTAssertEqual(ContactsGroupsSection.visible(items, isExpanded: false, isSearching: false), [1, 2, 3, 4, 5])
        XCTAssertEqual(ContactsGroupsSection.visible(items, isExpanded: true, isSearching: false).count, 12)
        XCTAssertEqual(ContactsGroupsSection.visible(items, isExpanded: false, isSearching: true).count, 12)
        XCTAssertEqual(ContactsGroupsSection.visible([1, 2], isExpanded: false, isSearching: false), [1, 2])
    }

    func testSubtitleCountsPeopleAndOmitsMissingTime() {
        XCTAssertEqual(ContactsGroupsSection.subtitle(peopleCount: 1, lastActivityAt: .distantPast), "1 person")
        XCTAssertEqual(ContactsGroupsSection.subtitle(peopleCount: 3, lastActivityAt: .distantPast), "3 people")
        let now = Date()
        let subtitle = ContactsGroupsSection.subtitle(peopleCount: 3, lastActivityAt: now, now: now)
        XCTAssertEqual(subtitle, "3 people · \(chatListTimestamp(now, now: now))")
    }

    func testInitialTileIsStablePerGroup() {
        let index = GroupInitialTile.paletteIndex(for: "space-1")
        XCTAssertEqual(GroupInitialTile.paletteIndex(for: "space-1"), index)
        XCTAssertTrue(GroupInitialTile.palette.indices.contains(index))
        XCTAssertEqual(GroupInitialTile.initial(of: "agents workshop"), "A")
        XCTAssertEqual(GroupInitialTile.initial(of: "  "), "#")
    }
}
