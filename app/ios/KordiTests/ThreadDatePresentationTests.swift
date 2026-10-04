import XCTest
@testable import Kordi

final class ThreadDatePresentationTests: XCTestCase {
    func testDailyBoundariesIgnoreGapsAndSystemEventsButPreserveGrouping() {
        let calendar = calendar("UTC")
        let messages = [
            message("first", date: "2026-10-02T09:00:00Z"),
            message("later", date: "2026-10-02T18:00:00Z"),
            message("join", date: "2026-10-02T18:01:00Z", kind: ChatMessage.groupMemberJoinMessageKind),
            message("tomorrow", date: "2026-10-03T00:01:00Z"),
            message("reply", date: "2026-10-03T00:02:00Z"),
        ]
        let presentation = ConversationTimelinePresentation.make(messages: messages, selfAccountId: nil, participants: [], calendar: calendar)
        XCTAssertEqual(presentation.map(\.showsDateDivider), [true, false, false, true, false])
        XCTAssertEqual(presentation.map(\.showsTimestamp), [true, true, true, true, false])
        XCTAssertFalse(presentation[1].groupedWithPrevious)
        XCTAssertFalse(presentation[3].groupedWithPrevious)
        XCTAssertTrue(presentation[4].groupedWithPrevious)
    }

    func testDayBoundariesFollowTheViewerTimeZoneAndPrependingHistory() {
        let messages = [message("first", date: "2026-10-03T06:59:00Z"), message("next", date: "2026-10-03T07:01:00Z")]
        func boundaries(_ messages: [ChatMessage], zone: String) -> [Bool] {
            ConversationTimelinePresentation.make(messages: messages, selfAccountId: nil, participants: [], calendar: calendar(zone)).map(\.showsDateDivider)
        }
        XCTAssertEqual(boundaries(messages, zone: "UTC"), [true, false])
        XCTAssertEqual(boundaries(messages, zone: "America/Los_Angeles"), [true, true])
        let prepended = [message("earlier", date: "2026-10-03T06:30:00Z")] + messages
        XCTAssertEqual(boundaries(prepended, zone: "America/Los_Angeles"), [true, false, true])
        XCTAssertTrue(ConversationTimelinePresentation.make(messages: [], selfAccountId: nil, participants: []).isEmpty)
    }

    func testDateLabelHasNoClockTimeAndIncludesTheYear() {
        let date = ISO8601DateFormatter().date(from: "2026-10-03T06:59:00Z")!
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(ThreadDateFormatter.label(for: date, calendar: calendar("UTC"), locale: locale), "October 3, 2026")
        XCTAssertEqual(ThreadDateFormatter.label(for: date, calendar: calendar("America/Los_Angeles"), locale: locale), "October 2, 2026")
    }

    private func calendar(_ zone: String) -> Calendar {
        var result = Calendar(identifier: .gregorian)
        result.timeZone = TimeZone(identifier: zone)!
        return result
    }

    private func message(_ id: String, date: String, kind: String? = nil) -> ChatMessage {
        ChatMessage(id: id, conversationId: "synthetic-date-test", author: .person, authorName: "Maya Chen",
                    text: id, createdAt: ISO8601DateFormatter().date(from: date)!, deliveryState: .delivered,
                    errorMessage: nil, requestMessageId: nil, messageKind: kind)
    }
}
