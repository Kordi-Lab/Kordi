import Foundation

// MARK: AI data-sharing consent

/// The account's choice about sending its content to AI providers.
enum AIConsentStatus: String, Codable, Hashable {
    case unset
    case allowed
    case declined
}

/// `GET/PUT /v1/cloud/account/ai-consent`, also `aiConsent` in `/v1/cloud/auth/me`.
struct CloudAIConsent: Codable, Hashable {
    let status: AIConsentStatus
    let decidedAt: String?

    init(status: AIConsentStatus, decidedAt: String? = nil) {
        self.status = status
        self.decidedAt = decidedAt
    }

    /// An unknown status from a newer server counts as undecided.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try container.decode(String.self, forKey: .status)
        status = AIConsentStatus(rawValue: raw) ?? .unset
        decidedAt = try container.decodeIfPresent(String.self, forKey: .decidedAt)
    }
}

struct AIConsentUpdateRequest: Encodable, Equatable {
    let status: AIConsentStatus
}

// MARK: Sign in with Apple

/// What Apple returned to the native sign-in sheet. Name and email arrive only
/// on the first authorization for this app.
struct AppleSignInCredential: Equatable {
    let identityToken: String
    let authorizationCode: String
    var givenName: String? = nil
    var familyName: String? = nil
    var email: String? = nil
}

/// `POST /v1/cloud/auth/oauth/apple/native`. `nonce` is the raw value; the
/// server compares its SHA-256 with the token's nonce claim.
struct AppleNativeSignInRequest: Encodable, Equatable {
    let identityToken: String
    let authorizationCode: String
    let nonce: String
    let givenName: String?
    let familyName: String?
    let email: String?
    let device: CloudDeviceRegistration

    init(credential: AppleSignInCredential, nonce: String, device: CloudDeviceRegistration) {
        identityToken = credential.identityToken
        authorizationCode = credential.authorizationCode
        self.nonce = nonce
        givenName = credential.givenName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        familyName = credential.familyName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        email = credential.email?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        self.device = device
    }
}

// MARK: Account deletion

/// The proof body shared by the account security routes: the current password,
/// an emailed code, or nothing when the sign-in is recent.
struct AccountDeletionRequest: Encodable, Equatable {
    var currentPassword: String? = nil
    var verificationId: String? = nil
    var verificationCode: String? = nil
}

/// The parts of `GET /v1/cloud/account/security` the Delete account page needs.
struct CloudAccountSecurityOverview: Decodable, Equatable {
    struct Password: Decodable, Equatable {
        let set: Bool
    }

    struct Email: Decodable, Equatable {
        let address: String?
    }

    let password: Password
    let email: Email?
    let recentSignIn: Bool?
}

private struct AccountReauthenticationCodeRequest: Encodable {}

extension CloudAPIClient {
    func aiConsent(token: String) async throws -> CloudAIConsent {
        try await send(
            path: "/v1/cloud/account/ai-consent",
            method: "GET",
            token: token,
            fallback: "Could not load your AI choice."
        )
    }

    func updateAIConsent(token: String, status: AIConsentStatus) async throws -> CloudAIConsent {
        try await send(
            path: "/v1/cloud/account/ai-consent",
            method: "PUT",
            token: token,
            body: AIConsentUpdateRequest(status: status),
            fallback: "Could not save your AI choice."
        )
    }

    func signInWithApple(_ credential: AppleSignInCredential, nonce: String) async throws -> CloudAuthResponse {
        let device = try await deviceRegistration()
        let response: CloudAuthResponse = try await send(
            path: "/v1/cloud/auth/oauth/apple/native",
            method: "POST",
            body: AppleNativeSignInRequest(credential: credential, nonce: nonce, device: device),
            fallback: "Could not sign in with Apple."
        )
        activateAccount(response.account.accountId)
        return response
    }

    func accountSecurityOverview(token: String) async throws -> CloudAccountSecurityOverview {
        try await send(
            path: "/v1/cloud/account/security",
            method: "GET",
            token: token,
            fallback: "Could not load your account."
        )
    }

    func requestReauthenticationCode(token: String) async throws -> CloudSignupCodeChallenge {
        try await send(
            path: "/v1/cloud/account/security/password/code",
            method: "POST",
            token: token,
            body: AccountReauthenticationCodeRequest(),
            fallback: "Could not send a code."
        )
    }

    func deleteAccount(token: String, proof: AccountDeletionRequest) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/account/security/delete",
            method: "POST",
            token: token,
            body: proof,
            fallback: "Could not delete your account."
        )
    }
}
