import XCTest
@testable import Kordi

final class KordiMarkdownListParserTests: XCTestCase {
    private func listItems(_ markdown: String) -> [[KordiMarkdownListItem]] {
        KordiMarkdownParser.parse(markdown).compactMap { block in
            if case let .list(items) = block { return items }
            return nil
        }
    }

    func testLooseNumberedListStaysOneListAndCountsUp() {
        let lists = listItems("""
        1. **Sign-in and connection status** — **Action:** open the app.

        1. **Conversation switching** — **Action:** switch chats.

        1. **Network interruption recovery** — **Action:** drop the network.
        """)

        XCTAssertEqual(lists.count, 1)
        XCTAssertEqual(lists.first?.map(\.ordinal), [1, 2, 3])
    }

    func testNestedBulletsAndContinuationLinesStayInsideNumberedItems() {
        for nested in ["   ", ""] {
            let lists = listItems([
                "1. **Sign-in and provider status**",
                "\(nested)- **Test:** sign in.",
                "\(nested)- **Expected:** the provider is ready.",
                "1. **Conversation switching**",
                "\(nested)- **Test:** switch chats.",
                "",
                "1. **Network interruption recovery**",
                "   Drop the network.",
                "",
                "   The chat reconnects.",
            ].joined(separator: "\n"))

            XCTAssertEqual(lists.count, 1)
            let items = lists.first ?? []
            XCTAssertEqual(items.filter(\.ordered).map(\.ordinal), [1, 2, 3])
            XCTAssertEqual(items.map(\.depth), [0, 1, 1, 0, 1, 0])
            XCTAssertEqual(items.last?.text, "**Network interruption recovery** Drop the network.\nThe chat reconnects.")
        }
    }

    func testSeparateNumberedListsKeepTheirSourceStart() {
        let lists = listItems("""
        1. First step

        A note between steps.

        2. Second step

        3. Third step
        """)

        XCTAssertEqual(lists.map { $0.map(\.ordinal) }, [[1], [2, 3]])
    }

    func testNestedNumberingRestartsUnderEachParent() {
        let lists = listItems("""
        1. Parent one
           1. Child
           2. Child
        2. Parent two
           1. Child
        """)

        XCTAssertEqual(lists.first?.map(\.ordinal), [1, 1, 2, 2, 1])
    }
}
