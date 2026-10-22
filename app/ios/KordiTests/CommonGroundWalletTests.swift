import XCTest
@testable import Kordi

/// The wallet: creating a code for a meetup, the room's suggested card, the
/// New card availability rule and each card's design.
@MainActor
final class CommonGroundWalletTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17082")!

    private func freshDefaults() -> UserDefaults {
        let name = "CommonGroundWalletTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func stubbedModel(profiles: Bool, defaults: UserDefaults) -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
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

    private var profiles: [CommonGroundProfileSummary] {
        get throws { try JSONDecoder().decode(CommonGroundProfileList.self, from: Data(CommonGroundProfileTests.profilesJSON.utf8)).profiles }
    }

    // MARK: Create a code

    func testCreateCodeRequestAndResponse() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, CommonGroundProfileTests.profilesJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms", [(201, #"""
        {"code":"7319","name":"Agents meetup","openedByYou":true,"open":true,"members":[],"kind":"health","profileId":"cgp_h"}
        """#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms", [(200, #"""
        {"rooms":[{"code":"3907","name":"Lab lunch","memberCount":5},{"code":"7319","name":"Agents meetup","memberCount":1,"kind":"health","profileId":"cgp_h"}]}
        """#)])
        await model.loadProfiles()

        let room = await model.createRoom(name: "  Agents meetup ", profileId: "cgp_h")
        XCTAssertEqual(room?.code, "7319")
        XCTAssertEqual(room?.title, "Agents meetup")
        XCTAssertEqual(room?.openedByYou, true)
        XCTAssertEqual(room?.profileId, "cgp_h")

        let sent = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last {
            $0.request.httpMethod == "POST" && $0.request.url?.path == "/v1/cloud/common-ground/rooms"
        }))
        XCTAssertEqual(sent["name"] as? String, "Agents meetup")
        XCTAssertEqual(sent["kind"] as? String, "health", "the kind is the chosen card's")
        XCTAssertEqual(sent["profileId"] as? String, "cgp_h")
        XCTAssertEqual(model.roomList?.first?.code, "7319", "the new room is at the top of Rooms")
        XCTAssertEqual(model.sharingLine(inRoom: "7319"), "Sharing: Health")

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms", [(429, #"{"errorCode":"rate_limited","message":"x"}"#)])
        let refused = await model.createRoom(name: "Again", profileId: "cgp_w")
        XCTAssertNil(refused)
        XCTAssertEqual(model.notice, "Try again in 1 min.")
        let blank = await model.createRoom(name: "   ", profileId: "cgp_w")
        XCTAssertNil(blank, "a meetup needs a name")
    }

    func testCreateCodeBeforeProfilesSendsOnlyTheName() throws {
        let model = stubbedModel(profiles: false, defaults: freshDefaults())
        let request = model.createRoomRequest(name: " Poster session ", profileId: "cgp_w")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(json["name"] as? String, "Poster session")
        XCTAssertNil(json["kind"])
        XCTAssertNil(json["profileId"])
    }

    // MARK: Suggested card

    func testRoomSuggestsItsKindsCard() throws {
        let built = try profiles.filter(\.hasCard)
        XCTAssertEqual(CommonGroundProfileChoice.suggested(roomKind: "health", in: built), "cgp_h")
        XCTAssertNil(CommonGroundProfileChoice.suggested(roomKind: "daily", in: built), "no card of that kind")
        XCTAssertNil(CommonGroundProfileChoice.suggested(roomKind: nil, in: built), "an unknown room suggests nothing")
        XCTAssertNil(CommonGroundProfileChoice.suggested(roomKind: "custom", in: built), "only cards with a card count")

        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: "health", current: "cgp_w", in: built), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: nil, current: "cgp_h", in: built), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: "daily", current: "cgp_k", in: built), "cgp_w")
    }

    // MARK: New card

    func testNewCardAvailability() throws {
        let wallet = try profiles
        XCTAssertFalse(CommonGroundCardDesign.isAvailable(.work, in: wallet), "Work is in the wallet")
        XCTAssertFalse(CommonGroundCardDesign.isAvailable(.health, in: wallet))
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.daily, in: wallet))
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.workshop, in: wallet), "custom designs repeat")
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.research, in: wallet))
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.custom, in: wallet))
        XCTAssertEqual(CommonGroundCardDesign.firstAvailable(in: wallet), .daily)
        XCTAssertEqual(CommonGroundCardDesign.firstAvailable(in: []), .work)

        XCTAssertEqual(CommonGroundCardDesign.workshop.kind, .custom)
        XCTAssertEqual(CommonGroundCardDesign.research.kind, .custom)
        XCTAssertEqual(CommonGroundCardDesign.workshop.defaultName, "Workshop")
        XCTAssertEqual(CommonGroundCardDesign.research.defaultName, "Research group")
        XCTAssertEqual(CommonGroundCardDesign.daily.defaultName, "")
    }

    func testNewCardKeepsItsDesign() async throws {
        let defaults = freshDefaults()
        let model = stubbedModel(profiles: true, defaults: defaults)
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/profiles", [(201, #"{"profileId":"cgp_m","kind":"custom","name":"MIT","position":3}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, CommonGroundTests.buildingJSON)])

        let created = await model.createCard(.workshop, name: " MIT ", focus: "")
        XCTAssertEqual(created?.profileId, "cgp_m")
        let sent = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.httpMethod == "POST" }))
        XCTAssertEqual(sent["kind"] as? String, "custom")
        XCTAssertEqual(sent["name"] as? String, "MIT")
        XCTAssertEqual(model.design(ofProfile: "cgp_m"), .workshop, "the design made on this device wins over the name")
    }

    func testDesignFollowsKindThenSavedThenName() {
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "work", name: "Lab", saved: .custom), .work)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "health", name: ""), .health)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "daily", name: ""), .daily)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "KAUST", saved: .research), .research)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Poster workshop"), .workshop)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Vision research group"), .research)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Board games"), .custom)
    }
}
