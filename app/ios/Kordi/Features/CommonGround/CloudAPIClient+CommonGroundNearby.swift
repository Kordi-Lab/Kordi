import Foundation

/// Typed calls for `/v1/cloud/common-ground/nearby…` (docs/development/grounding-nearby.md).
/// Errors arrive as `CloudAPIError` with the server's `errorCode`, such as
/// `common_ground_nearby_off` or `common_ground_nearby_no_location`.
extension CloudAPIClient {
    private static let nearbySegment = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))

    private func cgNearby(_ path: String = "") -> String {
        path.isEmpty ? "/v1/cloud/common-ground/nearby" : "/v1/cloud/common-ground/nearby/\(path)"
    }

    private func cgNearbySegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: Self.nearbySegment) ?? value
    }

    // MARK: Settings

    func commonGroundNearby(token: String) async throws -> CommonGroundNearbySettings {
        try await send(path: cgNearby(), method: "GET", token: token, fallback: "Could not load Nearby.")
    }

    func updateCommonGroundNearby(token: String, update: CommonGroundNearbyUpdate) async throws -> CommonGroundNearbySettings {
        try await send(path: cgNearby(), method: "PUT", token: token, body: update, fallback: "Could not change Nearby.")
    }

    // MARK: Location

    func postCommonGroundNearbyLocation(token: String, fix: CommonGroundNearbyFix) async throws -> CommonGroundNearbyLocationReply {
        try await send(path: cgNearby("location"), method: "POST", token: token, body: fix, fallback: "Could not update your location.")
    }

    /// Deletes this device's location; 204.
    func deleteCommonGroundNearbyLocation(token: String) async throws {
        try await sendWithoutResponse(path: cgNearby("location"), method: "DELETE", token: token, fallback: "Could not remove your location.")
    }

    // MARK: People

    /// Without parameters the stored range and minimum score apply.
    func commonGroundNearbyPeople(token: String, range: Int? = nil, minScore: Int? = nil) async throws -> CommonGroundNearbyPeople {
        var query: [URLQueryItem] = []
        if let range { query.append(URLQueryItem(name: "range", value: String(range))) }
        if let minScore { query.append(URLQueryItem(name: "minScore", value: String(minScore))) }
        return try await send(path: cgNearby("people"), method: "GET", token: token, query: query, fallback: "Could not load people nearby.")
    }

    func commonGroundNearbyPerson(token: String, accountId: String) async throws -> CommonGroundNearbyPersonDetail {
        try await send(
            path: cgNearby("people/\(cgNearbySegment(accountId))"), method: "GET", token: token,
            fallback: "Could not load this person."
        )
    }

    // MARK: Requests

    func commonGroundNearbyNeeds(token: String) async throws -> CommonGroundNearbyNeedList {
        try await send(path: cgNearby("needs"), method: "GET", token: token, fallback: "Could not load your requests.")
    }

    func createCommonGroundNearbyNeed(token: String, draft: CommonGroundNearbyNeedDraft) async throws -> CommonGroundNearbyNeed {
        try await send(path: cgNearby("needs"), method: "POST", token: token, body: draft, fallback: "Could not save the request.")
    }

    func updateCommonGroundNearbyNeed(token: String, needId: String, draft: CommonGroundNearbyNeedDraft) async throws -> CommonGroundNearbyNeed {
        try await send(
            path: cgNearby("needs/\(cgNearbySegment(needId))"), method: "PUT", token: token, body: draft,
            fallback: "Could not save the request."
        )
    }

    func deleteCommonGroundNearbyNeed(token: String, needId: String) async throws {
        try await sendWithoutResponse(
            path: cgNearby("needs/\(cgNearbySegment(needId))"), method: "DELETE", token: token,
            fallback: "Could not delete the request."
        )
    }
}
