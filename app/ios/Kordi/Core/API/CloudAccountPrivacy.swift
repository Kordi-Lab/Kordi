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
