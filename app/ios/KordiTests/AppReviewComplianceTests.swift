import XCTest
@testable import Kordi

/// AI consent and account deletion (App Store review fixes).
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
        XCTAssertFalse(AIConsentGate.sharesWithAI(nil))
        XCTAssertFalse(AIConsentGate.sharesWithAI(.declined))
        XCTAssertFalse(AIConsentGate.sharesWithAI(.unset))
    }

    func testServerRefusalIsRecognized() {
        let refusal = CloudAPIError(code: "ai_consent_required", message: "AI is off.", statusCode: 403)
        XCTAssertTrue(AIConsentGate.isConsentRequired(refusal))
        XCTAssertFalse(AIConsentGate.isConsentRequired(CloudAPIError(code: "forbidden", message: "", statusCode: 403)))
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
            #"{"email":{"address":"maya@example.com"},"password":{"set":false},"recentSignIn":false}"#.utf8
        ))
        XCTAssertEqual(AccountDeletionProofMode.from(stale), .emailCode)
        let noEmail = try decoder.decode(CloudAccountSecurityOverview.self, from: Data(
            #"{"email":{"address":null},"password":{"set":false},"recentSignIn":false}"#.utf8
        ))
        XCTAssertEqual(AccountDeletionProofMode.from(noEmail), .signInAgain)
        let missingEmail = try decoder.decode(CloudAccountSecurityOverview.self, from: Data(
            #"{"email":null,"password":{"set":false},"recentSignIn":false}"#.utf8
        ))
        XCTAssertEqual(AccountDeletionProofMode.from(missingEmail), .signInAgain)
    }

    func testRefusedDeleteSwitchesToTheProofTheServerAsks() {
        let reauth = CloudAPIError(code: "reauthentication_required", message: "", statusCode: 403)
        XCTAssertEqual(AccountDeletionProofMode.after(reauth, current: .recentSignIn), .emailCode)
        let password = CloudAPIError(code: "current_password_required", message: "", statusCode: 403)
        XCTAssertEqual(AccountDeletionProofMode.after(password, current: .emailCode), .password(allowsEmailCode: false))
        let noEmail = CloudAPIError(code: "email_missing", message: "", statusCode: 400)
        XCTAssertEqual(AccountDeletionProofMode.after(noEmail, current: .emailCode), .signInAgain)
        XCTAssertEqual(AccountDeletionProofMode.after(reauth, current: .signInAgain), .signInAgain)
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
