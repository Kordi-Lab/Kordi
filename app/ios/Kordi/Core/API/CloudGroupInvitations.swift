import Foundation

/// A group invitation this account claimed from a link and has not answered.
struct GroupInvitePending: Decodable, Hashable, Identifiable {
    let id: String
    let invitationId: String
    let groupName: String
    let inviterName: String
    let memberCount: Int
    let expiresAt: String

    private enum CodingKeys: String, CodingKey {
        case id, invitationId, groupName, inviterName, memberCount, expiresAt
    }

    init(id: String, invitationId: String, groupName: String, inviterName: String, memberCount: Int, expiresAt: String) {
        self.id = id
        self.invitationId = invitationId
        self.groupName = groupName
        self.inviterName = inviterName
        self.memberCount = memberCount
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        invitationId = (try? c.decodeIfPresent(String.self, forKey: .invitationId)) ?? ""
        groupName = (try? c.decodeIfPresent(String.self, forKey: .groupName))?.nonEmpty ?? "Group"
        inviterName = (try? c.decodeIfPresent(String.self, forKey: .inviterName))?.nonEmpty ?? "Someone"
        memberCount = max(0, (try? c.decodeIfPresent(Int.self, forKey: .memberCount)) ?? 0)
        expiresAt = (try? c.decodeIfPresent(String.self, forKey: .expiresAt)) ?? ""
    }

    var expiryDate: Date? {
        Self.fractionalFormatter.date(from: expiresAt) ?? Self.plainFormatter.date(from: expiresAt)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter = ISO8601DateFormatter()
}

/// What claiming a link gave: an invitation to answer, or a group the
/// account is already in.
enum GroupInviteClaimResult: Equatable {
    case pending(GroupInvitePending)
    case alreadyMember(conversationId: String?)
}

private struct GroupInviteClaimResponse: Decodable {
    let pending: GroupInvitePending
}

private struct GroupInvitePendingListResponse: Decodable {
    let invitations: [GroupInvitePending]
}

private struct GroupInviteAcceptResponse: Decodable {
    let conversationId: String
}

/// `409 already_member` may name the conversation to open.
private struct GroupInviteAlreadyMemberBody: Decodable {
    let conversationId: String?
}

extension CloudAPIClient {
    /// `POST /v1/cloud/invitations/groups/claim/{token}`.
    func claimGroupInvitation(token: String, inviteToken: String) async throws -> GroupInviteClaimResult {
        let fallback = "Could not open this invitation."
        let request = try makeRequest(
            path: "/v1/cloud/invitations/groups/claim/\(Self.groupInvitePathSegment(inviteToken))",
            method: "POST",
            token: token,
            query: [],
            body: nil
        )
        let (data, response) = try await transportData(for: request, fallback: fallback)
        do {
            try validate(response: response, data: data, fallback: fallback)
        } catch let error as CloudAPIError where error.statusCode == 409 && error.code == "already_member" {
            let body = try? JSONDecoder().decode(GroupInviteAlreadyMemberBody.self, from: data)
            return .alreadyMember(conversationId: body?.conversationId?.nonEmpty)
        }
        do {
            return .pending(try JSONDecoder().decode(GroupInviteClaimResponse.self, from: data).pending)
        } catch {
            throw CloudAPIError(code: "invalid_response", message: "Kordi Cloud returned an unexpected response.", statusCode: 0)
        }
    }

    /// `GET /v1/cloud/invitations/groups/pending`.
    func listPendingGroupInvitations(token: String) async throws -> [GroupInvitePending] {
        let response: GroupInvitePendingListResponse = try await send(
            path: "/v1/cloud/invitations/groups/pending",
            method: "GET",
            token: token,
            fallback: "Could not load group invitations."
        )
        return response.invitations
    }

    /// `POST /v1/cloud/invitations/groups/pending/{id}/accept`; returns the conversation id.
    func acceptPendingGroupInvitation(token: String, pendingId: String) async throws -> String {
        let response: GroupInviteAcceptResponse = try await send(
            path: "/v1/cloud/invitations/groups/pending/\(Self.groupInvitePathSegment(pendingId))/accept",
            method: "POST",
            token: token,
            fallback: "Could not join the group."
        )
        return response.conversationId
    }

    /// `DELETE /v1/cloud/invitations/groups/pending/{id}`.
    func dismissPendingGroupInvitation(token: String, pendingId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/invitations/groups/pending/\(Self.groupInvitePathSegment(pendingId))",
            method: "DELETE",
            token: token,
            fallback: "Could not dismiss the invitation."
        )
    }

    static func groupInvitePathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}
