import XCTest
@testable import Kordi

final class DigestViewTests: XCTestCase {
    @MainActor
    func testDeviceCalendarImportAcceptsInstantsAndContinuesPastInvalidRanges() async throws {
        let point = DigestCalendarEvent(id: "point", title: "Point event", startAt: "2026-09-06T12:00:00Z", endAt: "2026-09-06T15:00:00+03:00")
        XCTAssertNil(try point.normalizedForSave().endAt)
        var allDay = point; allDay.allDay = true
        XCTAssertNil(try allDay.normalizedForSave().endAt)
        var invalid = point; invalid.id = "invalid"; invalid.endAt = "2026-09-06T11:00:00Z"
        var later = point; later.id = "later"; later.endAt = "2026-09-06T13:00:00Z"
        var saved: [DigestCalendarEvent] = []
        let first = try await importDigestCalendarEvents([point, invalid, later, point], existing: []) { saved.append($0) }
        XCTAssertEqual(first.imported, 2); XCTAssertEqual(first.duplicates, 1); XCTAssertEqual(first.skipped.count, 1)
        XCTAssertEqual(saved.map(\.id), ["point", "later"])
        let retry = try await importDigestCalendarEvents([point, later], existing: saved) { _ in XCTFail("Duplicate was submitted") }
        XCTAssertEqual(retry.imported, 0); XCTAssertEqual(retry.duplicates, 2)
    }
    @MainActor
    func testRemindersRejectAnAccountThatHasSignedOut() async {
        do {
            _ = try await DigestCalendarService.syncReminders(accountId: "signed-out", events: [], isCurrentAccount: { false })
            XCTFail("A signed-out account must not reach the notification center")
        } catch { XCTAssertTrue(error is CancellationError) }
    }
    func testMainDestinationsIncludeAgentsWithoutFactory() {
        XCTAssertEqual(MainTab.contentTabs, [.contacts, .chats, .agents, .digest, .account])
        XCTAssertEqual(MainTab.contentTabs, MainTab.allCases)
        XCTAssertEqual(MainTab.account.symbol, "person")
    }
    func testConversationKindsRouteToTheirDedicatedTabs() {
        XCTAssertEqual(MainTab.destination(for: .agent), .agents)
        XCTAssertEqual(MainTab.destination(for: .person), .chats)
        XCTAssertEqual(MainTab.destination(for: .group), .chats)
    }
    func testMonthGridIncludesAdjacentDatesAndLeapDay() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let september = try XCTUnwrap(DigestDate.parse("2026-09-10T00:00:00Z"))
        let dates = DigestDate.monthDays(containing: september, calendar: calendar)
        XCTAssertEqual(dates.count, 42)
        XCTAssertEqual(DigestDate.key(try XCTUnwrap(dates.first), calendar: calendar), "2026-08-30")
        XCTAssertEqual(DigestDate.key(try XCTUnwrap(dates.last), calendar: calendar), "2026-10-10")
        let february = try XCTUnwrap(DigestDate.parse("2028-02-01T00:00:00Z"))
        XCTAssertTrue(DigestDate.monthDays(containing: february, calendar: calendar).contains { DigestDate.key($0, calendar: calendar) == "2028-02-29" })
    }
    func testAllDayEndIsExclusiveAndTimedEventsCanCrossMidnight() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let day = try XCTUnwrap(DigestDate.parse("2026-09-11T12:00:00Z"))
        let event = DigestCalendarEvent(id: "event", title: "Planning", startAt: "2026-09-10T00:00:00Z", endAt: "2026-09-12T00:00:00Z", allDay: true)
        XCTAssertTrue(DigestDate.event(event, occursOn: day, calendar: calendar))
        XCTAssertFalse(DigestDate.event(event, occursOn: try XCTUnwrap(DigestDate.parse("2026-09-12T12:00:00Z")), calendar: calendar))
        let overnight = DigestCalendarEvent(id: "night", title: "Handoff", startAt: "2026-09-10T23:30:00Z", endAt: "2026-09-11T00:30:00Z")
        XCTAssertTrue(DigestDate.event(overnight, occursOn: day, calendar: calendar))
    }
    func testRollingContractKeepsUnknownOwnershipAndExactSources() throws {
        let json = #"{"accountId":"viewer","snapshot":{"claims":[],"commitments":[{"id":"followup","title":"Review draft","text":"No owner agreed","kind":"possible","sourceIds":["message"]}],"suggestions":[],"calendarCandidates":[]},"sources":[{"id":"message","conversationId":"conversation","sessionId":"session","sessionTitle":"Planning","senderAccountId":"author","senderName":"Alex","text":"Could someone review this?","createdAt":"2026-09-07T09:00:00Z","version":1}],"partial":false,"revision":1,"updatedAt":"2026-09-07T09:01:00Z","status":"ready","feedback":[]}"#
        let response = try JSONDecoder().decode(RollingDigestResponse.self, from: Data(json.utf8))
        let task = try XCTUnwrap(response.snapshot?.commitments.first)
        XCTAssertNil(task.ownerAccountId); XCTAssertNil(task.dueAt)
        XCTAssertEqual(task.sourceIds, ["message"])
        XCTAssertEqual(response.sources.first?.text, "Could someone review this?")
    }
    func testPendingCalendarMentionsUseLocalDatesAndDisappearAfterConfirmation() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 3 * 3600))
        let json = #"[{"id":"review","title":"Design review","text":"","kind":"possible","sourceIds":["message"],"startAt":"2026-09-06T22:00:00Z"},{"id":"unknown","title":"Office hours","text":"","kind":"possible","sourceIds":["message"]}]"#
        let candidates = try JSONDecoder().decode([RollingDigestItem].self, from: Data(json.utf8))
        let day = try XCTUnwrap(DigestDate.parse("2026-09-07T09:00:00+03:00"))
        XCTAssertEqual(DigestDate.pendingCandidates(candidates, events: [], on: day, calendar: calendar).map(\.id), ["review"])
        let confirmed = DigestCalendarEvent(id: "digest-review", title: "Design review", startAt: "2026-09-06T22:00:00Z")
        XCTAssertTrue(DigestDate.pendingCandidates(candidates, events: [confirmed], on: day, calendar: calendar).isEmpty)
        XCTAssertTrue(DigestDate.event(confirmed, occursOn: day, calendar: calendar))
    }
    func testICSImportExpandsRecurrenceWithoutActivatingAlarms() throws {
        let text = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:review\nDTSTAMP:20260901T000000Z\nDTSTART:20260909T120000Z\nDTEND:20260909T123000Z\nRRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20260916T120000Z\nSUMMARY:Review\nEND:VEVENT\nEND:VCALENDAR"
        let first = try DigestICSImporter.parse(text, from: "2026-09-01", to: "2026-10-01")
        let second = try DigestICSImporter.parse(text, from: "2026-09-01", to: "2026-10-01")
        XCTAssertEqual(first.events.count, 2)
        XCTAssertEqual(first.events.map(\.id), second.events.map(\.id))
        XCTAssertTrue(first.events.allSatisfy { $0.reminderAt == nil })
    }
}
