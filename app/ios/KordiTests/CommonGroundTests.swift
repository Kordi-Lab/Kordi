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

    func testRoomListDecodesAndDefaultsOpen() throws {
        let list = try decode(CommonGroundRoomList.self, #"""
        {"rooms":[{"code":"4821","name":"","open":false,"memberCount":3,"joinedAt":"2026-10-20T09:00:00Z",
                   "lastActivityAt":"2026-10-20T10:00:00Z","themeCount":1},
                  {"code":"1234","name":"Agents meetup","memberCount":1,"themeCount":4}]}
        """#)
        XCTAssertEqual(list.rooms.map(\.code), ["4821", "1234"])
        XCTAssertEqual(list.rooms[0].title, "Room 4821")
        XCTAssertEqual(list.rooms[0].subtitle, "3 people · 1 topic · Closed")
        XCTAssertTrue(list.rooms[1].open)
        XCTAssertEqual(list.rooms[1].subtitle, "1 person · 4 topics")
        XCTAssertTrue(try decode(CommonGroundRoomList.self, "{}").rooms.isEmpty)

        let room = try decode(CommonGroundRoom.self, #"{"code":"4821","open":false}"#)
        XCTAssertFalse(room.open)
        XCTAssertTrue(try decode(CommonGroundRoom.self, #"{"code":"4821"}"#).open)
        let group = try decode(CommonGroundGroup.self, #"{"groupSpaceId":"gs_1","name":"Memory agents","topic":"Agent memory"}"#)
        XCTAssertEqual(group.topic, "Agent memory")
        XCTAssertNil(try decode(CommonGroundGroup.self, #"{"groupSpaceId":"gs_1"}"#).topic)
    }

    func testGroupMembersDecodeAndFallBack() throws {
        let with = try decode(CommonGroundGroup.self, #"{"groupSpaceId":"gs_1","memberCount":3,"members":[{"accountId":"a","name":"Ana","avatarUrl":"https://x/a.png"},{"accountId":"b","name":"Bo"}]}"#)
        XCTAssertEqual(with.members.map(\.accountId), ["a", "b"])
        XCTAssertEqual(with.members.first?.avatarUrl, "https://x/a.png")
        XCTAssertNil(with.members.last?.avatarUrl)
        XCTAssertTrue(try decode(CommonGroundGroup.self, #"{"groupSpaceId":"gs_1"}"#).members.isEmpty)
    }

    func testGroupDetailLine() throws {
        func line(_ json: String) throws -> String? { try decode(CommonGroundGroup.self, json).detailLine }
        XCTAssertEqual(try line(#"{"groupSpaceId":"g","topic":"Agent memory","memberCount":3}"#), "From Agent memory · 3 members")
        XCTAssertEqual(try line(#"{"groupSpaceId":"g","memberCount":1}"#), "1 member")
        XCTAssertEqual(try line(#"{"groupSpaceId":"g","memberCount":2}"#), "2 members")
        XCTAssertEqual(try line(#"{"groupSpaceId":"g","topic":"Agent memory"}"#), "From Agent memory")
        XCTAssertNil(try line(#"{"groupSpaceId":"g"}"#))
    }

    /// A room group has only its root channel's shared title; Chats names the group by it.
    func testServerStartedGroupIsNamedByItsSharedTitle() {
        let account = PreviewData.make(now: Date(timeIntervalSince1970: 1_800_000_000)).account
        func canonical(_ sessionId: String, title: String) -> CloudChatConversation {
            CloudChatConversation(id: "c-\(sessionId)", kind: "group", sharedTitle: title, version: 1,
                createdByAccountId: "acct_b", legacySessionId: sessionId, forkedFromSessionId: nil,
                forkedFromMessageId: nil, latestMessageSequence: 0, createdAt: "2026-10-20T09:00:00Z",
                updatedAt: "2026-10-20T09:00:00Z", members: [],
                preferences: CloudChatPreferences(conversationId: "c-\(sessionId)", accountId: account.accountId, personalTitle: nil, version: 1))
        }
        let conversations = CloudConversationCatalog.build(
            account: account, contacts: [], ownedAgents: [], sharedAgents: [], messagesByPeer: [:],
            canonicalConversations: [canonical("session:group:room", title: "Memory agents"), canonical("session:group:plain", title: "Channel 1")]
        )
        let spaces = GroupSpaceCatalog.build(conversations: conversations, ownAccountId: account.accountId)
        XCTAssertEqual(spaces.first { $0.id == "group:session:group:room" }?.displayName, "Memory agents")
        XCTAssertNotEqual(spaces.first { $0.id == "group:session:group:plain" }?.displayName, "Channel 1")
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

    func testPersonCommunicationActionsWaitForAcceptedContact() {
        for relationship in [
            CommonGroundRelationship(),
            .init(request: "outgoing", requestId: "r"),
            .init(request: "incoming", requestId: "r"),
            .init(request: "incoming"),
        ] {
            let state = CommonGroundPersonActionAvailability(relationship: relationship, busy: false)
            XCTAssertTrue(state.showsActions)
            XCTAssertTrue(state.showsContactAction)
            XCTAssertFalse(state.communicationEnabled, "A pending request must not unlock Message or Meet")
            XCTAssertEqual(state.contactActionEnabled, state.contactAction == .add || state.contactAction == .accept)
        }
        let accepted = CommonGroundPersonActionAvailability(relationship: .init(contact: true), busy: false)
        XCTAssertTrue(accepted.showsActions)
        XCTAssertFalse(accepted.showsContactAction, "Contacts should not gain a duplicate Message action")
        XCTAssertTrue(accepted.communicationEnabled)
    }

    func testPersonActionsRemainUnavailableWhileBusyOrRelationshipUnknown() {
        let unknown = CommonGroundPersonActionAvailability(relationship: nil, busy: false)
        XCTAssertFalse(unknown.showsActions)
        XCTAssertFalse(unknown.contactActionEnabled)
        XCTAssertFalse(unknown.communicationEnabled)
        for relationship in [CommonGroundRelationship(), .init(request: "incoming", requestId: "r"), .init(contact: true)] {
            let busy = CommonGroundPersonActionAvailability(relationship: relationship, busy: true)
            XCTAssertTrue(busy.showsActions)
            XCTAssertFalse(busy.contactActionEnabled)
            XCTAssertFalse(busy.communicationEnabled)
        }
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

    private func stubbedModel() -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        return CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex")) { (api, "session-value") }
    }

    func testClosedRoomResultsDoNotPollAndRemoveLeaves() async throws {
        let model = stubbedModel()
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms", [(200, #"{"rooms":[{"code":"4821","name":"","open":false,"memberCount":3,"themeCount":1}]}"#)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms/4821/results", [(200, Self.resultsJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms/4821/leave", [(204, "")])

        await model.loadRooms()
        XCTAssertTrue(model.isClosed("4821"))
        XCTAssertEqual(model.roomTitle("4821"), "Room 4821")
        await model.loadResults("4821", quiet: true)
        await model.waitForResults("4821", every: .milliseconds(1))
        XCTAssertEqual(CommonGroundURLProtocol.paths.filter { $0.hasSuffix("/results") }.count, 1)

        await model.leaveRoom("4821")
        XCTAssertEqual(model.roomList?.isEmpty, true)
        XCTAssertTrue(CommonGroundURLProtocol.paths.contains("POST /v1/cloud/common-ground/rooms/4821/leave"))
    }

    func testRoomListHiddenWhenServerHasNoRoute() async {
        let model = stubbedModel()
        await model.loadRooms()
        XCTAssertNil(model.roomList)
        XCTAssertNil(model.notice)
    }

    func testTopicGroupRequestCarriesTopic() async throws {
        let model = stubbedModel()
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms/4821/group", [(201, #"""
        {"group":{"groupSpaceId":"gs_2","conversationId":"c_2","name":"Agent memory","memberCount":3,"joined":true},
         "added":[],"invited":[]}
        """#)])
        let theme = CommonGroundTheme(label: "Agent memory", people: [
            CommonGroundPerson(accountId: "acct_a", name: "Alex"), CommonGroundPerson(accountId: "acct_b", name: "Priya"),
        ])
        let draft = CommonGroundGroupDraft(theme: theme, me: "acct_a")
        XCTAssertEqual(draft.name, "Agent memory")
        XCTAssertEqual(draft.selected, ["acct_b"])

        let created = await model.createGroup(code: "4821", name: draft.name, memberIds: Array(draft.selected), topic: draft.topic)
        XCTAssertEqual(created?.group.groupSpaceId, "gs_2")
        let post = try XCTUnwrap(CommonGroundURLProtocol.requests.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(post.body)) as? [String: Any])
        XCTAssertEqual(body["topic"] as? String, "Agent memory")
        XCTAssertEqual(body["name"] as? String, "Agent memory")
        XCTAssertEqual(body["memberIds"] as? [String], ["acct_b"])
    }

    func testBuildPollsUntilTheCardIsReady() async throws {
        let model = stubbedModel()

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/card/build", [(202, Self.buildingJSON)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, Self.buildingJSON), (200, Self.ownerJSON)])

        let device = [CommonGroundDeviceItems(source: "iPhone Calendar", items: [.init(title: "Memory sync", date: "2026-10-01")])]
        await model.build(CommonGroundBuildRequest(memory: false, connectors: true, device: device, links: "", notes: "Agents"))
        XCTAssertTrue(model.isBuilding)
        XCTAssertFalse(model.hasCard)

        await model.waitForBuild(every: .milliseconds(1))
        XCTAssertFalse(model.isBuilding)
        XCTAssertEqual(model.card?.topics.workingOn, ["Agent memory"])
        XCTAssertEqual(model.myTopics, ["Agent memory", "Rust"])
        XCTAssertNil(model.notice)

        XCTAssertEqual(CommonGroundURLProtocol.paths.filter { $0 == "GET /v1/cloud/common-ground/card" }.count, 2)
        let post = try XCTUnwrap(CommonGroundURLProtocol.requests.first { $0.request.httpMethod == "POST" })
        XCTAssertEqual(post.request.value(forHTTPHeaderField: "Authorization"), "Bearer session-value")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(post.body)) as? [String: Any])
        XCTAssertEqual(body["connectors"] as? Bool, true)
        XCTAssertEqual((body["device"] as? [[String: Any]])?.first?["source"] as? String, "iPhone Calendar")
    }

    func testCanBuildOnlyWhenSomethingIsSent() {
        var choices = CommonGroundBuildChoices(memoryOn: true, memoryCount: 0)
        XCTAssertFalse(choices.canBuild, "memory on with no memories sends nothing")
        choices.memoryCount = nil
        XCTAssertFalse(choices.canBuild)
        choices.memoryCount = 12
        XCTAssertTrue(choices.canBuild)

        choices = CommonGroundBuildChoices(device: [CommonGroundDeviceItems(source: "iPhone Calendar", items: [])])
        XCTAssertFalse(choices.canBuild, "a device source without items sends nothing")
        choices.device = [CommonGroundDeviceItems(source: "iPhone Calendar", items: [.init(title: "Memory sync", date: "2026-10-01")])]
        XCTAssertTrue(choices.canBuild)

        XCTAssertFalse(CommonGroundBuildChoices(links: "  ", notes: "\n").canBuild)
        XCTAssertTrue(CommonGroundBuildChoices(notes: "Agent memory").canBuild)
        XCTAssertTrue(CommonGroundBuildChoices(links: "https://example.com").canBuild)
        XCTAssertTrue(CommonGroundBuildChoices(connectedCount: 1).canBuild)
        XCTAssertFalse(CommonGroundBuildChoices().canBuild)
    }

    func testBuildRequestSendsConnectorsOnlyWhenConnected() throws {
        let none = CommonGroundBuildChoices(memoryOn: true, memoryCount: 0, connectedCount: 0, notes: " Agents ").request
        XCTAssertFalse(none.connectors)
        XCTAssertFalse(none.memory)
        XCTAssertEqual(none.notes, "Agents")

        let connected = CommonGroundBuildChoices(memoryOn: false, memoryCount: 3, connectedCount: 2).request
        XCTAssertTrue(connected.connectors)
        XCTAssertFalse(connected.memory)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(connected)) as? [String: Any])
        XCTAssertEqual(body["connectors"] as? Bool, true)
        XCTAssertEqual(body["memory"] as? Bool, false)
    }

    func testBuildCopy() {
        XCTAssertEqual(CommonGroundBuildCopy.memoryLine(12), "12 memories")
        XCTAssertEqual(CommonGroundBuildCopy.memoryLine(1), "1 memory")
        XCTAssertEqual(CommonGroundBuildCopy.memoryLine(0), "No memories yet")
        XCTAssertEqual(CommonGroundBuildCopy.connectorLine(.gmail, status: nil), "Paper, review and conference threads")
        XCTAssertEqual(CommonGroundBuildCopy.connectorLine(.github, status: .connected), "Connected")
        XCTAssertEqual(CommonGroundBuildCopy.connectorLine(.slack, status: .needsReauth), "Sign in again")
        XCTAssertEqual(CommonGroundModel.messages["common_ground_no_card"], "Build your profile first.")
        XCTAssertEqual(CommonGroundModel.messages["no_topics"], "Nothing here fits this profile. Add a note or choose other sources.")
        XCTAssertEqual(CommonGroundProfileKind.work.notesHint, "What are you working on?")
        XCTAssertEqual(CommonGroundProfileKind.health.notesHint, "How do you stay active?")
        XCTAssertEqual(CommonGroundProfileKind.daily.notesHint, "What do you enjoy doing?")
        XCTAssertEqual(CommonGroundProfileKind.custom.notesHint, "What should this profile show?")
    }
}

/// Serves queued responses per "METHOD /path"; the last one repeats.
/// Shared with CommonGroundProfileTests.
final class CommonGroundURLProtocol: URLProtocol {
    struct Recorded {
        let request: URLRequest
        let body: Data?
    }

    private static var responses: [String: [(status: Int, body: String)]] = [:]
    private(set) static var requests: [Recorded] = []
    private static var heldPaths: Set<String> = []
    private static var pending: [String: [() -> Void]] = [:]

    static func hold(_ path: String) { heldPaths.insert(path) }
    static func hasHeldResponse(_ path: String) -> Bool { !(pending[path] ?? []).isEmpty }
    static func release(_ path: String) {
        heldPaths.remove(path)
        let callbacks = pending.removeValue(forKey: path) ?? []
        callbacks.forEach { $0() }
    }

    static var paths: [String] {
        requests.map { "\($0.request.httpMethod ?? "GET") \($0.request.url?.path ?? "")" }
    }

    static func reset() {
        responses = [:]
        requests = []
        heldPaths = []
        pending = [:]
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
        let deliver = {
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Data(stubbed.body.utf8))
            self.client?.urlProtocolDidFinishLoading(self)
        }
        let path = request.url?.path ?? ""
        if Self.heldPaths.contains(path) { Self.pending[path, default: []].append(deliver) }
        else { deliver() }
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
