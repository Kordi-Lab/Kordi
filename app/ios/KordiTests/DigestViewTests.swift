import XCTest
import Testing
@testable import Kordi

@MainActor
@Test
func digestAutomaticDatesRejectStaleAndCancelledPreviews() async {
    let preview = DigestSeriesPreview()
    let first = DigestCalendarEvent(id: "first", title: "Review", startAt: "2099-09-08T12:00:00Z")
    let second = DigestCalendarEvent(id: "second", title: "Review", startAt: "2099-09-09T12:00:00Z")
    let cancelled = Task { await preview.update(first, accountId: "viewer") { [$0] } }
    cancelled.cancel()
    await cancelled.value
    #expect(!preview.isReady(for: first, accountId: "viewer"))
    await preview.update(second, accountId: "viewer") { [$0] }
    #expect(preview.isReady(for: second, accountId: "viewer"))
    #expect(!preview.isReady(for: first, accountId: "viewer"))
    #expect(!preview.isReady(for: second, accountId: "another-account"))
    await preview.update(second, accountId: "viewer") { _ in throw DigestCalendarError(message: "Network unavailable") }
    #expect(preview.error != nil && !preview.isReady(for: second, accountId: "viewer"))
    await preview.update(second, accountId: "viewer") { [$0] }
    #expect(preview.isReady(for: second, accountId: "viewer"))
    await preview.update(nil, accountId: "viewer") { _ in Issue.record("An empty request must not be fetched"); return [] }
    #expect(preview.events.isEmpty && !preview.isReady(for: second, accountId: "viewer"))
}

@MainActor
@Test
func digestCalendarReviewPreservesIdentityAndLinksAcrossTimezones() throws {
    let raw = #"{"id":"move","title":"Review","text":"Move later","kind":"possible","sourceIds":[],"calendarAction":"update","existingEventId":"meeting","existingEventRevision":4,"startAt":"2026-09-08T13:00:00Z"}"#
    var item = try JSONDecoder().decode(RollingDigestItem.self, from: Data(raw.utf8))
    let event = DigestCalendarEvent(id: "meeting", title: "Review", startAt: "2026-09-08T15:00:00+03:00", endAt: "2026-09-08T15:30:00+03:00", reminderAt: "2026-09-08T14:50:00+03:00", revision: 4, links: ["https://example.zoom.us/j/123"], timezone: "Asia/Riyadh")
    let updated = try item.calendarReviewEvent(events: [event], sources: [], timezone: "America/New_York")
    #expect(updated.id == "meeting" && updated.revision == 4)
    #expect(updated.endAt == "2026-09-08T13:30:00Z")
    #expect(updated.reminderAt == "2026-09-08T12:50:00Z")
    #expect(updated.timezone == "Asia/Riyadh" && updated.links == event.links)
    #expect(throws: (any Error).self) { try item.calendarReviewEvent(events: [], sources: [], timezone: "UTC") }
    item.calendarAction = "delete"
    #expect(try item.calendarReviewEvent(events: [event], sources: [], timezone: "UTC") == event)
    #expect(item.calendarReviewLabel(events: [event]) == "Review cancellation")
    let urls = KordiMarkdownParser.externalURLs(in: "[Zoom](https://example.zoom.us/j/123) **https://example.com/agenda** `https://code.example` [Unsafe](javascript:alert(1))")
    #expect(urls.map(\.absoluteString) == ["https://example.zoom.us/j/123", "https://example.com/agenda"])
    for zone in ["America/Los_Angeles", "Asia/Tokyo"] {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try #require(TimeZone(identifier: zone))
        let day = try #require(DigestDate.parse("2026-09-08T12:00:00Z"))
        var allDay = event; allDay.allDay = true; allDay.startAt = "2026-09-08T00:00:00Z"; allDay.endAt = nil
        #expect(DigestDate.event(allDay, occursOn: day, calendar: calendar))
    }
}

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
        let singleDay = DigestCalendarEvent(id: "single", title: "Holiday", startAt: "2026-09-11T00:00:00Z", allDay: true)
        XCTAssertTrue(DigestDate.event(singleDay, occursOn: day, calendar: calendar))
        XCTAssertFalse(DigestDate.event(singleDay, occursOn: try XCTUnwrap(DigestDate.parse("2026-09-12T12:00:00Z")), calendar: calendar))
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

@MainActor
@Test(arguments: [false, true])
func digestDismissalKeepsBriefAndSuggestionRestorationSeparate(hideSuggestion: Bool) throws {
    let suggestionFeedback = hideSuggestion ? #",{"id":"suggestion","status":"dismissed"}"# : ""
    let json = """
    {"accountId":"viewer","snapshot":{
      "claims":[{"id":"brief","title":"Hidden brief","text":"","kind":"progress","sourceIds":[]},
        {"id":"visible","title":"Visible brief","text":"","kind":"progress","sourceIds":[]}],
      "commitments":[],"calendarCandidates":[],
      "suggestions":[{"id":"suggestion","title":"Suggestion","text":"","kind":"possible","sourceIds":[]},
        {"id":"task","title":"Converted task","text":"","kind":"possible","sourceIds":[]}]},
      "sources":[],"partial":true,"revision":1,"updatedAt":"2026-09-07T09:00:00Z","status":"ready",
      "feedback":[{"id":"brief","status":"dismissed"},{"id":"old-item","status":"dismissed"},
        {"id":"task","status":"task"}\(suggestionFeedback)]}
    """
    let response = try JSONDecoder().decode(RollingDigestResponse.self, from: Data(json.utf8))
    #expect(response.visibleClaims.map(\.id) == ["visible"])
    #expect(response.dismissedSuggestions.map(\.id) == (hideSuggestion ? ["suggestion"] : []))
    #expect(response.visibleSuggestions.map(\.id) == (hideSuggestion ? ["task"] : ["suggestion", "task"]))
    #expect(response.snapshot?.claims.count == 2)
    #expect(response.partial)
}
