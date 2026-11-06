import XCTest
@testable import Kordi

/// AI consent, Sign in with Apple, and account deletion (App Store review fixes).
final class AppReviewComplianceTests: XCTestCase {
    // MARK: AI consent

    func testConsentDecodesEveryStatus() throws {
        let decoder = JSONDecoder()
        let allowed = try decoder.decode(CloudAIConsent.self, from: Data(#"{"status":"allowed","decidedAt":"2026-11-05T10:00:00Z"}"#.utf8))
        XCTAssertEqual(allowed, CloudAIConsent(status: .allowed, decidedAt: "2026-11-05T10:00:00Z"))
        let unset = try decoder.decode(CloudAIConsent.self, from: Data(#"{"status":"unset","decidedAt":null}"#.utf8))
        XCTAssertEqual(unset, CloudAIConsent(status: .unset))
        let declined = try decoder.decode(CloudAIConsent.self, from: Data(#"{"status":"declined"}"#.utf8))
        XCTAssertEqual(declined.status, .declined)
        XCTAssertNil(declined.decidedAt)
    }

    func testUnknownConsentStatusCountsAsUndecided() throws {
        let consent = try JSONDecoder().decode(CloudAIConsent.self, from: Data(#"{"status":"paused","decidedAt":null}"#.utf8))
        XCTAssertEqual(consent.status, .unset)
    }

    func testConsentUpdateEncodesStatusOnly() throws {
        let data = try JSONEncoder().encode(AIConsentUpdateRequest(status: .declined))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"status":"declined"}"#)
    }

    func testGateAsksWhileUndecidedAndExplainsADecline() {
        XCTAssertEqual(AIConsentGate.decision(for: .allowed), .proceed)
        XCTAssertEqual(AIConsentGate.decision(for: .unset), .ask)
        XCTAssertEqual(AIConsentGate.decision(for: .declined), .explainDeclined)
        // Not loaded, or a server without the setting: the server still enforces a decline.
        XCTAssertEqual(AIConsentGate.decision(for: nil), .proceed)
    }

    func testOnlyAgentWorkNeedsConsent() {
        XCTAssertFalse(AIConsentGate.messageRequestsAI(
            isAgentConversation: false, isSubsession: false, mentionsAgent: false, routesToSupportAgent: false
        ))
        XCTAssertTrue(AIConsentGate.messageRequestsAI(
            isAgentConversation: true, isSubsession: false, mentionsAgent: false, routesToSupportAgent: false
        ))
        XCTAssertTrue(AIConsentGate.messageRequestsAI(
            isAgentConversation: false, isSubsession: true, mentionsAgent: false, routesToSupportAgent: false
        ))
        XCTAssertTrue(AIConsentGate.messageRequestsAI(
            isAgentConversation: false, isSubsession: false, mentionsAgent: true, routesToSupportAgent: false
        ))
        XCTAssertTrue(AIConsentGate.messageRequestsAI(
            isAgentConversation: false, isSubsession: false, mentionsAgent: false, routesToSupportAgent: true
        ))
    }

    func testPrivacySwitchReflectsTheChoice() {
        XCTAssertTrue(AIConsentGate.sharesWithAI(.allowed))
        XCTAssertTrue(AIConsentGate.sharesWithAI(nil))
        XCTAssertFalse(AIConsentGate.sharesWithAI(.declined))
        XCTAssertFalse(AIConsentGate.sharesWithAI(.unset))
    }

    func testServerRefusalIsRecognized() {
        let refusal = CloudAPIError(code: "ai_consent_required", message: "AI is off.", statusCode: 403)
        XCTAssertTrue(AIConsentGate.isConsentRequired(refusal))
        XCTAssertFalse(AIConsentGate.isConsentRequired(CloudAPIError(code: "forbidden", message: "", statusCode: 403)))
    }

    // MARK: Sign in with Apple

    func testNonceHashIsLowercaseSHA256Hex() {
        XCTAssertEqual(
            AppleSignInNonce.sha256Hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        XCTAssertEqual(
            AppleSignInNonce.sha256Hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
    }

    func testNonceIsRandomAndURLSafe() {
        let first = AppleSignInNonce.make()
        let second = AppleSignInNonce.make()
        XCTAssertEqual(first.count, 32)
        XCTAssertNotEqual(first, second)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        XCTAssertTrue(first.unicodeScalars.allSatisfy { allowed.contains($0) && $0.isASCII })
    }

    func testAppleNativeRequestSendsRawNonceAndTrimsOptionalName() throws {
        let device = CloudDeviceRegistration(
            displayName: "iPhone", platform: "ios", osVersion: "27.0", appVersion: "0.0.2",
            approximateLocation: "", publicKey: "key", keyAlgorithm: "p256"
        )
        let request = AppleNativeSignInRequest(
            credential: AppleSignInCredential(
                identityToken: "id.token", authorizationCode: "code", givenName: " Maya ", familyName: "", email: nil
            ),
            nonce: "raw-nonce",
            device: device
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(request)) as? [String: Any])
        XCTAssertEqual(json["identityToken"] as? String, "id.token")
        XCTAssertEqual(json["authorizationCode"] as? String, "code")
        XCTAssertEqual(json["nonce"] as? String, "raw-nonce")
        XCTAssertEqual(json["givenName"] as? String, "Maya")
        XCTAssertNil(json["familyName"])
        XCTAssertNil(json["email"])
        XCTAssertEqual((json["device"] as? [String: Any])?["platform"] as? String, "ios")
    }

    // MARK: Account deletion

    func testDeletionRequestEncodesOnlyTheProofGiven() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        XCTAssertEqual(
            String(decoding: try encoder.encode(AccountDeletionRequest(currentPassword: "pw")), as: UTF8.self),
            #"{"currentPassword":"pw"}"#
        )
        XCTAssertEqual(
            String(decoding: try encoder.encode(AccountDeletionRequest(verificationId: "v1", verificationCode: "123456")), as: UTF8.self),
            #"{"verificationCode":"123456","verificationId":"v1"}"#
        )
        XCTAssertEqual(String(decoding: try encoder.encode(AccountDeletionRequest()), as: UTF8.self), "{}")
    }

    func testProofModeFollowsTheSecurityOverview() throws {
        let decoder = JSONDecoder()
        let withPassword = try decoder.decode(CloudAccountSecurityOverview.self, from: Data(
            #"{"email":{"address":"maya@example.com","verified":true},"password":{"set":true,"updatedAt":null},"providers":[],"sessions":[],"canManageOtherSessions":true,"recentSignIn":true}"#.utf8
        ))
        XCTAssertEqual(AccountDeletionProofMode.from(withPassword), .password(allowsEmailCode: false))
        let recent = try decoder.decode(CloudAccountSecurityOverview.self, from: Data(
            #"{"email":{"address":"maya@example.com"},"password":{"set":false},"recentSignIn":true}"#.utf8
        ))
        XCTAssertEqual(AccountDeletionProofMode.from(recent), .recentSignIn)
        let stale = try decoder.decode(CloudAccountSecurityOverview.self, from: Data(
            #"{"email":null,"password":{"set":false},"recentSignIn":false}"#.utf8
        ))
        XCTAssertEqual(AccountDeletionProofMode.from(stale), .emailCode)
    }

    func testRefusedDeleteSwitchesToTheProofTheServerAsks() {
        let reauth = CloudAPIError(code: "reauthentication_required", message: "", statusCode: 403)
        XCTAssertEqual(AccountDeletionProofMode.after(reauth, current: .recentSignIn), .emailCode)
        let password = CloudAPIError(code: "current_password_required", message: "", statusCode: 403)
        XCTAssertEqual(AccountDeletionProofMode.after(password, current: .emailCode), .password(allowsEmailCode: false))
        let wrong = CloudAPIError(code: "invalid_current_password", message: "", statusCode: 403)
        XCTAssertEqual(AccountDeletionProofMode.after(wrong, current: .password(allowsEmailCode: false)), .password(allowsEmailCode: false))
    }

    @MainActor
    func testCleanupRemovesAccountScopedAndGroundingDefaults() {
        let keys = [
            "organization.selected.acct_1",
            "kordi.digest.calendarSync.preferences:acct_1",
            "commonGround.currentProfile.acct_1",
            "commonGround.nearby.device",
            "commonGround.cardDesign.profile_9",
            "kordi.documents.readerKey",
            "kordi.documents.readerName",
            "organization.selected.acct_2",
            "kordi.appearance",
        ]
        XCTAssertEqual(
            AccountDeletionCleanup.defaultsKeysToRemove(allKeys: keys, accountId: "acct_1"),
            [
                "commonGround.cardDesign.profile_9",
                "commonGround.currentProfile.acct_1",
                "commonGround.nearby.device",
                "kordi.digest.calendarSync.preferences:acct_1",
                "kordi.documents.readerKey",
                "kordi.documents.readerName",
                "organization.selected.acct_1",
            ]
        )
        XCTAssertEqual(AccountDeletionCleanup.defaultsKeysToRemove(allKeys: keys, accountId: ""), [])
    }
}
