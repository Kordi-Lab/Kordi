import Foundation

/// An organization the signed-in account belongs to. Every account has one
/// personal organization; team organizations are shared with other members.
/// Switching organization never switches the account or its local data.
struct CloudOrganization: Codable, Hashable, Identifiable {
    enum Kind: String {
        case personal
        case team
    }

    enum Role: String {
        case owner
        case admin
        case member
    }

    let organizationId: String
    let name: String
    let kind: String
    let role: String
    var memberCount: Int? = nil
    var createdAt: String? = nil
    var memberOwnedContent: Bool? = nil
    var membershipExpiresAt: String? = nil

    var id: String { organizationId }
    var isPersonal: Bool { kind == Kind.personal.rawValue }
    var roleKind: Role? { Role(rawValue: role) }
}

struct CloudOrganizationsResponse: Decodable {
    let organizations: [CloudOrganization]
}

/// The team organization a conversation snapshot belongs to. The server sends
/// it only for team organizations, so a missing value means personal.
struct CloudConversationOrganization: Codable, Hashable {
    let organizationId: String
    let name: String

    enum CodingKeys: String, CodingKey {
        case organizationId = "organization_id"
        case name
    }
}

enum GroupOrganizationCatalog {
    /// The team organization name of any channel in the group space, or nil.
    static func name(groupSpaceId: String, canonical: [CloudChatConversation]) -> String? {
        let spaceId = normalizedGroupSpaceId(groupSpaceId)
        return canonical.first {
            $0.kind == "group" && $0.organization?.name.nonEmpty != nil
                && normalizedGroupSpaceId($0.groupSpaceId ?? $0.legacySessionId ?? $0.id) == spaceId
        }?.organization?.name.nonEmpty
    }
}

struct ChatCreateConversationRequest: Encodable {
    let clientOperationId: String
    let kind: String
    let sharedTitle: String?
    let clientSessionId: String
    let memberAccountIds: [String]
    /// Omitted for the personal organization and for direct conversations.
    var organizationId: String? = nil

    enum CodingKeys: String, CodingKey {
        case clientOperationId = "client_operation_id"
        case kind
        case sharedTitle = "shared_title"
        case clientSessionId = "client_session_id"
        case memberAccountIds = "member_account_ids"
        case organizationId = "organization_id"
    }
}

extension CloudAPIClient {
    func listOrganizations(token: String) async throws -> [CloudOrganization] {
        let response: CloudOrganizationsResponse = try await send(
            path: "/v1/cloud/organizations",
            method: "GET",
            token: token,
            fallback: "Could not load organizations."
        )
        return response.organizations
    }

    /// Sets the team organization new group and AI conversations and new
    /// agents belong to; nil means the personal organization.
    func selectOrganizationForNewConversations(accountId: String, organizationId: String?) {
        newConversationOrganization = organizationId.nonEmpty.map { (accountId: accountId, organizationId: $0) }
    }

    /// The organization to send when creating a conversation of `kind`, only
    /// while the selection belongs to the active account.
    func organizationIdForNewConversation(kind: String) -> String? {
        guard kind != "direct",
              let selection = newConversationOrganization,
              selection.accountId == activeAccountId else { return nil }
        return selection.organizationId
    }
}

/// Answer of `POST /v1/cloud/auth/organization-token`. The refresh token is
/// never part of it.
struct CloudOrganizationTokenResponse: Decodable, Equatable, Sendable {
    var accessToken: String? = nil
    var expiresIn: Double? = nil
    let accountId: String
    var deviceId: String? = nil
    var signInId: String? = nil
    let organizationId: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case expiresIn = "expires_in"
        case accountId = "account_id"
        case deviceId = "device_id"
        case signInId = "sign_in_id"
        case organizationId = "organization_id"
    }
}

private struct CloudOrganizationTokenRequest: Encodable {
    let organizationId: String

    enum CodingKeys: String, CodingKey {
        case organizationId = "organization_id"
    }
}

/// The organization authenticated requests name, and who brings the session
/// back in line when the server answers `409 organization_mismatch`.
struct CloudRequestOrganizationContext {
    /// Returns the token to retry with, or nil to give up.
    typealias MismatchHandler = @Sendable (_ organizationId: String?, _ token: String) async -> String?

    var selection: (accountId: String, organizationId: String)?
    var mismatchHandler: MismatchHandler?
}

extension CloudAPIClient {
    static let organizationHeader = "Kordi-Organization"
    /// Account routes that must work while the header is stale: the
    /// organization list, the token switch, and sign-out.
    static let organizationNeutralPaths = [
        "/v1/cloud/organizations", "/v1/cloud/auth/organization-token", "/v1/cloud/auth/logout",
    ]

    func exchangeOrganizationToken(token: String, organizationId: String) async throws -> CloudOrganizationTokenResponse {
        try await send(
            path: "/v1/cloud/auth/organization-token",
            method: "POST",
            token: token,
            body: CloudOrganizationTokenRequest(organizationId: organizationId),
            fallback: "Could not switch organization."
        )
    }

    /// Sets the organization authenticated requests of `accountId` name; nil sends none.
    func selectRequestOrganization(accountId: String, organizationId: String?) {
        organizationContext.selection = organizationId.nonEmpty.map { (accountId: accountId, organizationId: $0) }
    }

    func setOrganizationMismatchHandler(_ handler: CloudRequestOrganizationContext.MismatchHandler?) {
        organizationContext.mismatchHandler = handler
    }

    /// Names the selected organization on a request made with a session,
    /// only while the selection belongs to the active account.
    func applyOrganizationHeader(to request: inout URLRequest) {
        request.setValue(nil, forHTTPHeaderField: Self.organizationHeader)
        guard request.value(forHTTPHeaderField: "Authorization") != nil,
              !Self.isOrganizationNeutral(request),
              let selection = organizationContext.selection,
              selection.accountId == activeAccountId else { return }
        request.setValue(selection.organizationId, forHTTPHeaderField: Self.organizationHeader)
    }

    /// Sends `request` and validates the answer. On `409 organization_mismatch`
    /// the organization state catches up and the request is retried once.
    func validatedData(for request: URLRequest, fallback: String) async throws -> Data {
        let (data, response) = try await transportData(for: request, fallback: fallback)
        do {
            try validate(response: response, data: data, fallback: fallback)
            return data
        } catch let error as CloudAPIError {
            guard let retry = await organizationRetry(of: request, after: error, body: data) else { throw error }
            let (data, response) = try await transportData(for: retry, fallback: fallback)
            try validate(response: response, data: data, fallback: fallback)
            return data
        }
    }

    private func organizationRetry(of request: URLRequest, after error: CloudAPIError, body: Data) async -> URLRequest? {
        guard error.statusCode == 409, error.code == "organization_mismatch",
              !Self.isOrganizationNeutral(request),
              let handler = organizationContext.mismatchHandler,
              let authorization = request.value(forHTTPHeaderField: "Authorization"),
              authorization.hasPrefix("Bearer ") else { return nil }
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        guard let token = await handler(object?["organizationId"] as? String, String(authorization.dropFirst("Bearer ".count))) else {
            return nil
        }
        var retry = request
        retry.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        applyOrganizationHeader(to: &retry)
        return retry
    }

    private static func isOrganizationNeutral(_ request: URLRequest) -> Bool {
        let path = request.url?.path ?? ""
        return organizationNeutralPaths.contains { path.hasSuffix($0) }
    }
}
