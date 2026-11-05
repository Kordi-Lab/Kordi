import XCTest
@testable import Kordi

final class UsageLimitsTests: XCTestCase {
    private let resetsAt = "2026-11-05T00:00:00Z"

    private func snapshot(_ percent: Int, reached: String = "none", pausedSince: String? = nil) -> CloudUsageSnapshot {
        CloudUsageSnapshot(limitId: "pool.runs", scope: "pool", usedPercent: percent, resetsAt: resetsAt,
                           reached: reached, pausedSince: pausedSince)
    }

    func testAccountUsageDecodesWithoutOptionalFields() throws {
        let usage = try JSONDecoder().decode(CloudAccountUsage.self, from: Data(#"""
        {"organizations":[{"organizationId":"org_1","name":"Personal","kind":"personal","role":"member",
         "snapshots":[{"limitId":"pool.runs","scope":"pool","usedPercent":70,"window":"day","resetsAt":"2026-11-05T00:00:00Z","reached":"none"}]},
         {"organizationId":"org_2","name":"Team","kind":"team","role":"owner","snapshots":[]}]}
        """#.utf8))
        XCTAssertEqual(usage.organizations.map(\.name), ["Personal", "Team"])
        let runs = try XCTUnwrap(usage.organizations.first?.snapshots.first)
        XCTAssertNil(runs.used)
        XCTAssertNil(runs.limit)
        XCTAssertNil(runs.conversationId)
        XCTAssertNil(runs.pausedSince)
        XCTAssertEqual(UsagePresentation.value(runs), "70%")
        XCTAssertEqual(UsagePresentation.status(runs, role: "member"), "Resets at 00:00 UTC")
        XCTAssertTrue(usage.organizations[1].snapshots.isEmpty)
    }

    func testSnapshotDecodesNewOptionalFields() throws {
        let snapshot = try JSONDecoder().decode(CloudUsageSnapshot.self, from: Data(#"""
        {"limitId":"conversation.system_agent_runs","scope":"conversation","used":20,"limit":20,"usedPercent":100,"window":"day",
         "resetsAt":"2026-11-05T00:00:00Z","reached":"daily_limit","conversationId":"conv_1","pausedSince":"2026-11-04T14:20:00Z"}
        """#.utf8))
        XCTAssertEqual(snapshot.conversationId, "conv_1")
        XCTAssertEqual(snapshot.pausedSince, "2026-11-04T14:20:00Z")
        XCTAssertEqual(UsagePresentation.label(limitId: snapshot.limitId), "System agent per chat")
        XCTAssertEqual(UsagePresentation.value(snapshot), "20 of 20")
    }

    func testOrganizationUsageDecodes() throws {
        let usage = try JSONDecoder().decode(CloudOrganizationUsage.self, from: Data(#"""
        {"organizationId":"org_1","role":"admin","snapshots":[{"limitId":"pool.spend","scope":"pool","used":400000,"limit":1000000,
         "usedPercent":40,"window":"day","resetsAt":"2026-11-05T00:00:00Z","reached":"none"}]}
        """#.utf8))
        XCTAssertEqual(usage.role, "admin")
        XCTAssertEqual(UsagePresentation.value(usage.snapshots[0]), "0.40 of 1.00")
    }

    func testLevelThresholds() {
        XCTAssertEqual(UsagePresentation.level(snapshot(74)), .normal)
        XCTAssertEqual(UsagePresentation.level(snapshot(75)), .warning)
        XCTAssertEqual(UsagePresentation.level(snapshot(89)), .warning)
        XCTAssertEqual(UsagePresentation.level(snapshot(90)), .critical)
        XCTAssertEqual(UsagePresentation.level(snapshot(10, reached: "daily_limit")), .critical)
    }

    func testLabels() {
        XCTAssertEqual(UsagePresentation.label(limitId: "pool.runs"), "Runs")
        XCTAssertEqual(UsagePresentation.label(limitId: "pool.spend"), "Spend")
        XCTAssertEqual(UsagePresentation.label(limitId: "account.grounding_runs"), "Grounding")
        XCTAssertEqual(UsagePresentation.label(limitId: "pool.stopped"), "System agent")
    }

    func testStatusCopy() {
        let reached = snapshot(100, reached: "spend_limit")
        XCTAssertEqual(UsagePresentation.status(reached, role: "owner"), "Limit reached. Resets at 00:00 UTC.")
        XCTAssertEqual(UsagePresentation.status(reached, role: "admin"), "Limit reached. Resets at 00:00 UTC.")
        let ask = "Limit reached. Resets at 00:00 UTC. Ask an owner to raise it."
        XCTAssertEqual(UsagePresentation.status(reached, role: "member"), ask)
        XCTAssertEqual(UsagePresentation.status(reached, role: nil), ask)

        let paused = snapshot(100, reached: "daily_limit", pausedSince: "2026-11-04T14:20:00Z")
        XCTAssertEqual(UsagePresentation.status(paused, role: "owner"), "Paused since 14:20, resets 00:00 UTC.")
        XCTAssertEqual(UsagePresentation.status(paused, role: "member"),
                       "Paused since 14:20, resets 00:00 UTC. Ask an owner to raise it.")

        XCTAssertEqual(UsagePresentation.status(snapshot(100, reached: "stopped"), role: "member"), "Paused by an owner.")
    }

    func testValueWithAmounts() {
        let runs = CloudUsageSnapshot(limitId: "pool.runs", scope: "pool", used: 7, limit: 10, usedPercent: 70, resetsAt: resetsAt)
        XCTAssertEqual(UsagePresentation.value(runs), "7 of 10")
    }
}
