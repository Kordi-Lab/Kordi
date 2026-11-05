import XCTest
@testable import Kordi

final class AppSignInClientTests: XCTestCase {
    private let client = AppSignInClient(
        baseURL: URL(string: "https://cloud.example.test/")!,
        clientId: "kordi-ios-beta",
        redirectURI: "kordi-beta://auth/callback"
    )

    func testEachDistributionHasItsOwnIPhoneClient() {
        XCTAssertEqual(AppSignInClient.clientId(forCallbackScheme: "kordi"), "kordi-ios")
        XCTAssertEqual(AppSignInClient.clientId(forCallbackScheme: "kordi-beta"), "kordi-ios-beta")
        XCTAssertEqual(AppSignInClient.clientId(forCallbackScheme: "kordi-staging"), "kordi-ios-staging")
        XCTAssertEqual(AppSignInClient.clientId(forCallbackScheme: "Kordi-Beta"), "kordi-ios-beta")
        XCTAssertEqual(AppSignInClient.clientId(forCallbackScheme: "example"), "example-ios")
        XCTAssertEqual(AppSignInClient.redirectURI(forCallbackScheme: "kordi-beta"), "kordi-beta://auth/callback")
    }

    func testChallengeMatchesTheRFC7636Example() {
        XCTAssertEqual(
            AppSignInPKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
    }

    func testGeneratedValuesAreURLSafeAndFresh() {
        let first = AppSignInPKCE.make()
        let second = AppSignInPKCE.make()
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        XCTAssertEqual(first.verifier.count, 64)
        XCTAssertEqual(first.state.count, 43)
        XCTAssertTrue(first.verifier.unicodeScalars.allSatisfy(allowed.contains))
        XCTAssertTrue(first.state.unicodeScalars.allSatisfy(allowed.contains))
        XCTAssertEqual(first.challenge, AppSignInPKCE.challenge(for: first.verifier))
        XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertNotEqual(first.state, second.state)
    }

    func testAuthorizeURLCarriesTheRequestAndSignUpAddsPromptCreate() throws {
        let pkce = AppSignInPKCE(verifier: "v", challenge: "challenge", state: "state-1")
        let login = client.authorizeURL(pkce: pkce, intent: .login)
        XCTAssertEqual(
            login.absoluteString,
            "https://cloud.example.test/v1/cloud/auth/app/authorize?response_type=code&client_id=kordi-ios-beta"
                + "&redirect_uri=kordi-beta%3A%2F%2Fauth%2Fcallback&code_challenge=challenge"
                + "&code_challenge_method=S256&state=state-1"
        )
        let signup = try XCTUnwrap(URLComponents(url: client.authorizeURL(pkce: pkce, intent: .signup), resolvingAgainstBaseURL: false))
        XCTAssertEqual(signup.queryItems?.first(where: { $0.name == "prompt" })?.value, "create")
        XCTAssertEqual(signup.queryItems?.first(where: { $0.name == "redirect_uri" })?.value, "kordi-beta://auth/callback")
        XCTAssertEqual(client.tokenEndpoint.absoluteString, "https://cloud.example.test/v1/cloud/auth/app/token")
    }

    func testOnlyMissingRoutesAndUnknownClientsMeanUnsupported() {
        func body(_ error: String) -> Data { Data(#"{"error":"\#(error)"}"#.utf8) }
        XCTAssertEqual(AppSignInClient.availability(status: 400, body: body("invalid_redirect_uri")), .available)
        XCTAssertEqual(AppSignInClient.availability(status: 400, body: body("invalid_client")), .unavailable)
        XCTAssertEqual(AppSignInClient.availability(status: 404, body: Data()), .unavailable)
        XCTAssertEqual(AppSignInClient.availability(status: 405, body: Data()), .unavailable)
        XCTAssertEqual(AppSignInClient.availability(status: 429, body: body("rate_limited")), .unknown)
        XCTAssertEqual(AppSignInClient.availability(status: 502, body: Data("<html>".utf8)), .unknown)
        XCTAssertEqual(AppSignInClient.availability(status: 200, body: Data("portal".utf8)), .unknown)
    }

    func testCallbackReturnsTheCodeOnlyForThisAppsState() throws {
        let redirect = "kordi-beta://auth/callback"
        let url = try XCTUnwrap(URL(string: "kordi-beta://auth/callback?code=abc&state=s1"))
        XCTAssertEqual(try AppSignInCallback.code(from: url, redirectURI: redirect, expectedState: "s1"), "abc")

        for rejected in [
            "kordi-beta://auth/callback?code=abc&state=other",
            "kordi-beta://auth/callback?code=abc",
            "kordi-beta://auth/callback?code=abc&state=s1&state=s1",
        ] {
            XCTAssertThrowsError(try AppSignInCallback.code(from: URL(string: rejected)!, redirectURI: redirect, expectedState: "s1")) {
                XCTAssertEqual(($0 as? CloudAPIError)?.code, "sign_in_state_mismatch", rejected)
            }
        }
        for rejected in [
            "kordi-beta://evil/callback?code=abc&state=s1",
            "kordi-beta://auth/other?code=abc&state=s1",
            "kordi://auth/callback?code=abc&state=s1",
            "kordi-beta://auth/callback?state=s1",
            "kordi-beta://auth/callback?code=a&code=b&state=s1",
        ] {
            XCTAssertThrowsError(try AppSignInCallback.code(from: URL(string: rejected)!, redirectURI: redirect, expectedState: "s1"), rejected)
        }
    }

    func testBrowserErrorsAreSurfaced() {
        let redirect = "kordi-beta://auth/callback"
        let denied = URL(string: "kordi-beta://auth/callback?error=access_denied&state=s1")!
        XCTAssertThrowsError(try AppSignInCallback.code(from: denied, redirectURI: redirect, expectedState: "s1")) {
            XCTAssertEqual(($0 as? CloudAPIError)?.code, "access_denied")
        }
        let failed = URL(string: "kordi-beta://auth/callback?error=invalid_request&error_description=Bad%20request&state=s1")!
        XCTAssertThrowsError(try AppSignInCallback.code(from: failed, redirectURI: redirect, expectedState: "s1")) {
            XCTAssertEqual(($0 as? CloudAPIError)?.message, "Bad request")
        }
    }

    func testFormEncodingEscapesEverythingOutsideTheUnreservedSet() {
        XCTAssertEqual(
            AppSignInForm.encode([("a b", "x+y/z=&~._-"), ("é", "kordi://auth")]),
            "a%20b=x%2By%2Fz%3D%26~._-&%C3%A9=kordi%3A%2F%2Fauth"
        )
    }

    func testCredentialRefreshesInsideTheMargin() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let credential = AppSignInCredential(
            accountId: "acct_1",
            clientId: "kordi-ios-beta",
            tokenEndpoint: client.tokenEndpoint,
            accessToken: "kordi_cs_a",
            refreshToken: "kordi_rt_a",
            expiresAt: now.addingTimeInterval(600)
        )
        XCTAssertFalse(credential.expires(within: 300, now: now))
        XCTAssertTrue(credential.expires(within: 300, now: now.addingTimeInterval(301)))
        let decoded = try JSONDecoder().decode(AppSignInCredential.self, from: JSONEncoder().encode(credential))
        XCTAssertEqual(decoded, credential)
    }
}
