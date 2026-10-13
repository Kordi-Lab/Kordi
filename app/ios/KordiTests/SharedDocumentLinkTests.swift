import XCTest
@testable import Kordi

final class SharedDocumentLinkTests: XCTestCase {
    private let token = "kordi_ds_" + String(repeating: "A", count: 21) + "-_" + String(repeating: "z", count: 20)

    func testParsesTheCustomSchemeAndTheBuildScheme() throws {
        let kordi = try XCTUnwrap(URL(string: "kordi://document/\(token)"))
        XCTAssertEqual(SharedDocumentLink.parse(kordi, hostScheme: "kordi-beta"), SharedDocumentLink(token: token))
        let beta = try XCTUnwrap(URL(string: "kordi-beta://document/\(token)"))
        XCTAssertEqual(SharedDocumentLink.parse(beta, hostScheme: "kordi-beta")?.token, token)
        XCTAssertNil(SharedDocumentLink.parse(beta, hostScheme: nil))
    }

    func testParsesTheWebLink() throws {
        let web = try XCTUnwrap(URL(string: "https://kordi.ai/d/\(token)"))
        XCTAssertEqual(SharedDocumentLink.parse(web, hostScheme: nil)?.token, token)
        let trailing = try XCTUnwrap(URL(string: "https://KORDI.ai/d/\(token)/"))
        XCTAssertEqual(SharedDocumentLink.parse(trailing, hostScheme: nil)?.token, token)
        XCTAssertEqual(SharedDocumentLink(token: token).shareURL, web)
    }

    func testRejectsOtherHostsPathsAndSchemes() throws {
        for value in [
            "https://example.com/d/\(token)",
            "https://kordi.ai.example.com/d/\(token)",
            "http://kordi.ai/d/\(token)",
            "https://kordi.ai:8443/d/\(token)",
            "https://kordi.ai/i/\(token)",
            "https://kordi.ai/d/\(token)/raw",
            "https://user@kordi.ai/d/\(token)",
            "https://kordi.ai/d/\(token)?x=1",
            "kordi://settings/\(token)",
            "kordi://document/\(token)/extra",
            "other://document/\(token)",
        ] {
            let url = try XCTUnwrap(URL(string: value), value)
            XCTAssertNil(SharedDocumentLink.parse(url, hostScheme: "kordi-beta"), value)
        }
    }

    func testRejectsMalformedTokens() throws {
        for bad in [
            "kordi_ds_" + String(repeating: "A", count: 42),
            "kordi_ds_" + String(repeating: "A", count: 44),
            "kordi_dx_" + String(repeating: "A", count: 43),
            "kordi_ds_" + String(repeating: "A", count: 42) + "+",
            "kordi_ds_" + String(repeating: "A", count: 42) + ".",
            "",
        ] {
            XCTAssertFalse(SharedDocumentLink.isValidToken(bad), bad)
            if let url = URL(string: "kordi://document/\(bad)") {
                XCTAssertNil(SharedDocumentLink.parse(url, hostScheme: nil), bad)
            }
        }
        XCTAssertTrue(SharedDocumentLink.isValidToken(token))
    }
}
