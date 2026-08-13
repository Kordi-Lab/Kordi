import XCTest
@testable import Kordi

final class KordiAppEnvironmentTests: XCTestCase {
    func testProductionEnvironmentUsesProductIdentity() throws {
        let environment = try KordiAppEnvironment.configured(
            infoDictionary: info(
                channel: "production",
                baseURL: "https://kordi.ai",
                callbackScheme: "kordi"
            ),
            bundleIdentifier: "ai.kordi.ios"
        )

        XCTAssertEqual(environment.channel, .production)
        XCTAssertEqual(environment.cloudBaseURL, URL(string: "https://kordi.ai"))
        XCTAssertEqual(environment.oauthCallbackURL, URL(string: "kordi://oauth/callback"))
        XCTAssertEqual(environment.keychainService, "ai.kordi.ios")
    }

    func testBetaEnvironmentUsesIsolatedIdentity() throws {
        let environment = try KordiAppEnvironment.configured(
            infoDictionary: info(
                channel: "beta",
                baseURL: "http://127.0.0.1:17081",
                callbackScheme: "kordi-beta"
            ),
            bundleIdentifier: "ai.kordi.ios.beta"
        )

        XCTAssertEqual(environment.channel, .beta)
        XCTAssertEqual(environment.cloudBaseURL, URL(string: "http://127.0.0.1:17081"))
        XCTAssertEqual(environment.oauthCallbackURL, URL(string: "kordi-beta://oauth/callback"))
        XCTAssertEqual(environment.keychainService, "ai.kordi.ios.beta")
    }

    func testBetaEnvironmentRejectsProductionOrigin() {
        XCTAssertThrowsError(
            try KordiAppEnvironment.configured(
                infoDictionary: info(
                    channel: "beta",
                    baseURL: "https://kordi.ai",
                    callbackScheme: "kordi-beta"
                ),
                bundleIdentifier: "ai.kordi.ios.beta"
            )
        )
    }

    func testProductionEnvironmentRejectsBetaBundleIdentifier() {
        XCTAssertThrowsError(
            try KordiAppEnvironment.configured(
                infoDictionary: info(
                    channel: "production",
                    baseURL: "https://kordi.ai",
                    callbackScheme: "kordi"
                ),
                bundleIdentifier: "ai.kordi.ios.beta"
            )
        )
    }

    private func info(
        channel: String,
        baseURL: String,
        callbackScheme: String
    ) -> [String: Any] {
        [
            "KordiDistributionChannel": channel,
            "KordiCloudBaseURL": baseURL,
            "KordiOAuthCallbackScheme": callbackScheme
        ]
    }
}
