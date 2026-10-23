import XCTest
@testable import Kordi

/// Profiles (`commonGroundVersion` 2): decoding, the current profile saved
/// per account, request bodies, and version 1 behaving as before.
@MainActor
final class CommonGroundProfileTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17082")!

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func stubbedModel(profiles: Bool = false, defaults: UserDefaults = .standard, reset: Bool = true) -> CommonGroundModel {
        if reset { CommonGroundURLProtocol.reset() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        return CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex"), profilesEnabled: profiles, defaults: defaults) {
            (api, "session-value")
        }
    }

    private func body(_ recorded: CommonGroundURLProtocol.Recorded) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(recorded.body)) as? [String: Any])
    }

    private func freshDefaults() -> UserDefaults {
        let name = "CommonGroundProfileTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    static let profilesJSON = #"""
    {"profiles":[
      {"profileId":"cgp_w","kind":"work","name":"Work","focus":null,"position":0,"hasCard":true,"sharing":true,
       "builtAt":"2026-10-20T09:00:00Z","topicCount":7},
      {"profileId":"cgp_h","kind":"health","name":"Health","focus":"Sleep and running","position":1,"hasCard":true,
       "sharing":true,"builtAt":null,"topicCount":3},
      {"profileId":"cgp_k","kind":"custom","name":"KAUST","position":2}
    ]}
    """#

    func testProfilesDecode() throws {
        let list = try decode(CommonGroundProfileList.self, Self.profilesJSON)
        XCTAssertEqual(list.profiles.map(\.title), ["Work", "Health", "KAUST"])
        XCTAssertEqual(list.profiles[1].focusLine, "Sleep and running")
        XCTAssertEqual(list.profiles[0].buildTitle, "Build your profile")
        XCTAssertEqual(list.profiles[1].buildTitle, "Build your Health profile")
        XCTAssertFalse(list.profiles[2].hasCard)
        XCTAssertEqual(list.profiles[2].topicCount, 0)
        XCTAssertTrue(try decode(CommonGroundProfileList.self, "{}").profiles.isEmpty)

        let person = try decode(CommonGroundPerson.self, #"{"accountId":"acct_n","name":"Nadia","profile":{"profileId":"p1","kind":"health","name":"Health"}}"#)
        XCTAssertEqual(person.labeledName, "Nadia · Health")
        let worker = try decode(CommonGroundPerson.self, #"{"accountId":"acct_n","name":"Nadia","profile":{"profileId":"p2","kind":"work","name":"Work"}}"#)
        XCTAssertEqual(worker.labeledName, "Nadia")
        XCTAssertEqual(try decode(CommonGroundPerson.self, #"{"accountId":"acct_n","name":"Nadia"}"#).labeledName, "Nadia")

        let room = try decode(CommonGroundRoom.self, #"{"code":"4821","kind":"health","profileId":"cgp_h","members":[]}"#)
        XCTAssertEqual(room.kind, "health")
        XCTAssertEqual(room.profileId, "cgp_h")
        let summary = try decode(CommonGroundRoomList.self, #"{"rooms":[{"code":"4821","kind":"daily","profileId":"cgp_d"}]}"#).rooms[0]
        XCTAssertEqual(summary.profileId, "cgp_d")

        let recent = try decode(CommonGroundPeopleResponse<CommonGroundRecentEntry>.self, #"""
        {"people":[{"person":{"accountId":"acct_n","name":"Nadia","profile":{"profileId":"p1","kind":"health","name":"Health"}},"profileId":"cgp_h","score":70},
                   {"person":{"accountId":"acct_n","name":"Nadia","profile":{"profileId":"p2","kind":"work","name":"Work"}},"profileId":"cgp_w","score":60}]}
        """#).people
        XCTAssertEqual(Set(recent.map(\.id)).count, 2, "one entry per person and profile")
        XCTAssertEqual(recent[0].profileId, "cgp_h")

        let owner = try decode(CommonGroundOwnerView.self, #"{"card":null,"sharing":true,"build":{"status":"idle"},"profile":{"profileId":"cgp_h","kind":"health","name":"Health","focus":"Sleep"}}"#)
        XCTAssertEqual(owner.profile?.focus, "Sleep")
    }

    func testCurrentProfilePersistsPerAccount() async throws {
        let defaults = freshDefaults()
        let model = stubbedModel(profiles: true, defaults: defaults)
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, Self.profilesJSON)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, CommonGroundTests.buildingJSON)])

        await model.loadProfiles()
        XCTAssertEqual(model.currentProfileID, "cgp_w", "Work is current by default")
        await model.selectProfile("cgp_h")
        XCTAssertEqual(defaults.string(forKey: CommonGroundProfileChoice.key(account: "acct_a")), "cgp_h")
        let cardCall = try XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path == "/v1/cloud/common-ground/card" })
        XCTAssertEqual(cardCall.request.url?.query, "profile=cgp_h")

        let again = stubbedModel(profiles: true, defaults: defaults, reset: false)
        await again.loadProfiles()
        XCTAssertEqual(again.currentProfileID, "cgp_h")
        XCTAssertEqual(again.shareChoices.map(\.profileId), ["cgp_w", "cgp_h"])
        XCTAssertTrue(again.asksWhichProfile)
        XCTAssertFalse(again.canCreate(.health))
        XCTAssertTrue(again.canCreate(.daily))
        XCTAssertTrue(again.canCreate(.custom))

        let list = try decode(CommonGroundProfileList.self, Self.profilesJSON).profiles
        XCTAssertEqual(CommonGroundProfileChoice.current(saved: "gone", in: list), "cgp_w")
        XCTAssertEqual(CommonGroundProfileChoice.current(saved: nil, in: Array(list.dropFirst())), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: "health", current: "cgp_w", in: list), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: nil, current: "cgp_w", in: list), "cgp_w")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: "daily", current: "cgp_k", in: Array(list.prefix(2))), "cgp_w")
    }

    func testProfileRequestBodies() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, Self.profilesJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/card/build", [(202, CommonGroundTests.buildingJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms/4821/join", [(200, #"{"code":"4821","kind":"health","profileId":"cgp_h"}"#)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms/4821/profile", [(200, #"{"code":"4821","kind":"health","profileId":"cgp_w"}"#)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/profiles", [(201, #"{"profileId":"cgp_d","kind":"daily","name":"Daily","position":3}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, CommonGroundTests.buildingJSON)])
        await model.loadProfiles()
        await model.selectProfile("cgp_h")

        await model.build(CommonGroundBuildRequest(memory: false, connectors: false, device: [], links: "", notes: "Running"))
        let build = try XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path == "/v1/cloud/common-ground/card/build" })
        XCTAssertEqual(try body(build)["profileId"] as? String, "cgp_h")

        let request = model.joinRequest(profileId: "cgp_h", roomName: " Run club ")
        let joined = await model.joinRoom("4821", request: request)
        XCTAssertTrue(joined)
        let join = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path.hasSuffix("/join") == true }))
        XCTAssertEqual(join["profileId"] as? String, "cgp_h")
        XCTAssertEqual(join["kind"] as? String, "health")
        XCTAssertEqual(join["name"] as? String, "Run club")
        XCTAssertEqual(model.sharingLine(inRoom: "4821"), "Sharing: Health")

        let switchedOK = await model.switchRoomProfile("4821", to: "cgp_w")
        XCTAssertTrue(switchedOK)
        let switched = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path.hasSuffix("/profile") == true }))
        XCTAssertEqual(switched["profileId"] as? String, "cgp_w")
        XCTAssertEqual(model.sharingLine(inRoom: "4821"), "Sharing: Work")
        XCTAssertNil(model.results["4821"])

        let created = await model.createProfile(CommonGroundNewProfile(kind: .daily, name: "ignored", focus: "  Errands "))
        XCTAssertEqual(created?.profileId, "cgp_d")
        XCTAssertEqual(model.currentProfileID, "cgp_d")
        let create = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.httpMethod == "POST" && $0.request.url?.path == "/v1/cloud/common-ground/profiles" }))
        XCTAssertEqual(create["kind"] as? String, "daily")
        XCTAssertNil(create["name"], "a fixed kind sends no name")
        XCTAssertEqual(create["focus"] as? String, "Errands")
        XCTAssertFalse(CommonGroundNewProfile(kind: .custom, name: "  ").isValid)
        XCTAssertEqual(CommonGroundNewProfile(kind: .custom, name: " KAUST ").name, "KAUST")

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/profiles", [(409, #"{"errorCode":"common_ground_profile_exists","message":"x"}"#)])
        let refused = await model.createProfile(CommonGroundNewProfile(kind: .daily))
        XCTAssertNil(refused)
        XCTAssertEqual(model.notice, "You already have this profile.")
    }

    func testVersionOneKeepsTodaysRequests() async throws {
        let v1 = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":[],"commonGroundVersion":1}"#)
        let v2 = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":[],"commonGroundVersion":2}"#)
        XCTAssertFalse(CommonGroundAvailability.hasProfiles(capabilities: v1))
        XCTAssertTrue(CommonGroundAvailability.hasProfiles(capabilities: v2))
        XCTAssertTrue(CommonGroundAvailability.isEnabled(signedIn: true, capabilities: v2))

        let model = stubbedModel()
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, CommonGroundTests.ownerJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/card/build", [(202, CommonGroundTests.buildingJSON)])
        await model.loadHome()
        XCTAssertFalse(CommonGroundURLProtocol.paths.contains { $0.hasSuffix("/profiles") })
        XCTAssertNil(CommonGroundURLProtocol.requests.first?.request.url?.query)
        XCTAssertNil(model.currentProfile)
        XCTAssertFalse(model.asksWhichProfile)
        XCTAssertEqual(model.buildTitle, "Build your profile")
        XCTAssertEqual(model.joinRequest(profileId: "cgp_h", roomName: "Club"), CommonGroundJoinRequest())
        XCTAssertNil(model.sharingLine(inRoom: "4821"))

        await model.build(CommonGroundBuildRequest(memory: false, connectors: false, device: [], links: "", notes: "Agents"))
        let build = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path.hasSuffix("/build") == true }))
        XCTAssertNil(build["profileId"])
        let joinBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(CommonGroundJoinRequest())) as? [String: Any])
        XCTAssertTrue(joinBody.isEmpty)
    }
}
