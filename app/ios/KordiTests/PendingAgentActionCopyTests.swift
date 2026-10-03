import XCTest
@testable import Kordi

final class PendingAgentActionCopyTests: XCTestCase {
    private let timeZone = TimeZone(identifier: "America/Los_Angeles")!
    private let locale = Locale(identifier: "en_US")

    /// Newer system formatters put a narrow no-break space before AM/PM.
    private func normalized(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private func copy(_ kind: CloudPendingAgentAction.Kind, _ subject: CloudPendingAgentAction.Subject,
                      proposer: String? = nil) -> PendingAgentActionCopy? {
        PendingAgentActionCopy.make(
            for: CloudPendingAgentAction(
                actionId: "a1",
                kind: kind,
                sessionId: "session:group:g1",
                proposedBy: .init(accountId: "acct_owner", displayName: proposer, isPip: kind != .calendarDisclosure),
                subject: subject
            ),
            timeZone: timeZone,
            locale: locale
        )
    }

    func testTimesUseLocalTimeWithAZoneLabelAndDatesStayDates() {
        XCTAssertEqual(
            normalized(PendingAgentActionCopy.formatTime("2026-10-03T01:30:00Z", timeZone: timeZone, locale: locale)),
            "Fri, Oct 2 · 6:30 PM PDT"
        )
        XCTAssertEqual(
            normalized(PendingAgentActionCopy.formatTime("2026-10-03", timeZone: timeZone, locale: locale)),
            "Sat, Oct 3"
        )
        XCTAssertEqual(PendingAgentActionCopy.formatTime("next week", timeZone: timeZone, locale: locale), "next week")
        XCTAssertNil(PendingAgentActionCopy.formatTime(nil))
        XCTAssertNil(PendingAgentActionCopy.formatTime("  "))
    }

    func testCalendarWindowsCoverEveryShape() {
        let both = PendingAgentActionCopy.calendarWindow(startAt: "2026-10-03", endAt: "2026-10-04", timeZone: timeZone, locale: locale)
        XCTAssertEqual(normalized(both), "Sat, Oct 3 – Sun, Oct 4")
        XCTAssertEqual(normalized(PendingAgentActionCopy.calendarWindow(startAt: "2026-10-03", endAt: nil, timeZone: timeZone, locale: locale)), "from Sat, Oct 3")
        XCTAssertEqual(normalized(PendingAgentActionCopy.calendarWindow(startAt: nil, endAt: "2026-10-04", timeZone: timeZone, locale: locale)), "until Sun, Oct 4")
        XCTAssertEqual(PendingAgentActionCopy.calendarWindow(startAt: nil, endAt: nil), "all dates")
    }

    func testCalendarSharingNamesTheAgentAndTheGrant() throws {
        let sharing = try XCTUnwrap(copy(.calendarDisclosure, .init(agentName: "Scout", startAt: "2026-10-03", endAt: "2026-10-04")))
        XCTAssertEqual(sharing.title, "Share your calendar in this chat?")
        XCTAssertEqual(normalized(sharing.body), "Scout wants to read your saved Kordi calendar for Sat, Oct 3 – Sun, Oct 4 and may summarize it for everyone here.")
        XCTAssertEqual(sharing.footnote, "If you allow this, Scout can read these dates again in this chat for the next 10 minutes.")
        XCTAssertEqual(sharing.approveLabel, "Allow")
        XCTAssertEqual(sharing.declineLabel, "Don't allow")
        XCTAssertEqual(sharing.approveAccessibilityLabel, "Allow sharing your calendar")
        XCTAssertEqual(sharing.declineAccessibilityLabel, "Don't allow sharing your calendar")

        let unnamed = try XCTUnwrap(copy(.calendarDisclosure, .init(), proposer: nil))
        XCTAssertEqual(unnamed.body, "Your agent wants to read your saved Kordi calendar for all dates and may summarize it for everyone here.")
        let proposerNamed = try XCTUnwrap(copy(.calendarDisclosure, .init(), proposer: "Helper"))
        XCTAssertTrue(proposerNamed.body.hasPrefix("Helper wants to read"))
    }

    func testRSVPSuggestionsSayWhatPiPHeard() throws {
        let yes = try XCTUnwrap(copy(.planRSVP, .init(startAt: "2026-10-03T01:30:00Z", title: "Lunch", rsvp: "yes")))
        XCTAssertEqual(yes.title, "PiP noted you're in")
        XCTAssertEqual(normalized(yes.body), "From your message, PiP thinks you can make “Lunch” on Fri, Oct 2 · 6:30 PM PDT. Confirm so the plan shows your answer.")
        XCTAssertEqual(yes.approveLabel, "Confirm")
        XCTAssertEqual(yes.declineLabel, "Not right")
        XCTAssertEqual(yes.approveAccessibilityLabel, "Confirm your answer for Lunch")

        let no = try XCTUnwrap(copy(.planRSVP, .init(title: "Lunch", rsvp: "no")))
        XCTAssertEqual(no.title, "PiP noted you can't make it")
        XCTAssertEqual(no.body, "From your message, PiP thinks you can't make “Lunch”. Confirm so the plan shows your answer.")
        XCTAssertNil(no.footnote)
    }

    func testVoteAndPlanDecisions() throws {
        let vote = try XCTUnwrap(copy(.planVote, .init(title: "Lunch", optionLabel: "Noon")))
        XCTAssertEqual(vote.title, "PiP noted your choice")
        XCTAssertEqual(vote.body, "From your message, PiP thinks you prefer “Noon” for “Lunch”. Confirm to add your vote.")
        XCTAssertEqual([vote.approveLabel, vote.declineLabel], ["Vote", "Not right"])
        XCTAssertEqual(vote.approveAccessibilityLabel, "Vote for Noon")

        let confirm = try XCTUnwrap(copy(.planConfirm, .init(startAt: "2026-10-03", title: "Lunch", location: "Cafe", revision: 3)))
        XCTAssertEqual(confirm.title, "Confirm this plan?")
        XCTAssertEqual(normalized(confirm.body), "PiP thinks the group settled on “Lunch” on Sat, Oct 3 at Cafe. Confirming adds it to the Kordi calendar of everyone who said they're in.")
        XCTAssertEqual([confirm.approveLabel, confirm.declineLabel], ["Confirm plan", "Not yet"])

        let cancel = try XCTUnwrap(copy(.planCancel, .init(title: "Lunch", revision: 4, reason: "Rain")))
        XCTAssertEqual(cancel.title, "Cancel this plan?")
        XCTAssertEqual(cancel.body, "PiP thinks “Lunch” is off: “Rain”. Canceling removes it from everyone's Kordi calendar.")
        XCTAssertEqual([cancel.approveLabel, cancel.declineLabel], ["Cancel plan", "Keep plan"])
        let cancelNoReason = try XCTUnwrap(copy(.planCancel, .init(title: "Lunch")))
        XCTAssertEqual(cancelNoReason.body, "PiP thinks “Lunch” is off. Canceling removes it from everyone's Kordi calendar.")

        let reopen = try XCTUnwrap(copy(.planReopen, .init(title: "Lunch", revision: 5, reason: "Venue closed")))
        XCTAssertEqual(reopen.title, "Reopen this plan?")
        XCTAssertEqual(reopen.body, "PiP thinks “Lunch” may no longer stand: “Venue closed”. Reopening removes it from calendars until someone confirms it again.")
        XCTAssertEqual([reopen.approveLabel, reopen.declineLabel], ["Reopen", "Keep as is"])
        XCTAssertEqual(reopen.declineAccessibilityLabel, "Keep the plan Lunch as is")

        let untitled = try XCTUnwrap(copy(.planVote, .init()))
        XCTAssertEqual(untitled.body, "From your message, PiP thinks you prefer “this option” for “this plan”. Confirm to add your vote.")
    }

    func testUnknownKindsHaveNoCopy() {
        XCTAssertNil(PendingAgentActionCopy.make(for: CloudPendingAgentAction(actionId: "a1", kind: nil)))
    }

    func testErrorsAndAnnouncements() {
        XCTAssertEqual(PendingAgentActionCopy.errorText(code: "plan_changed"), "This plan changed. Check the card and try again.")
        XCTAssertEqual(PendingAgentActionCopy.errorText(code: "agent_action_closed"), "This request is no longer waiting. Ask again if you still need it.")
        XCTAssertEqual(PendingAgentActionCopy.errorText(code: "plan_card_forbidden"), "Couldn't save your answer. Try again.")
        XCTAssertEqual(PendingAgentActionCopy.errorText(code: nil), "Couldn't save your answer. Try again.")
        XCTAssertEqual(PendingAgentActionCopy.announcement(for: .calendarDisclosure, decision: .approve), "Calendar sharing allowed.")
        XCTAssertEqual(PendingAgentActionCopy.announcement(for: .calendarDisclosure, decision: .decline), "Calendar sharing declined.")
        XCTAssertEqual(PendingAgentActionCopy.announcement(for: .planVote, decision: .approve), "Answer saved.")
        XCTAssertEqual(PendingAgentActionCopy.announcement(for: .planCancel, decision: .decline), "Suggestion dismissed.")
        XCTAssertEqual(PendingAgentActionCopy.arrivalAnnouncement(count: 1), "1 request is waiting for you.")
        XCTAssertEqual(PendingAgentActionCopy.arrivalAnnouncement(count: 2), "2 requests are waiting for you.")
        XCTAssertEqual(PendingAgentActionCopy.regionLabel, "Waiting for you")
    }
}
