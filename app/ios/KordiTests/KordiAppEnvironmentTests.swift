import XCTest
@testable import Kordi

final class KordiAppEnvironmentTests: XCTestCase {
    func testChatThemesHaveStablePersistedIdentifiers() {
        XCTAssertEqual(KordiChatTheme.storageKey, "kordi.chatTheme.v2")
        XCTAssertEqual(KordiChatTheme.legacyStorageKey, "kordi.chatTheme.v1")
        XCTAssertEqual(
            KordiChatTheme.allCases.map(\.rawValue),
            ["classic", "quiet", "midnight", "sand", "ocean"]
        )
        XCTAssertEqual(KordiChatTheme.ownMetadataOpacity, 0.88)
        XCTAssertEqual(KordiChatTheme.otherMetadataOpacity, 0.68)
    }

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

    func testBetaEnvironmentAcceptsATaskOwnedLoopbackPort() throws {
        let environment = try KordiAppEnvironment.configured(
            infoDictionary: info(
                channel: "beta",
                baseURL: "http://127.0.0.1:60039",
                callbackScheme: "kordi-beta"
            ),
            bundleIdentifier: "ai.kordi.ios.beta"
        )

        XCTAssertEqual(environment.cloudBaseURL, URL(string: "http://127.0.0.1:60039"))
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

    func testResearchRejectsAppRoutingAndStorage() throws {
        let settings = info(channel: "research", baseURL: "https://research.example.test", callbackScheme: "kordi-research")
        let environment = try KordiAppEnvironment.configured(infoDictionary: settings, bundleIdentifier: "ai.kordi.ios.research")
        XCTAssertEqual(environment.channel, .research)
        XCTAssertEqual(environment.keychainService, "ai.kordi.ios.research")
        XCTAssertThrowsError(try KordiAppEnvironment.configured(infoDictionary: settings, bundleIdentifier: "ai.kordi.ios"))
        var wrong = settings
        wrong["KordiCloudBaseURL"] = "https://kordi.ai"
        XCTAssertThrowsError(try KordiAppEnvironment.configured(infoDictionary: wrong, bundleIdentifier: "ai.kordi.ios.research"))
        wrong = settings
        wrong.removeValue(forKey: "KordiExpectedDistribution")
        XCTAssertThrowsError(try KordiAppEnvironment.configured(infoDictionary: wrong, bundleIdentifier: "ai.kordi.ios.research"))
    }

    private func info(
        channel: String,
        baseURL: String,
        callbackScheme: String
    ) -> [String: Any] {
        [
            "KordiExpectedDistribution": DistributionTestFixture.encoded(research: channel == "research"),
            "KordiDistributionChannel": channel,
            "KordiCloudBaseURL": baseURL,
            "KordiOAuthCallbackScheme": callbackScheme
        ]
    }
}
