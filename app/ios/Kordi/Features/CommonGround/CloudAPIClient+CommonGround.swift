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

    /// `?profile=<id>`; nothing before profiles.
    private func cgProfile(_ profileId: String?) -> [URLQueryItem] {
        profileId.map { [URLQueryItem(name: "profile", value: $0)] } ?? []
    }

    // MARK: Card

    func commonGroundCard(token: String, profileId: String? = nil) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card"), method: "GET", token: token, query: cgProfile(profileId), fallback: "Could not load your card.")
    }

    func saveCommonGroundTopics(token: String, topics: CommonGroundTopics, profileId: String? = nil) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card"), method: "PUT", token: token, query: cgProfile(profileId), body: topics, fallback: "Could not save your card.")
    }

    func deleteCommonGroundCard(token: String, profileId: String? = nil) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card"), method: "DELETE", token: token, query: cgProfile(profileId), fallback: "Could not delete your card.")
    }

    func buildCommonGroundCard(token: String, request: CommonGroundBuildRequest) async throws -> CommonGroundOwnerView {
        try await send(path: cg("card/build"), method: "POST", token: token, body: request, fallback: "Could not build your card.")
    }

    func setCommonGroundHidden(token: String, hidden: [String], profileId: String? = nil) async throws -> CommonGroundOwnerView {
        struct Body: Encodable { let hidden: [String]; let profileId: String? }
        return try await send(
            path: cg("card/hidden"), method: "PUT", token: token,
            body: Body(hidden: hidden, profileId: profileId), fallback: "Could not update your card."
        )
    }

    func setCommonGroundSharing(token: String, sharing: Bool, profileId: String? = nil) async throws -> CommonGroundOwnerView {
        struct Body: Encodable { let sharing: Bool; let profileId: String? }
        return try await send(
            path: cg("settings"), method: "PUT", token: token,
            body: Body(sharing: sharing, profileId: profileId), fallback: "Could not change sharing."
        )
    }

    // MARK: Profiles

    func commonGroundProfiles(token: String) async throws -> CommonGroundProfileList {
        try await send(path: cg("profiles"), method: "GET", token: token, fallback: "Could not load your profiles.")
    }

    func createCommonGroundProfile(token: String, profile: CommonGroundNewProfile) async throws -> CommonGroundProfileSummary {
        try await send(path: cg("profiles"), method: "POST", token: token, body: profile, fallback: "Could not create the profile.")
    }

    func updateCommonGroundProfile(token: String, profileId: String, edit: CommonGroundProfileEdit) async throws -> CommonGroundProfileSummary {
        try await send(path: cg("profiles/\(cgSegment(profileId))"), method: "PUT", token: token, body: edit, fallback: "Could not save the profile.")
    }

    func deleteCommonGroundProfile(token: String, profileId: String) async throws {
        try await sendWithoutResponse(path: cg("profiles/\(cgSegment(profileId))"), method: "DELETE", token: token, fallback: "Could not delete the profile.")
    }

    /// The owner's memories routed to one profile, newest first.
    func commonGroundProfileMemories(token: String, profileId: String) async throws -> CloudProfileMemoryList {
        try await send(path: cg("profiles/\(cgSegment(profileId))/memories"), method: "GET", token: token, fallback: "Could not load this card's memories.")
    }

    // MARK: Rooms

    /// Rooms the viewer joined and has not left, newest first.
    func commonGroundRooms(token: String) async throws -> CommonGroundRoomList {
        try await send(path: cg("rooms"), method: "GET", token: token, fallback: "Could not load your rooms.")
    }

    func commonGroundRoom(token: String, code: String) async throws -> CommonGroundRoom {
        try await send(path: cg("rooms/\(cgSegment(code))"), method: "GET", token: token, fallback: "Could not load the room.")
    }

    /// Opens a room under a new four-digit code and joins it with a profile.
    func createCommonGroundRoom(token: String, request: CommonGroundCreateRoomRequest) async throws -> CommonGroundRoom {
        try await send(path: cg("rooms"), method: "POST", token: token, body: request, fallback: "Could not create a code.")
    }

    /// A room's name, kind and size for anyone with its code, before joining.
    func commonGroundRoomPreview(token: String, code: String) async throws -> CommonGroundRoomPreview {
        try await send(path: cg("rooms/\(cgSegment(code))/preview"), method: "GET", token: token, fallback: "Could not find the room.")
    }

        func joinCommonGroundRoom(token: String, code: String, request: CommonGroundJoinRequest = .init()) async throws -> CommonGroundRoom {
        try await send(path: cg("rooms/\(cgSegment(code))/join"), method: "POST", token: token, body: request, fallback: "Could not join the room.")
    }

    /// Shares another of your profiles in an open room.
    func switchCommonGroundRoomProfile(token: String, code: String, profileId: String) async throws -> CommonGroundRoom {
        struct Body: Encodable { let profileId: String }
        return try await send(
            path: cg("rooms/\(cgSegment(code))/profile"), method: "POST", token: token,
            body: Body(profileId: profileId), fallback: "Could not change the profile."
        )
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

    /// `profileId` is the viewer's profile to see them through.
    func commonGroundPerson(token: String, accountId: String, profileId: String? = nil) async throws -> CommonGroundPersonCard {
        try await send(
            path: cg("people/\(cgSegment(accountId))"), method: "GET", token: token,
            query: cgProfile(profileId), fallback: "Could not load this card."
        )
    }

    func commonGroundMatch(token: String, accountId: String, profileId: String? = nil) async throws -> CommonGroundMatch {
        try await send(
            path: cg("people/\(cgSegment(accountId))/match"), method: "GET", token: token,
            query: cgProfile(profileId), fallback: "Could not load the match."
        )
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

    func newCommonGroundPairCode(token: String, profileId: String? = nil) async throws -> CommonGroundPairCode {
        struct Body: Encodable { let profileId: String? }
        return try await send(path: cg("pairings/code"), method: "POST", token: token, body: Body(profileId: profileId), fallback: "Could not make a code.")
    }

    /// Pairs with the person who showed `code`, sharing `profileId` back.
    func redeemCommonGroundPairCode(token: String, code: String, profileId: String? = nil) async throws -> CommonGroundPersonCard {
        struct Body: Encodable { let code: String; let profileId: String? }
        return try await send(path: cg("pairings/redeem"), method: "POST", token: token, body: Body(code: code, profileId: profileId), fallback: "Could not pair.")
    }
}
