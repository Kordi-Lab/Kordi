import XCTest
@testable import Kordi

final class UsageLimitsTests: XCTestCase {
    private func decodeContent(_ json: String) throws -> CloudChatContent {
        try JSONDecoder().decode(CloudChatContent.self, from: Data(json.utf8))
    }

    func testChatContentDecodesUsageLimit() throws {
        let content = try decodeContent(#"""
        {"schema":1,"blocks":[{"type":"text","text":"Daily limit reached. Resets at 00:00 UTC."}],"legacy_attachments":[],
         "usageLimit":{"reached":"daily_limit","resetsAt":"2026-11-05T00:00:00Z","organizationId":"org_1"}}
        """#)
        XCTAssertEqual(content.usageLimit, ChatUsageLimit(reached: "daily_limit", resetsAt: "2026-11-05T00:00:00Z", organizationId: "org_1"))
        XCTAssertEqual(content.body, "Daily limit reached. Resets at 00:00 UTC.")
    }

    func testChatContentWithoutUsageLimit() throws {
        let content = try decodeContent(#"{"schema":1,"blocks":[{"type":"text","text":"Hi"}],"legacy_attachments":[]}"#)
        XCTAssertNil(content.usageLimit)
    }

    func testMalformedUsageLimitFallsBackToPlainText() throws {
        let unknown = try decodeContent(#"{"schema":1,"blocks":[{"type":"text","text":"Hi"}],"usageLimit":{"reached":"weekly"}}"#)
        XCTAssertNil(unknown.usageLimit)
        let wrongType = try decodeContent(#"{"schema":1,"blocks":[{"type":"text","text":"Hi"}],"usageLimit":"daily_limit"}"#)
        XCTAssertNil(wrongType.usageLimit)
        XCTAssertEqual(wrongType.body, "Hi")
    }

    func testSnapshotDecodesWithoutAmounts() throws {
        let snapshot = try JSONDecoder().decode(CloudUsageSnapshot.self, from: Data(#"""
        {"limitId":"pool.runs","scope":"pool","usedPercent":70,"window":"day","resetsAt":"2026-11-05T00:00:00Z","reached":"none"}
        """#.utf8))
        XCTAssertNil(snapshot.used)
        XCTAssertNil(snapshot.limit)
        XCTAssertEqual(UsagePresentation.value(snapshot), "70%")
        XCTAssertEqual(UsagePresentation.status(snapshot), "Resets at 00:00 UTC")
    }

    func testOrganizationUsageDecodesNotices() throws {
        let usage = try JSONDecoder().decode(CloudOrganizationUsage.self, from: Data(#"""
        {"organizationId":"org_1","role":"owner","snapshots":[{"limitId":"pool.spend","scope":"pool","used":400000,"limit":1000000,
         "usedPercent":40,"window":"day","resetsAt":"2026-11-05T00:00:00Z","reached":"none"}],
         "notices":[{"threshold":90,"at":"2026-11-04T10:00:00Z"},{"threshold":75,"at":"2026-11-04T08:00:00Z"}]}
        """#.utf8))
        XCTAssertEqual(UsagePresentation.value(usage.snapshots[0]), "0.40 of 1.00")
        XCTAssertEqual(UsagePresentation.noticeLine(usage.notices), "90% of today's limit used.")
    }

    func testValueAndStatusCopy() {
        let runs = CloudUsageSnapshot(limitId: "pool.runs", scope: "pool", used: 7, limit: 10, usedPercent: 70,
                                      resetsAt: "2026-11-05T00:00:00Z")
        XCTAssertEqual(UsagePresentation.label(limitId: runs.limitId), "Runs")
        XCTAssertEqual(UsagePresentation.value(runs), "7 of 10")
        let reached = CloudUsageSnapshot(limitId: "pool.spend", scope: "pool", usedPercent: 100,
                                         resetsAt: "2026-11-05T00:00:00Z", reached: "spend_limit")
        XCTAssertEqual(UsagePresentation.status(reached), "Daily limit reached. Resets at 00:00 UTC.")
        let stopped = CloudUsageSnapshot(limitId: "pool.stopped", scope: "pool", usedPercent: 100,
                                         resetsAt: "2026-11-05T00:00:00Z", reached: "stopped")
        XCTAssertEqual(UsagePresentation.label(limitId: stopped.limitId), "System agent")
        XCTAssertEqual(UsagePresentation.status(stopped), "Paused by an owner.")
    }

    func testChatCopyByRole() {
        let limit = ChatUsageLimit(reached: "daily_limit", resetsAt: "2026-11-05T00:00:00Z", organizationId: "org_1")
        XCTAssertEqual(UsagePresentation.chatText(limit, role: "owner"), "Daily limit reached. Resets at 00:00 UTC.")
        XCTAssertEqual(UsagePresentation.chatText(limit, role: "admin"), "Daily limit reached. Resets at 00:00 UTC.")
        XCTAssertTrue(UsagePresentation.offersUsageLink(limit, role: "admin"))
        let ask = "Daily limit reached. Resets at 00:00 UTC. Ask an owner to raise it."
        XCTAssertEqual(UsagePresentation.chatText(limit, role: "member"), ask)
        XCTAssertEqual(UsagePresentation.chatText(limit, role: nil), ask)
        XCTAssertFalse(UsagePresentation.offersUsageLink(limit, role: nil))
        let stopped = ChatUsageLimit(reached: "stopped")
        XCTAssertEqual(UsagePresentation.chatText(stopped, role: "owner"), "Paused by an owner.")
        XCTAssertFalse(UsagePresentation.offersUsageLink(stopped, role: "owner"))
    }

    func testChatMessageCacheKeepsUsageLimitAndOldCachesDecode() throws {
        let message = ChatMessage(
            id: "m1", conversationId: "c1", author: .person, authorName: "System", text: "Paused by an owner.",
            createdAt: Date(timeIntervalSince1970: 0), deliveryState: .sent, errorMessage: nil, requestMessageId: nil,
            messageKind: "system-notice", usageLimit: ChatUsageLimit(reached: "stopped")
        )
        let data = try JSONEncoder().encode(message)
        XCTAssertEqual(try JSONDecoder().decode(ChatMessage.self, from: data).usageLimit, ChatUsageLimit(reached: "stopped"))

        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "usageLimit")
        let old = try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(old.usageLimit)
        XCTAssertEqual(UsagePresentation.displayMessage(old, role: nil).text, "Paused by an owner.")
    }
}
