import XCTest
@testable import Kordi

final class CloudOAuthCallbackTests: XCTestCase {
    func testValidCloudResultDecodesFromNativeCallback() throws {
        let payload = Data(#"{"account":{"accountId":"acct_1","kordiId":"482731906","displayName":"Maya","primaryEmail":"maya@example.com","avatarUrl":null,"nodeId":null,"passwordSet":false},"session":{"token":"session_secret","expiresAt":"2026-09-08T00:00:00Z"}}"#.utf8)
        let encoded = payload.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let callback = try XCTUnwrap(URL(
            string: "\(CloudOAuthCallbackParser.callbackURL.absoluteString)#kordi_cloud_oauth=\(encoded)"
        ))

        let result = try CloudOAuthCallbackParser.parse(callback)

        XCTAssertEqual(result.account.accountId, "acct_1")
        XCTAssertEqual(result.session.token, "session_secret")
    }

    func testCallbackRejectsWrongHostEvenWithValidLookingFragment() {
        let scheme = CloudOAuthCallbackParser.callbackURL.scheme!
        let callback = URL(string: "\(scheme)://attacker/callback#kordi_cloud_oauth=e30")!
        XCTAssertThrowsError(try CloudOAuthCallbackParser.parse(callback))
    }

    func testProviderErrorIsSurfaced() {
        let callback = URL(
            string: "\(CloudOAuthCallbackParser.callbackURL.absoluteString)#kordi_cloud_oauth_error=Access%20denied"
        )!
        XCTAssertThrowsError(try CloudOAuthCallbackParser.parse(callback)) { error in
            XCTAssertEqual(error as? CloudOAuthSessionError, .provider("Access denied"))
        }
    }

    func testProductCallbackRejectsBetaCallback() {
        let callback = URL(string: "kordi-beta://oauth/callback#kordi_cloud_oauth=e30")!
        let productCallback = URL(string: "kordi://oauth/callback")!

        XCTAssertThrowsError(
            try CloudOAuthCallbackParser.parse(callback, expectedCallbackURL: productCallback)
        )
    }
}

final class SignupAvatarRendererTests: XCTestCase {
    func testGeneratedAvatarIsAcceptedWireShape() throws {
        let value = try XCTUnwrap(SignupAvatarRenderer.generatedDataURL(displayName: "Maya Chen", paletteIndex: 1))
        XCTAssertTrue(value.hasPrefix("data:image/png;base64,"))
        XCTAssertLessThan(value.utf8.count, 200_000 * 2)
        XCTAssertEqual(SignupAvatarRenderer.initials(for: "Maya Chen"), "MC")
    }
}
