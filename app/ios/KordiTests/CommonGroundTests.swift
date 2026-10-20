import XCTest
@testable import Kordi

@MainActor
final class CommonGroundTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17082")!

    // Wire shapes from bridges/cloud-server/src/common_ground.
    static let ownerJSON = #"""
    {
      "card": {
        "workingOn": ["Agent memory"],
        "interests": ["Evaluation"],
        "canHelp": ["Rust"],
        "lookingFor": [],
        "hidden": ["Evaluation"],
        "revision": 3,
        "builtAt": "2026-10-19T10:00:00.123456Z",
        "profile": {
          "latest": ["Agent memory"],
          "earlier": ["Compilers"],
          "timeline": [{"period": "Q3 2026", "topics": ["Agent memory"]}],
          "topics": {"Agent memory": {"refs": ["e1"], "firstSeen": "2026-08-01", "lastSeen": "2026-10-01", "score": 0.8}},
          "evidence": {"e1": {"source": "iPhone Calendar", "title": "Memory sync", "date": "2026-10-01", "url": null, "snippet": ""}}
        }
      },
      "sharing": true,
      "build": {"status": "idle", "errorCode": null},
      "used": ["notes"]
    }
    """#

    static let buildingJSON = #"{"card":null,"sharing":true,"build":{"status":"building","errorCode":null}}"#

    static let resultsJSON = #"""
    {
      "status": "matching",
      "people": [{
        "person": {"accountId": "acct_b", "name": "Priya", "avatarUrl": null},
        "score": 82,
        "headline": "Both work on agent memory",
        "relationship": {"contact": false, "request": "incoming", "requestId": "req_1", "conversationId": null}
      }],
      "topics": [{"label": "Agent memory", "people": [{"accountId": "acct_a", "name": "Alex", "avatarUrl": null}]}],
      "suggestion": null,
      "groups": [{"groupSpaceId": "gs_1", "conversationId": "c_1", "name": "Memory", "memberCount": 3,
                  "createdBy": {"accountId": "acct_b", "name": "Priya", "avatarUrl": null}, "joined": false}],
      "invitations": [{"invitationRef": "inv_1", "groupSpaceId": "gs_1", "name": "Memory",
                       "from": {"accountId": "acct_b", "name": "Priya", "avatarUrl": null}, "createdAt": "2026-10-20T09:00:00Z"}]
    }
    """#

    static let matchJSON = #"""
    {
      "status": "ready",
      "person": {"accountId": "acct_b", "name": "Priya", "avatarUrl": null},
      "score": 82,
      "headline": "Both work on agent memory",
      "shared": [{"topic": "Agent memory", "theirTopic": "Memory for agents", "why": "Same problem"}],
      "youBring": [{"topic": "Rust", "for": "Fast sync", "why": "You ship Rust"}],
      "theyBring": [],
      "nextStep": "Compare notes",
      "relationship": {"contact": true, "request": null, "requestId": null, "conversationId": "c_9"}
    }
    """#

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: Decoding

    func testOwnerViewDecodesCardProfileAndBuild() throws {
        let view = try decode(CommonGroundOwnerView.self, Self.ownerJSON)
        let card = try XCTUnwrap(view.card)
        XCTAssertEqual(card.topics.workingOn, ["Agent memory"])
        XCTAssertEqual(card.hidden, ["Evaluation"])
        XCTAssertEqual(card.revision, 3)
        XCTAssertEqual(card.profile?.latest, ["Agent memory"])
        XCTAssertEqual(card.profile?.evidence(for: "Agent memory").first?.item.title, "Memory sync")
        XCTAssertEqual(view.build.status, "idle")

        let building = try decode(CommonGroundOwnerView.self, Self.buildingJSON)
        XCTAssertNil(building.card)
        XCTAssertEqual(building.build.status, "building")
    }

    func testResultsDecodeRelationshipsGroupsAndInvitations() throws {
        let results = try decode(CommonGroundResults.self, Self.resultsJSON)
        XCTAssertTrue(results.isMatching)
        XCTAssertEqual(results.people.first?.score, 82)
        XCTAssertEqual(results.people.first?.relationship?.request, "incoming")
        XCTAssertEqual(results.groups.first?.joined, false)
        XCTAssertEqual(results.invitations.first?.from.displayName, "Priya")
        XCTAssertNil(results.suggestion)
    }

    func testMatchDecodesReadyAndPending() throws {
        let match = try decode(CommonGroundMatch.self, Self.matchJSON)
        XCTAssertTrue(match.isReady)
        XCTAssertEqual(match.youBring.first?.target, "Fast sync")
        XCTAssertEqual(match.relationship?.conversationId, "c_9")

        let pending = try decode(CommonGroundMatch.self, #"{"status":"matching","person":{"accountId":"acct_b","name":"Priya","avatarUrl":null},"relationship":{"contact":false,"request":null,"requestId":null,"conversationId":null}}"#)
        XCTAssertTrue(pending.isMatching)
        XCTAssertNil(pending.score)
        XCTAssertTrue(pending.shared.isEmpty)
    }

    func testRoomDecodesMembersWithRelationship() throws {
        let room = try decode(CommonGroundRoom.self, #"""
        {"roomId":"r","code":"4821","name":"","openedByYou":true,"expiresAt":"2026-10-21T09:00:00Z",
         "members":[{"accountId":"acct_b","name":"Priya","avatarUrl":null,"hasCard":true,
                     "relationship":{"contact":true,"request":null,"requestId":null,"conversationId":null}}]}
        """#)
        XCTAssertEqual(room.title, "Room 4821")
        XCTAssertEqual(room.members.first?.relationship?.contact, true)
        XCTAssertTrue(room.groups.isEmpty)
    }

    // MARK: Relationship

    func testContactActionFollowsRelationship() {
        XCTAssertEqual(CommonGroundContactAction(nil), .hidden)
        XCTAssertEqual(CommonGroundContactAction(.init()), .add)
        XCTAssertEqual(CommonGroundContactAction(.init(request: "outgoing", requestId: "r")), .requested)
        XCTAssertEqual(CommonGroundContactAction(.init(request: "incoming", requestId: "r")), .accept)
        XCTAssertEqual(CommonGroundContactAction(.init(request: "incoming")), .requested)
        XCTAssertEqual(CommonGroundContactAction(.init(contact: true)), .message)
        XCTAssertTrue(CommonGroundContactAction.canMeet(.init(contact: true)))
        XCTAssertFalse(CommonGroundContactAction.canMeet(.init(request: "outgoing")))
    }

    // MARK: Capability

    func testAvailabilityNeedsSignInAndCapability() throws {
        let caps = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":[],"commonGroundVersion":1}"#)
        XCTAssertEqual(caps.commonGroundVersion, 1)
        XCTAssertTrue(CommonGroundAvailability.isEnabled(signedIn: true, capabilities: caps))
        XCTAssertFalse(CommonGroundAvailability.isEnabled(signedIn: false, capabilities: caps))
        XCTAssertFalse(CommonGroundAvailability.isEnabled(signedIn: true, capabilities: CloudAuthCapabilities(password: true)))
        XCTAssertFalse(CommonGroundAvailability.isEnabled(signedIn: true, capabilities: nil))
    }

    func testRateLimitNamesTheWaitInMinutes() {
        let limited = CloudAPIError(code: "rate_limited", message: "Try again in a minute.", statusCode: 429, retryAfterSeconds: 90)
        XCTAssertEqual(CommonGroundModel.message(for: limited), "Try again in 2 min.")
        let server = CloudAPIError(code: "common_ground_not_contacts", message: "Add them first.", statusCode: 409)
        XCTAssertEqual(CommonGroundModel.message(for: server), "Add them first.")
        XCTAssertNil(CommonGroundModel.message(for: CancellationError()))
    }

    func testMeetInputUsesLengthAndTrimmedTitle() throws {
        let start = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-20T10:00:00Z"))
        let input = CommonGroundMeetSheet.input(title: "  Meet Priya ", start: start, minutes: 90)
        XCTAssertEqual(input.title, "Meet Priya")
        XCTAssertEqual(input.startAt, "2026-10-20T10:00:00Z")
        XCTAssertEqual(input.endAt, "2026-10-20T11:30:00Z")
    }

    // MARK: Model

    func testBuildPollsUntilTheCardIsReady() async throws {
        CommonGroundURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        let model = CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex")) { (api, "session-value") }

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/card/build", [(202, Self.buildingJSON)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, Self.buildingJSON), (200, Self.ownerJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/code", [(201, #"{"code":"AB12-CD34","expiresAt":"2099-01-01T00:00:00Z"}"#)])

        let device = [CommonGroundDeviceItems(source: "iPhone Calendar", items: [.init(title: "Memory sync", date: "2026-10-01")])]
        await model.build(CommonGroundBuildRequest(memory: false, connectors: true, device: device, links: "", notes: "Agents"))
        XCTAssertTrue(model.isBuilding)
        XCTAssertFalse(model.hasCard)

        await model.waitForBuild(every: .milliseconds(1))
        XCTAssertFalse(model.isBuilding)
        XCTAssertEqual(model.card?.topics.workingOn, ["Agent memory"])
        XCTAssertEqual(model.myTopics, ["Agent memory", "Rust"])
        XCTAssertEqual(model.pairCode?.code, "AB12-CD34")
        XCTAssertNil(model.notice)

        XCTAssertEqual(CommonGroundURLProtocol.paths.filter { $0 == "GET /v1/cloud/common-ground/card" }.count, 2)
        let post = try XCTUnwrap(CommonGroundURLProtocol.requests.first { $0.request.httpMethod == "POST" })
        XCTAssertEqual(post.request.value(forHTTPHeaderField: "Authorization"), "Bearer session-value")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(post.body)) as? [String: Any])
        XCTAssertEqual(body["connectors"] as? Bool, true)
        XCTAssertEqual((body["device"] as? [[String: Any]])?.first?["source"] as? String, "iPhone Calendar")
    }
}

/// Serves queued responses per "METHOD /path"; the last one repeats.
private final class CommonGroundURLProtocol: URLProtocol {
    struct Recorded {
        let request: URLRequest
        let body: Data?
    }

    private static var responses: [String: [(status: Int, body: String)]] = [:]
    private(set) static var requests: [Recorded] = []

    static var paths: [String] {
        requests.map { "\($0.request.httpMethod ?? "GET") \($0.request.url?.path ?? "")" }
    }

    static func reset() {
        responses = [:]
        requests = []
    }

    static func stub(_ method: String, _ path: String, _ queue: [(Int, String)]) {
        responses["\(method) \(path)"] = queue.map { (status: $0.0, body: $0.1) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(Recorded(request: request, body: request.httpBody ?? Self.read(request.httpBodyStream)))
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        var queue = Self.responses[key] ?? []
        let stubbed = queue.first ?? (404, #"{"errorCode":"not_found","message":"Not found."}"#)
        if queue.count > 1 { queue.removeFirst() }
        Self.responses[key] = queue
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stubbed.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(stubbed.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
