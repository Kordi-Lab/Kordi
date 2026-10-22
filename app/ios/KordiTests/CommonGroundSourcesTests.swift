import XCTest
@testable import Kordi

/// Card sources (`commonGroundVersion` 3): saved picks, documents, the
/// build request's new fields, and the name and handle on a card.
@MainActor
final class CommonGroundSourcesTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17083")!

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    private func stubbedModel() -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        let name = "CommonGroundSourcesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex"), profilesEnabled: true,
                                 sourcesEnabled: true, defaults: defaults) { (api, "session-value") }
    }

    static let profilesJSON = #"""
    {"profiles":[
      {"profileId":"cgp_w","kind":"work","name":"Work","position":0,"hasCard":true,"sources":null},
      {"profileId":"cgp_h","kind":"health","name":"Health","position":1,"hasCard":true,
       "sources":{"memory":true,"connectors":["gmail","strava"],"device":["calendar"],"agents":true,
                  "documents":["att_1"],"links":"","notes":"Running"}}
    ]}
    """#

    func testVersionThreeGatesSources() throws {
        let v2 = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":[],"commonGroundVersion":2}"#)
        let v3 = try decode(CloudAuthCapabilities.self, #"{"password":true,"oauthProviders":[],"commonGroundVersion":3}"#)
        XCTAssertFalse(CommonGroundAvailability.hasSources(capabilities: v2))
        XCTAssertTrue(CommonGroundAvailability.hasSources(capabilities: v3))
    }

    func testSourcesDecodeAndDocuments() throws {
        let profiles = try decode(CommonGroundProfileList.self, Self.profilesJSON).profiles
        XCTAssertNil(profiles[0].sources)
        let health = try XCTUnwrap(profiles[1].sources)
        XCTAssertTrue(health.memory && health.agents)
        XCTAssertEqual(health.connectorIds, [.gmail])
        XCTAssertEqual(health.deviceSources, [.calendar])
        XCTAssertEqual(try decode(CommonGroundSourcePicks.self, "{}"), CommonGroundSourcePicks())

        let list = try decode(CommonGroundDocumentList.self, #"""
        {"documents":[{"attachmentId":"att_1","title":"Marathon plan","updatedAt":"2026-10-18T09:00:00Z","sizeBytes":120},
                      {"attachmentId":"att_2","title":"","updatedAt":"2025-03-02T09:00:00.120Z","sizeBytes":null}]}
        """#).documents
        XCTAssertEqual(list.map(\.displayTitle), ["Marathon plan", "Untitled"])
        let now = try XCTUnwrap(commonGroundParseDate("2026-10-22T12:00:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        XCTAssertNotNil(list[0].shortDate(now: now, calendar: calendar))
        XCTAssertNotEqual(list[0].shortDate(now: now, calendar: calendar), list[1].shortDate(now: now, calendar: calendar))
        XCTAssertTrue(try decode(CommonGroundDocumentList.self, "{}").documents.isEmpty)
    }

    func testPicksKeepWhatThisScreenCannotChange() {
        let saved = CommonGroundSourcePicks(connectors: ["gmail", "strava"], agents: true)
        let picks = CommonGroundSourcePicks(
            memory: true, connectors: [.slack, .github], device: [.reminders, .calendar],
            documents: (1...10).map { "att_\($0)" }, links: "a.dev", notes: "Notes", keeping: saved
        )
        XCTAssertEqual(picks.connectors, ["github", "slack", "strava"])
        XCTAssertEqual(picks.device, ["calendar", "reminders"])
        XCTAssertTrue(picks.agents, "an iPhone build keeps the Mac's Agents pick")
        XCTAssertEqual(picks.documents.count, CommonGroundSourcePicks.maxDocuments)
    }

    func testVersionThreeRequestSendsEveryPick() throws {
        let picks = CommonGroundSourcePicks(memory: true, connectors: ["gmail"], agents: true, documents: ["att_1"])
        var choices = CommonGroundBuildChoices(memoryOn: true, memoryCount: 0, documents: ["att_1"], sendsSources: true, picks: picks)
        XCTAssertTrue(choices.canBuild, "a document alone is enough")
        let body = try json(choices.request)
        XCTAssertEqual(body["documents"] as? [String], ["att_1"])
        XCTAssertEqual(body["connectorProviders"] as? [String], [])
        let sent = try XCTUnwrap(body["picks"] as? [String: Any])
        XCTAssertEqual(sent["agents"] as? Bool, true)
        XCTAssertEqual(sent["connectors"] as? [String], ["gmail"])
        XCTAssertEqual(sent["links"] as? String, "")

        choices.documents = []
        XCTAssertFalse(choices.canBuild)
        choices.connectors = [.gmail]
        XCTAssertEqual(try json(choices.request)["connectorProviders"] as? [String], ["gmail"])
    }

    func testSourcesSaveAndBuildRemembersPicks() async throws {
        let model = stubbedModel()
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, Self.profilesJSON)])
        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_w", [(200, #"""
        {"profileId":"cgp_w","kind":"work","name":"Work","position":0,"hasCard":true,
         "sources":{"memory":true,"connectors":[],"device":[],"agents":false,"documents":[],"links":"","notes":""}}
        """#)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/card/build", [(202, CommonGroundTests.buildingJSON)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/documents", [(200, #"{"documents":[{"attachmentId":"att_1","title":"Plan"}]}"#)])
        await model.loadProfiles()
        XCTAssertEqual(model.currentProfileID, "cgp_w")

        await model.saveSources(CommonGroundSourcePicks(), for: "cgp_w")
        XCTAssertFalse(CommonGroundURLProtocol.paths.contains("PUT /v1/cloud/common-ground/profiles/cgp_w"), "nothing to save")

        await model.saveSources(CommonGroundSourcePicks(memory: true), for: "cgp_w")
        let put = try XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.httpMethod == "PUT" })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(put.body)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["sources"])
        XCTAssertEqual(model.currentSources?.memory, true)

        let picks = CommonGroundSourcePicks(notes: "Rust")
        var request = CommonGroundBuildRequest(memory: false, connectors: false, device: [], links: "", notes: "Rust")
        request.picks = picks
        await model.build(request)
        XCTAssertEqual(model.currentSources, picks)

        let documents = await model.loadDocuments()
        XCTAssertEqual(documents?.map(\.attachmentId), ["att_1"])
    }

    func testProfileEditEncodesSources() throws {
        XCTAssertNil(try json(CommonGroundProfileEdit(name: "Work"))["sources"])
        XCTAssertTrue(try json(CommonGroundProfileEdit(sources: .some(nil)))["sources"] is NSNull)
    }

    func testCardOwner() throws {
        let person = try decode(CommonGroundPerson.self, #"{"accountId":"acct_n","name":"Nadia","handle":"nadia"}"#)
        XCTAssertEqual(person.cardOwner.handleLine, "@nadia")
        XCTAssertNil(try decode(CommonGroundPerson.self, #"{"accountId":"acct_n","name":"Nadia"}"#).cardOwner.handleLine)
        XCTAssertEqual(CommonGroundCardOwner(name: " Shu Yang ", handle: "@shuyang").handleLine, "@shuyang")
        XCTAssertEqual(CommonGroundCardOwner(name: " Shu Yang ").name, "Shu Yang")
        XCTAssertNil(CommonGroundCardOwner(name: "A", handle: " ").handleLine)
    }
}
