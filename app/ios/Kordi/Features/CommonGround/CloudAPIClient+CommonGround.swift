import Foundation

/// Typed calls for `/v1/cloud/common-ground`. Errors arrive as `CloudAPIError`
/// with the server's `errorCode`, message and `Retry-After`. Card builds and
/// matches report progress in the body (`build.status`, `status`), so a 202
/// decodes like a 200.
extension CloudAPIClient {
    private static let commonGroundSegment = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    private func cg(_ path: String) -> String { "/v1/cloud/common-ground/\(path)" }

    private func cgSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: Self.commonGroundSegment) ?? value
    }

    // MARK: Card

    func commonGroundCard(token: String) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card"), method: "GET", token: token, fallback: "Could not load your card.")
    }

    func saveCommonGroundTopics(token: String, topics: CommonGroundTopics) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card"), method: "PUT", token: token, body: topics, fallback: "Could not save your card.")
    }

    func deleteCommonGroundCard(token: String) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card"), method: "DELETE", token: token, fallback: "Could not delete your card.")
    }

    func buildCommonGroundCard(token: String, request: CommonGroundBuildRequest) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card/build"), method: "POST", token: token, body: request, fallback: "Could not build your card.")
    }

    func setCommonGroundHidden(token: String, hidden: [String]) async throws -> CommonGroundOwnerView {
        struct Body: Encodable { let hidden: [String] }
        return try await send(path: cg("card/hidden"), method: "PUT", token: token, body: Body(hidden: hidden), fallback: "Could not update your card.")
    }

    func setCommonGroundSharing(token: String, sharing: Bool) async throws -> CommonGroundOwnerView {
        struct Body: Encodable { let sharing: Bool }
        return try await send(path: cg("settings"), method: "PUT", token: token, body: Body(sharing: sharing), fallback: "Could not change sharing.")
    }

    // MARK: Rooms

    /// Rooms the viewer joined and has not left, newest first.
    func commonGroundRooms(token: String) async throws -> CommonGroundRoomList {
        try await send(path: cg("rooms"), method: "GET", token: token, fallback: "Could not load your rooms.")
    }

    func commonGroundRoom(token: String, code: String) async throws -> CommonGroundRoom {
        try await send(path: cg("rooms/\(cgSegment(code))"), method: "GET", token: token, fallback: "Could not load the room.")
    }

    func joinCommonGroundRoom(token: String, code: String, name: String? = nil) async throws -> CommonGroundRoom {
        struct Body: Encodable { let name: String? }
        return try await send(path: cg("rooms/\(cgSegment(code))/join"), method: "POST", token: token, body: Body(name: name), fallback: "Could not join the room.")
    }

    func leaveCommonGroundRoom(token: String, code: String) async throws {
        try await sendWithoutResponse(path: cg("rooms/\(cgSegment(code))/leave"), method: "POST", token: token, fallback: "Could not leave the room.")
    }

    func commonGroundResults(token: String, code: String) async throws -> CommonGroundResults {
        try await send(path: cg("rooms/\(cgSegment(code))/results"), method: "POST", token: token, fallback: "Could not find common ground.")
    }

    func createCommonGroundGroup(token: String, code: String, name: String, memberIds: [String], topic: String? = nil) async throws -> CommonGroundCreatedGroup {
        struct Body: Encodable { let name: String; let memberIds: [String]; let topic: String? }
        return try await send(
            path: cg("rooms/\(cgSegment(code))/group"), method: "POST", token: token,
            body: Body(name: name, memberIds: memberIds, topic: topic), fallback: "Could not start the group."
        )
    }

    func joinCommonGroundInvitation(token: String, code: String, invitationRef: String) async throws -> CommonGroundJoinedGroup {
        try await send(
            path: cg("rooms/\(cgSegment(code))/invitations/\(cgSegment(invitationRef))/join"), method: "POST", token: token,
            fallback: "Could not join the group."
        )
    }

    // MARK: People

    func commonGroundPerson(token: String, accountId: String) async throws -> CommonGroundPersonCard {
        try await send(path: cg("people/\(cgSegment(accountId))"), method: "GET", token: token, fallback: "Could not load this card.")
    }

    func commonGroundMatch(token: String, accountId: String) async throws -> CommonGroundMatch {
        try await send(path: cg("people/\(cgSegment(accountId))/match"), method: "GET", token: token, fallback: "Could not load the match.")
    }

    func addCommonGroundContact(token: String, accountId: String, message: String? = nil) async throws -> CommonGroundRelationshipResponse {
        struct Body: Encodable { let message: String? }
        return try await send(
            path: cg("people/\(cgSegment(accountId))/contact"), method: "POST", token: token,
            body: Body(message: message), fallback: "Could not send the request."
        )
    }

    func openCommonGroundChat(token: String, accountId: String) async throws -> CommonGroundChatResponse {
        try await send(path: cg("people/\(cgSegment(accountId))/chat"), method: "POST", token: token, fallback: "Could not open the chat.")
    }

    func proposeCommonGroundMeeting(token: String, accountId: String, input: CommonGroundMeetInput) async throws -> CommonGroundMeetResponse {
        try await send(path: cg("people/\(cgSegment(accountId))/meet"), method: "POST", token: token, body: input, fallback: "Could not propose a time.")
    }

    func commonGroundRecent(token: String) async throws -> CommonGroundPeopleResponse<CommonGroundRecentEntry> {
        try await send(path: cg("recent"), method: "GET", token: token, fallback: "Could not load recent matches.")
    }

    // MARK: Pairing

    func commonGroundPairings(token: String) async throws -> CommonGroundPeopleResponse<CommonGroundPerson> {
        try await send(path: cg("pairings"), method: "GET", token: token, fallback: "Could not load pairings.")
    }

    func newCommonGroundPairCode(token: String) async throws -> CommonGroundPairCode {
        try await send(path: cg("pairings/code"), method: "POST", token: token, fallback: "Could not make a code.")
    }

    func redeemCommonGroundPairCode(token: String, code: String) async throws -> CommonGroundPersonCard {
        struct Body: Encodable { let code: String }
        return try await send(path: cg("pairings/redeem"), method: "POST", token: token, body: Body(code: code), fallback: "Could not pair.")
    }
}
