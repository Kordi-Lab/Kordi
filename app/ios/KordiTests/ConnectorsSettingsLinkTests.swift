import XCTest
@testable import Kordi

final class ConnectorsSettingsLinkTests: XCTestCase {
    func testParsesTheProviderFromAConnectorsLink() throws {
        let gmail = try XCTUnwrap(URL(string: "kordi://settings/connectors?provider=gmail"))
        XCTAssertEqual(ConnectorsSettingsLink.parse(gmail), ConnectorsSettingsLink(providerID: "gmail"))
        let calendar = try XCTUnwrap(URL(string: "kordi://settings/connectors/?provider=google_calendar"))
        XCTAssertEqual(ConnectorsSettingsLink.parse(calendar)?.providerID, "google_calendar")
    }

    func testUnknownProvidersOpenTheListAndOtherURLsAreIgnored() throws {
        let unknown = try XCTUnwrap(URL(string: "kordi://settings/connectors?provider=outlook"))
        XCTAssertEqual(ConnectorsSettingsLink.parse(unknown), ConnectorsSettingsLink(providerID: nil))
        for value in [
            "https://settings/connectors?provider=gmail",
            "kordi://settings/profile",
            "kordi://settings/connectors-evil",
            "kordi://user:pass@settings/connectors",
            "kordi://callback/connectors",
        ] {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertNil(ConnectorsSettingsLink.parse(url), value)
        }
    }

    func testALinkOpensConnectorsAndTheProviderDetail() throws {
        let gmail = try XCTUnwrap(ConnectorsSettingsLink.parse(XCTUnwrap(URL(string: "kordi://settings/connectors?provider=gmail"))))
        let request = ConnectorsSettingsRequest(link: gmail)
        XCTAssertEqual(request.path, [.connectors])
        XCTAssertEqual(request.providerId, .gmail)

        let calendar = ConnectorsSettingsRequest(link: ConnectorsSettingsLink(providerID: "google_calendar"))
        XCTAssertEqual(calendar.path, [.connectors])
        XCTAssertEqual(calendar.providerId, .googleCalendar)

        let list = try XCTUnwrap(ConnectorsSettingsLink.parse(XCTUnwrap(URL(string: "kordi://settings/connectors?provider=outlook"))))
        XCTAssertEqual(ConnectorsSettingsRequest(link: list).path, [.connectors])
        XCTAssertNil(ConnectorsSettingsRequest(link: list).providerId)
    }

    func testEachOpeningIsANewRequest() {
        let link = ConnectorsSettingsLink(providerID: "slack")
        XCTAssertNotEqual(ConnectorsSettingsRequest(link: link), ConnectorsSettingsRequest(link: link))
    }
}
