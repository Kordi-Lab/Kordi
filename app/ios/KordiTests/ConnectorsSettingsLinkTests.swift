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
}
