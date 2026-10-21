import XCTest
@testable import Kordi

final class AgentTurnSegmentTests: XCTestCase {
    func testCommentarySeparatesAdjacentToolGroupsAfterDecoding() throws {
        let data = Data(#"[{"id":"a","kind":"text","text":"Inspecting the example."},{"id":"t1","kind":"tool","toolId":"one"},{"id":"t2","kind":"tool","toolId":"two"},{"id":"b","kind":"text","text":"Found a change."},{"id":"t3","kind":"tool","toolId":"three"},{"id":"c","kind":"text","text":"Ready."}]"#.utf8)
        let segments = try JSONDecoder().decode([AgentTurnSegment].self, from: data)
        let groups = AgentTurnContentGroup.groups(segments: segments, tools: [])
        XCTAssertEqual(groups.map(\.id), ["a", "t1", "b", "t3", "c"])
        XCTAssertEqual(groups[1].unavailable, 2)
        XCTAssertEqual(groups[3].unavailable, 1)
        XCTAssertEqual(groups[4].text, "Ready.")
        XCTAssertEqual(try JSONDecoder().decode([AgentTurnSegment].self, from: JSONEncoder().encode(segments)), segments)
    }

    func testCompletedDurationDoesNotDependOnViewCreationTime() {
        let execution = AgentExecutionSnapshot(phase: .complete, summary: "Complete", steps: [], startedAtMs: 1000, updatedAtMs: 9000, completed: true)
        XCTAssertEqual(execution.elapsedLabel(at: Date(timeIntervalSince1970: 1000)), "8s")
        XCTAssertEqual(execution.elapsedLabel(at: Date(timeIntervalSince1970: 2000)), "8s")
    }

    func testReasoningNeverBecomesStatusCopyAndLegacySnapshotsRemainReadable() throws {
        let data = Data(#"{"phase":"analyzing","summary":"Checking","steps":[],"thinkingText":"Private internal notes","updatedAtMs":9000,"completed":false}"#.utf8)
        let execution = try JSONDecoder().decode(AgentExecutionSnapshot.self, from: data)
        XCTAssertNil(execution.segments)
        XCTAssertTrue(execution.orderedGroups.isEmpty)
        XCTAssertEqual(execution.progressLabel, "Working")
        XCTAssertNil(execution.elapsedLabel(at: .now))
    }
}
