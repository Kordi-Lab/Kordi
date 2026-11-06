import Foundation

/// What one person may do with your account: use your agents and see your
/// Grounding card. Both default to on; the other person is never told.
struct CloudContactPermissions: Codable, Hashable {
    var agentAccess: Bool = true
    var cardAccess: Bool = true

    private enum CodingKeys: String, CodingKey { case agentAccess, cardAccess }

    init(agentAccess: Bool = true, cardAccess: Bool = true) {
        self.agentAccess = agentAccess
        self.cardAccess = cardAccess
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentAccess = (try? c.decodeIfPresent(Bool.self, forKey: .agentAccess)) ?? true
        cardAccess = (try? c.decodeIfPresent(Bool.self, forKey: .cardAccess)) ?? true
    }
}

/// `GET` and `PUT /v1/cloud/contacts/{account_id}/permissions`.
struct CloudContactPermissionsResponse: Decodable, Hashable {
    let accountId: String
    let permissions: CloudContactPermissions
    let updatedAt: String?

    private enum CodingKeys: String, CodingKey { case accountId, updatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = (try? c.decodeIfPresent(String.self, forKey: .accountId)) ?? ""
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
        permissions = try CloudContactPermissions(from: decoder)
    }
}

/// `PUT` body; a nil key keeps the current value.
struct CloudContactPermissionsUpdate: Encodable, Hashable {
    var agentAccess: Bool?
    var cardAccess: Bool?
}

extension CloudAPIClient {
    private static let contactPermissionsSegment = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    private func contactPermissionsPath(_ accountId: String) -> String {
        let segment = accountId.addingPercentEncoding(withAllowedCharacters: Self.contactPermissionsSegment) ?? accountId
        return "/v1/cloud/contacts/\(segment)/permissions"
    }

    /// Only call when the server reports `contactPermissionsVersion` 1 or later.
    func fetchContactPermissions(token: String, accountId: String) async throws -> CloudContactPermissionsResponse {
        try await send(
            path: contactPermissionsPath(accountId),
            method: "GET",
            token: token,
            fallback: "Could not load permissions."
        )
    }

    func updateContactPermissions(
        token: String,
        accountId: String,
        update: CloudContactPermissionsUpdate
    ) async throws -> CloudContactPermissionsResponse {
        try await send(
            path: contactPermissionsPath(accountId),
            method: "PUT",
            token: token,
            body: update,
            fallback: "Could not save this change."
        )
    }
}
