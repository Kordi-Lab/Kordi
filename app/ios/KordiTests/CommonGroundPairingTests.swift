import XCTest
@testable import Kordi

@MainActor
final class CommonGroundPairingTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17082")!

    // Wire shapes from bridges/cloud-server/src/common_ground/pairing.rs.
    static let codeJSON = #"{"code":"K4M7-2QXA","expiresAt":"2026-10-21T10:02:00.123456Z","profileId":"p_work"}"#
    static let redeemJSON = #"""
    {
      "person": {"accountId": "acct_b", "name": "Priya", "avatarUrl": null,
                 "profile": {"profileId": "p_b", "kind": "work", "name": "Work", "design": null, "icon": null}},
      "profileId": "p_work",
      "relationship": {"contact": false, "request": null},
      "card": {"workingOn": ["Agent memory"], "interests": [], "canHelp": ["Rust"], "lookingFor": []}
    }
    """#

    // MARK: Wire

    /// Four typed digits turn Create a code into Enter pair room; clearing them brings it back.
    func testPairCodeLinkEntersOnceFourDigitsAreTyped() {
        XCTAssertEqual(CommonGroundPairCodeRow.linkTitle(for: ""), "Create a code")
        XCTAssertEqual(CommonGroundPairCodeRow.linkTitle(for: "516"), "Create a code")
        XCTAssertEqual(CommonGroundPairCodeRow.linkTitle(for: "5160"), "Enter pair room")
    }

    func testPairCodeAndRedeemDecode() throws {
        let code = try JSONDecoder().decode(CommonGroundPairCode.self, from: Data(Self.codeJSON.utf8))
        XCTAssertEqual(code.code, "K4M7-2QXA")
        XCTAssertNotNil(code.expiry)

        let card = try JSONDecoder().decode(CommonGroundPersonCard.self, from: Data(Self.redeemJSON.utf8))
        XCTAssertEqual(card.person.accountId, "acct_b")
        XCTAssertEqual(card.person.profile?.profileId, "p_b")
        XCTAssertEqual(card.profileId, "p_work")
        XCTAssertEqual(card.card.canHelp, ["Rust"])
    }

    func testCodeAndRedeemSendTheSelectedCard() async throws {
        let model = stubbedModel()
        model.currentProfileID = "p_work"
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/code", [(201, Self.codeJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/redeem", [(200, Self.redeemJSON)])

        guard case .success(let code) = await model.newPairCode() else { return XCTFail("no code") }
        XCTAssertEqual(code.code, "K4M7-2QXA")
        guard case .paired(let card) = await model.redeemPairCode("c4m7 2qxb", ownCode: code.code) else { return XCTFail("not paired") }
        XCTAssertEqual(card.person.name, "Priya")
        XCTAssertEqual(model.people["acct_b"]?.person.accountId, "acct_b")
        XCTAssertEqual(model.viewerProfiles["acct_b"], "p_work")

        let bodies = try CommonGroundURLProtocol.requests.filter { $0.request.httpMethod == "POST" }.map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap($0.body)) as? [String: Any])
        }
        XCTAssertEqual(bodies.first?["profileId"] as? String, "p_work")
        XCTAssertEqual(bodies.last?["code"] as? String, "c4m7 2qxb")
        XCTAssertEqual(bodies.last?["profileId"] as? String, "p_work")
    }

    func testRedeemRefusesYourOwnCodeAndMapsErrors() async {
        let model = stubbedModel()
        guard case .failed(let own) = await model.redeemPairCode("K4M7-2QXA", ownCode: "k4m72qxa") else { return XCTFail("own code") }
        XCTAssertEqual(own, CommonGroundPairCopy.yourself)
        XCTAssertTrue(CommonGroundURLProtocol.requests.isEmpty)

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/redeem", [
            (404, #"{"errorCode":"common_ground_code_not_found","message":"Code not found or expired."}"#),
        ])
        guard case .codeGone = await model.redeemPairCode("AAAA-BBBB") else { return XCTFail("gone") }

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/code", [
            (409, #"{"errorCode":"common_ground_sharing_off","message":"Turn on sharing to meet people."}"#),
        ])
        guard case .failure(let problem) = await model.newPairCode() else { return XCTFail("sharing") }
        XCTAssertEqual(problem, .sharingOff)
        let noCard = CloudAPIError(code: "common_ground_no_card", message: "Build your card first.", statusCode: 409)
        XCTAssertEqual(CommonGroundModel.pairError(noCard), .noCard)
        let gone = CloudAPIError(code: "common_ground_code_not_found", message: "", statusCode: 404)
        XCTAssertEqual(CommonGroundModel.pairError(gone).message, "That code expired. Ask for a new one.")
    }

    // MARK: Links

    func testPairLinkParser() throws {
        func parse(_ text: String) -> String? { URL(string: text).flatMap(CommonGroundPairLink.parse)?.code }
        XCTAssertEqual(parse("kordi://common-ground/pair/K4M7-2QXA"), "K4M7-2QXA")
        XCTAssertEqual(parse("kordi://common-ground/pair/k4m72qxa"), "K4M7-2QXA")
        XCTAssertEqual(parse("kordi-beta://common-ground/pair/K4M7-2QXA/"), "K4M7-2QXA")
        XCTAssertEqual(parse("kordi://common-ground/pair/OIL7-2QXA"), "0117-2QXA")
        XCTAssertNil(parse("kordi://common-ground/room/4821"))
        XCTAssertNil(parse("kordi://common-ground/pair/K4M7"))
        XCTAssertNil(parse("kordi://settings/pair/K4M7-2QXA"))
        XCTAssertNil(parse("https://common-ground/pair/K4M7-2QXA"))
        XCTAssertNil(parse("kordi://common-ground/pair/K4M7-2QXA/extra"))

        XCTAssertEqual(CommonGroundPairCodeText.link("k4m72qxa"), "kordi://common-ground/pair/K4M7-2QXA")
        XCTAssertEqual(CommonGroundPairCodeText.parse(" kordi://common-ground/pair/K4M7-2QXA "), "K4M7-2QXA")
        XCTAssertEqual(CommonGroundPairCodeText.parse("k4m7 2qxa"), "K4M7-2QXA")
        XCTAssertNil(CommonGroundPairCodeText.parse("hello"))
    }

    // MARK: Proximity

    func testRangingOnlyWhenBothPhonesSupportIt() {
        XCTAssertEqual(CommonGroundProximity.mode(localSupportsRanging: true, peerSupportsRanging: true), .distance)
        XCTAssertEqual(CommonGroundProximity.mode(localSupportsRanging: true, peerSupportsRanging: false), .discovery)
        XCTAssertEqual(CommonGroundProximity.mode(localSupportsRanging: false, peerSupportsRanging: true), .discovery)
        XCTAssertTrue(CommonGroundProximity.isNear(0.2))
        XCTAssertFalse(CommonGroundProximity.isNear(0.3))
        XCTAssertFalse(CommonGroundProximity.isNear(nil))
    }

    // MARK: Exchange

    private final class Harness {
        var sent: [CommonGroundPairMessage] = []
        var redeemed: [String] = []
        var matched: [CommonGroundPersonCard] = []
        var errors: [String] = []
        var outcomes: [CommonGroundRedeemOutcome] = []

        var codesSent: [String] { sent.compactMap { $0.kind == .code ? $0.code : nil } }
    }

    private func exchange(ranging: Bool = false, peerWait: Duration = .seconds(60)) throws -> (CommonGroundPairingExchange, Harness) {
        let harness = Harness()
        let card = try JSONDecoder().decode(CommonGroundPersonCard.self, from: Data(Self.redeemJSON.utf8))
        let exchange = CommonGroundPairingExchange(me: "acct_a", localRanging: ranging, peerWait: peerWait) { code in
            harness.redeemed.append(code)
            return harness.outcomes.isEmpty ? .paired(card) : harness.outcomes.removeFirst()
        }
        exchange.send = { message, _ in harness.sent.append(message) }
        exchange.token = { Data([1, 2, 3]) }
        exchange.onMatch = { harness.matched.append($0) }
        exchange.onError = { harness.errors.append($0) }
        exchange.setCode("AAAA-BBBB", expiry: Date().addingTimeInterval(120))
        return (exchange, harness)
    }

    private func settle(until condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    func testExchangeRedeemsOnceThenOpensTheMatch() async throws {
        let (exchange, harness) = try exchange()
        exchange.connected("peer")
        XCTAssertEqual(harness.sent.first?.kind, .hello)
        XCTAssertTrue(harness.codesSent.isEmpty)

        exchange.receive(.hello(ranging: false, account: "acct_b"), from: "peer")
        XCTAssertEqual(harness.codesSent, ["AAAA-BBBB"])
        exchange.receive(.code("AAAA-BBBB"), from: "peer") // our own code echoed: ignored
        exchange.receive(.code("cccc-dddd"), from: "peer")
        exchange.receive(.code("CCCC-DDDD"), from: "peer")
        exchange.connected("other")
        exchange.receive(.code("EEEE-FFFF"), from: "other") // a second phone: ignored
        await settle { harness.sent.contains { $0.kind == .paired } }

        XCTAssertEqual(harness.redeemed, ["CCCC-DDDD"])
        XCTAssertTrue(harness.sent.contains { $0.kind == .paired })
        XCTAssertTrue(harness.matched.isEmpty, "waits for the other phone")
        exchange.receive(.paired, from: "peer")
        exchange.receive(.paired, from: "peer")
        XCTAssertEqual(harness.matched.map(\.person.accountId), ["acct_b"])
        XCTAssertTrue(exchange.finished)
        XCTAssertFalse(exchange.needsRefresh())
    }

    func testExchangeOpensTheMatchWhenThePeerNeverConfirms() async throws {
        let (exchange, harness) = try exchange(peerWait: .milliseconds(10))
        exchange.connected("peer")
        exchange.receive(.hello(ranging: false, account: "acct_b"), from: "peer")
        exchange.receive(.code("CCCC-DDDD"), from: "peer")
        await settle { !harness.matched.isEmpty }
        XCTAssertEqual(harness.matched.count, 1)
    }

    func testExchangeRefreshesTheCodeAndRetriesAReplacedOne() async throws {
        let (exchange, harness) = try exchange()
        let now = Date()
        XCTAssertFalse(exchange.needsRefresh(now: now))
        XCTAssertTrue(exchange.needsRefresh(now: now.addingTimeInterval(110)))

        exchange.connected("peer")
        exchange.receive(.hello(ranging: false, account: "acct_b"), from: "peer")
        exchange.setCode("GGGG-HHHH", expiry: now.addingTimeInterval(240))
        exchange.setCode("GGGG-HHHH", expiry: now.addingTimeInterval(240))
        XCTAssertEqual(harness.codesSent, ["AAAA-BBBB", "GGGG-HHHH"])
        XCTAssertFalse(exchange.needsRefresh(now: now.addingTimeInterval(110)))

        harness.outcomes = [.codeGone]
        exchange.receive(.code("CCCC-DDDD"), from: "peer")
        await settle { harness.redeemed.count == 1 }
        exchange.receive(.code("JJJJ-KKKK"), from: "peer")
        await settle { harness.redeemed.count == 2 }
        XCTAssertEqual(harness.redeemed, ["CCCC-DDDD", "JJJJ-KKKK"])
        XCTAssertTrue(harness.errors.isEmpty)
    }

    func testExchangeWaitsForDistanceWhenBothPhonesRange() async throws {
        let (exchange, harness) = try exchange(ranging: true)
        var tokens: [Data] = []
        exchange.onPeerToken = { data, _ in tokens.append(data) }
        exchange.connected("peer")
        exchange.receive(.hello(ranging: true, account: "acct_b"), from: "peer")
        XCTAssertTrue(harness.sent.contains { $0.kind == .token })
        exchange.receive(.token(Data([9])), from: "peer")
        XCTAssertEqual(tokens, [Data([9])])
        XCTAssertTrue(harness.codesSent.isEmpty)

        exchange.distance(0.8, peer: "peer")
        exchange.receive(.code("CCCC-DDDD"), from: "peer")
        XCTAssertTrue(harness.codesSent.isEmpty)
        XCTAssertTrue(harness.redeemed.isEmpty)

        exchange.distance(0.2, peer: "peer")
        XCTAssertEqual(harness.codesSent, ["AAAA-BBBB"])
        await settle { harness.redeemed.count == 1 }
        XCTAssertEqual(harness.redeemed, ["CCCC-DDDD"])
    }

    func testExchangeFallsBackToDiscoveryWhenRangingStops() throws {
        let (exchange, harness) = try exchange(ranging: true)
        exchange.connected("peer")
        exchange.receive(.hello(ranging: true, account: "acct_b"), from: "peer")
        XCTAssertTrue(harness.codesSent.isEmpty)
        exchange.setLocalRanging(false)
        XCTAssertEqual(harness.codesSent, ["AAAA-BBBB"])
        XCTAssertEqual(harness.sent.filter { $0.kind == .hello }.last?.ranging, false)
    }

    func testExchangeRefusesYourOwnAccount() throws {
        let (exchange, harness) = try exchange()
        exchange.connected("peer")
        exchange.receive(.hello(ranging: false, account: "acct_a"), from: "peer")
        exchange.receive(.code("CCCC-DDDD"), from: "peer")
        XCTAssertEqual(harness.errors, [CommonGroundPairCopy.yourself])
        XCTAssertTrue(harness.codesSent.isEmpty)
        XCTAssertTrue(harness.redeemed.isEmpty)
    }

    func testCodeOwnerOpensMatchAfterRemoteScanWithoutRadio() async {
        let model = stubbedModel()
        model.currentProfileID = "p_work"
        let freshCode = Self.codeJSON.replacingOccurrences(of: "2026-10-21T10:02:00.123456Z",
            with: ISO8601DateFormatter().string(from: Date().addingTimeInterval(120)))
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/code", [(201, freshCode)])
        let completed = "{\"status\":\"paired\",\"person\":" + Self.redeemJSON + "}"
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/status", [
            (200, #"{"status":"waiting"}"#), (200, completed),
        ])
        let controller = CommonGroundTapController(pollInterval: .milliseconds(5))
        var opened: [CommonGroundPersonCard] = []
        controller.start(model: model, onMatch: { opened.append($0) }, onProblem: { _ in XCTFail("unexpected prerequisite") })
        await settle { !opened.isEmpty }
        XCTAssertEqual(opened.map(\.person.accountId), ["acct_b"])
        XCTAssertEqual(model.viewerProfiles["acct_b"], "p_work")
        XCTAssertEqual(model.people["acct_b"]?.card.canHelp, ["Rust"])
        let checks = CommonGroundURLProtocol.requests.filter { $0.request.url?.path.hasSuffix("pairings/status") == true }
        XCTAssertEqual(checks.count, 2)
        controller.stop()
    }

    func testWaitingOrExpiredCodeDoesNotOpenAnOldPairing() async {
        let model = stubbedModel()
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/pairings/status", [
            (200, #"{"status":"waiting"}"#), (200, #"{"status":"expired"}"#),
        ])
        let waiting = await model.completedPairCode("AAAA-BBBB")
        let expired = await model.completedPairCode("AAAA-BBBB")
        XCTAssertNil(waiting)
        XCTAssertNil(expired)
        XCTAssertTrue(model.people.isEmpty)
    }

    // MARK: Model

    private func stubbedModel() -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        return CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex"), profilesEnabled: true) { (api, "session-value") }
    }
}
