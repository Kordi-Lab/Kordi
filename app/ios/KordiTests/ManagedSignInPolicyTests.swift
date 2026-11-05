import XCTest
@testable import Kordi

final class ManagedSignInPolicyTests: XCTestCase {
    private typealias Membership = CloudAccountOrganizations.Membership
    private typealias Configured = CloudAccountOrganizations.Configured

    func testMissingConfigurationOrKeysRestrictNothing() {
        XCTAssertEqual(ManagedSignInPolicy.parse(nil), .unrestricted)
        XCTAssertEqual(ManagedSignInPolicy.parse([:]), .unrestricted)
        XCTAssertEqual(ManagedSignInPolicy.parse(["unrelated_key": ["google"]]), .unrestricted)
        let policy = ManagedSignInPolicy.parse(nil)
        XCTAssertFalse(policy.isRestricted)
        XCTAssertTrue(ManagedSignInMethod.allCases.allSatisfy(policy.allows))
        XCTAssertTrue(policy.allowsAnyMethod)
        XCTAssertNil(policy.organizationHint)
        XCTAssertNil(policy.signInMethodsHint)
        XCTAssertTrue(policy.authorizeHintFields.isEmpty)
    }

    func testMethodsAreTrimmedLowercasedAndUnknownEntriesIgnored() {
        let policy = ManagedSignInPolicy.parse([
            "allowed_sign_in_methods": [" Google ", "saml", "GITHUB", "google"],
        ])
        XCTAssertEqual(policy.allowedMethods, [.google, .github])
        XCTAssertTrue(policy.allows(.google))
        XCTAssertTrue(policy.allows(.github))
        XCTAssertFalse(policy.allows(.email))
        XCTAssertNil(policy.allowedOrganizations)
        XCTAssertEqual(policy.signInMethodsHint, "google,github")
    }

    func testAKeyWithNoValidEntryAllowsNothing() {
        let invalid: [Any] = [[String](), [" ", ""], "google", 1, ["google", 2] as [Any], ["key": "google"]]
        for value in invalid {
            let policy = ManagedSignInPolicy.parse([
                "allowed_sign_in_methods": value,
                "allowed_organizations": value,
            ])
            XCTAssertEqual(policy.allowedMethods, [], "\(value)")
            XCTAssertEqual(policy.allowedOrganizations, [], "\(value)")
            XCTAssertFalse(policy.allowsAnyMethod, "\(value)")
            XCTAssertNil(policy.signInMethodsHint, "\(value)")
            XCTAssertNil(policy.organizationHint, "\(value)")
            XCTAssertFalse(policy.accountSatisfies(membership(organizations: ["org_test1"])), "\(value)")
        }
    }

    func testUnknownMethodsAloneAllowNothing() {
        let policy = ManagedSignInPolicy.parse(["allowed_sign_in_methods": ["saml", "apple"]])
        XCTAssertEqual(policy.allowedMethods, [])
        XCTAssertFalse(policy.allowsAnyMethod)
        XCTAssertTrue(policy.isRestricted)
    }

    func testOrganizationsAreTrimmedButComparedExactly() {
        let policy = ManagedSignInPolicy.parse([
            "allowed_organizations": [" example-university ", "org_test1", "", "example-university"],
        ])
        XCTAssertEqual(policy.allowedOrganizations, ["example-university", "org_test1"])
        XCTAssertNil(policy.allowedMethods)
        XCTAssertTrue(policy.allowsAnyMethod)
        XCTAssertEqual(policy.organizationHint, "example-university")
        XCTAssertFalse(policy.accountSatisfies(membership(organizations: ["ORG_TEST1"])))
        XCTAssertTrue(policy.accountSatisfies(membership(organizations: ["org_test1"])))
    }

    func testHintsForTheAuthorizeURL() {
        let policy = ManagedSignInPolicy.parse([
            "allowed_sign_in_methods": ["email", "google"],
            "allowed_organizations": ["example-university"],
        ])
        XCTAssertEqual(policy.authorizeHintFields.map(\.0), ["organization_hint", "sign_in_methods"])
        XCTAssertEqual(policy.authorizeHintFields.map(\.1), ["example-university", "email,google"])

        let client = AppSignInClient(
            baseURL: URL(string: "https://cloud.example.test")!,
            clientId: "kordi-ios-beta",
            redirectURI: "kordi-beta://auth/callback",
            transport: { _ in throw URLError(.notConnectedToInternet) }
        )
        let pkce = AppSignInPKCE(verifier: "v", challenge: "challenge", state: "state-1")
        let url = client.authorizeURL(pkce: pkce, intent: .login, hints: policy.authorizeHintFields)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "organization_hint" })?.value, "example-university")
        XCTAssertEqual(items.first(where: { $0.name == "sign_in_methods" })?.value, "email,google")
        XCTAssertTrue(url.absoluteString.hasSuffix("&organization_hint=example-university&sign_in_methods=email%2Cgoogle"))
    }

    func testOAuthStartHintIsDroppedWhenEmpty() {
        XCTAssertEqual(
            CloudAPIClient.oauthStartHintItems(organizationHint: "example-university"),
            [URLQueryItem(name: "organizationHint", value: "example-university")]
        )
        XCTAssertEqual(CloudAPIClient.oauthStartHintItems(organizationHint: nil), [])
        XCTAssertEqual(CloudAPIClient.oauthStartHintItems(organizationHint: "  "), [])
    }

    func testMembershipByServerOrganizationOrConfiguredAdmission() {
        let policy = ManagedSignInPolicy(allowedMethods: nil, allowedOrganizations: ["example-university", "org_test1"])

        XCTAssertTrue(policy.accountSatisfies(membership(organizations: ["org_other", "org_test1"])))
        XCTAssertFalse(policy.accountSatisfies(membership(organizations: ["org_other"])))

        for admission in ["member", "reverify"] {
            XCTAssertTrue(policy.accountSatisfies(membership(configured: [
                Configured(id: "example-university", organizationId: nil, admission: admission),
            ])), admission)
            XCTAssertTrue(policy.accountSatisfies(membership(configured: [
                Configured(id: "example-college", organizationId: "org_test1", admission: admission),
            ])), admission)
        }
        for admission in ["none", "pending", "expired", "Member", nil] as [String?] {
            XCTAssertFalse(policy.accountSatisfies(membership(configured: [
                Configured(id: "example-university", organizationId: "org_test1", admission: admission),
            ])), admission ?? "nil")
        }
        XCTAssertFalse(policy.accountSatisfies(membership(configured: [
            Configured(id: "example-college", organizationId: "org_test2", admission: "member"),
        ])))
        XCTAssertTrue(ManagedSignInPolicy.unrestricted.accountSatisfies(membership()))
        XCTAssertFalse(policy.accountSatisfies(membership()))
    }

    func testOrganizationsResponseDecoding() throws {
        let body = Data("""
        {
          "organizations": [{"organizationId": "org_test1", "name": "Example"}],
          "configured": [{"id": "example-university", "organizationId": null, "admission": "member", "state": "open"}]
        }
        """.utf8)
        let decoded = try JSONDecoder().decode(CloudAccountOrganizations.self, from: body)
        XCTAssertEqual(decoded.organizations, [Membership(organizationId: "org_test1")])
        XCTAssertEqual(decoded.configured, [Configured(id: "example-university", organizationId: nil, admission: "member")])

        let withoutConfigured = try JSONDecoder().decode(CloudAccountOrganizations.self, from: Data(#"{"organizations": []}"#.utf8))
        XCTAssertEqual(withoutConfigured.configured, [])

        // An answer without `organizations` is not "no memberships".
        XCTAssertThrowsError(try JSONDecoder().decode(CloudAccountOrganizations.self, from: Data(#"{"configured": []}"#.utf8)))
    }

    func testOnlyTheBetaAppReadsManagedConfiguration() throws {
        let suite = "ManagedSignInPolicyTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(["allowed_sign_in_methods": ["google"]], forKey: ManagedSignInPolicy.configurationKey)
        XCTAssertEqual(ManagedSignInPolicy.current(bundleIdentifier: "ai.kordi.ios", defaults: defaults), .unrestricted)
        XCTAssertEqual(ManagedSignInPolicy.current(bundleIdentifier: nil, defaults: defaults), .unrestricted)
    }

    func testProvidersMapToTheirMethods() {
        XCTAssertEqual(CloudOAuthProvider.google.managedSignInMethod, .google)
        XCTAssertEqual(CloudOAuthProvider.github.managedSignInMethod, .github)
    }

    private func membership(organizations: [String] = [], configured: [Configured] = []) -> CloudAccountOrganizations {
        CloudAccountOrganizations(organizations: organizations.map(Membership.init(organizationId:)), configured: configured)
    }
}
