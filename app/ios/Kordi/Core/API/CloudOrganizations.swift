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
