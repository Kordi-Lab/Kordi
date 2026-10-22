import XCTest
@testable import Kordi

/// `commonGround.match` on the contact profile.
final class ContactProfileMatchTests: XCTestCase {
    private let subject = ContactProfileSubject(accountId: "acct_nadia", name: "Nadia")

    private func decode(commonGround: String) throws -> CloudContactProfile {
        let json = #"{"accountId":"acct_nadia","kind":"person","commonGround":"# + commonGround + "}"
        return try JSONDecoder().decode(CloudContactProfile.self, from: Data(json.utf8))
    }

    func testDecodesTheMatch() throws {
        let profile = try decode(commonGround: #"""
        {"workingOn":["tabletop manipulation"],"canHelp":[],"lookingFor":[],
         "match":{"score":82,"headline":"Both on robot learning.",
          "shared":[{"topic":"Agent memory","theirTopic":"Long-term memory","why":"Same problem."}],
          "youBring":[{"topic":"Data pipelines","for":"robot datasets","why":"You run one."}],
          "theyBring":[{"topic":"Grant writing","for":"Lab funding","why":"Three grants."}],
          "nextStep":"Ask about her scenes.",
          "yourProfile":{"profileId":"p1","kind":"work","name":"","design":"work","icon":null},
          "theirProfile":{"profileId":"p2","kind":"custom","name":"Robotics lab","design":"ocean","icon":"flask"},
          "updatedAt":"2026-10-21T08:00:00Z"}}
        """#)
        let match = try XCTUnwrap(profile.commonGround?.match)
        XCTAssertEqual(match.score, 82)
        XCTAssertEqual(match.headline, "Both on robot learning.")
        XCTAssertEqual(match.shared.first?.topic, "Agent memory")
        XCTAssertEqual(match.shared.first?.theirTopic, "Long-term memory")
        XCTAssertEqual(match.youBring.first?.target, "robot datasets")
        XCTAssertEqual(match.theyBring.first?.topic, "Grant writing")
        XCTAssertEqual(match.nextStep, "Ask about her scenes.")
        XCTAssertEqual(match.yourProfile?.title, "Work")
        XCTAssertEqual(match.theirProfile?.title, "Robotics lab")
        XCTAssertEqual(match.theirProfile?.cardDesign, .ocean)
        XCTAssertEqual(match.theirProfile?.cardIcon, .flask)
        XCTAssertEqual(match.updatedAt, "2026-10-21T08:00:00Z")
        XCTAssertEqual(profile.commonGround?.workingOn, ["tabletop manipulation"])
    }

    func testDecodesWithoutAMatch() throws {
        let missing = try decode(commonGround: #"{"workingOn":["sim-to-real"]}"#)
        XCTAssertNil(missing.commonGround?.match)
        XCTAssertEqual(missing.commonGround?.workingOn, ["sim-to-real"])

        let null = try decode(commonGround: #"{"workingOn":["sim-to-real"],"match":null}"#)
        XCTAssertNil(null.commonGround?.match)
        XCTAssertNotNil(ContactProfilePresentation(subject: subject, profile: null, isFallback: false).commonGround)
    }

    func testMatchWithoutAScoreIsDroppedAndTheTopicsStay() throws {
        let profile = try decode(commonGround: #"{"canHelp":["grant writing"],"match":{"headline":"No score","shared":[]}}"#)
        XCTAssertNil(profile.commonGround?.match)
        XCTAssertEqual(profile.commonGround?.canHelp, ["grant writing"])
    }

    func testMissingOptionalFieldsAndBadItems() throws {
        let profile = try decode(commonGround: #"""
        {"match":{"score":140,
          "shared":[{"topic":"Agent memory"},{"why":"no topic"},"bogus",
                    {"topic":"A"},{"topic":"B"},{"topic":"C"},{"topic":"D"}],
          "theyBring":[{"topic":"Grant writing"}],
          "theirProfile":"bogus"}}
        """#)
        let ground = try XCTUnwrap(profile.commonGround)
        let match = try XCTUnwrap(ground.match)
        XCTAssertEqual(match.score, 100)
        XCTAssertNil(match.headline)
        XCTAssertNil(match.nextStep)
        XCTAssertNil(match.theirProfile)
        XCTAssertEqual(match.shared.map(\.topic), ["Agent memory", "A", "B", "C", "D"])
        XCTAssertEqual(match.shared.first?.theirTopic, "Agent memory")
        XCTAssertEqual(match.youBring, [])
        XCTAssertEqual(match.theyBring.first?.target, "")
        // A match alone still shows the section.
        XCTAssertFalse(ground.hasTopics)
        XCTAssertFalse(ground.isEmpty)
        XCTAssertNotNil(ContactProfilePresentation(subject: subject, profile: profile, isFallback: false).commonGround)
    }
}
