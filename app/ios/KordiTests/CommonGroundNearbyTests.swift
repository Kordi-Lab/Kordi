import XCTest
@testable import Kordi

/// Nearby people (#2100): wire shapes from docs/development/grounding-nearby.md,
/// distance bands, request windows, the post throttle and withdrawal.
@MainActor
final class CommonGroundNearbyTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func encode<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: Decoding

    func testSettingsDecode() throws {
        let settings = try decode(CommonGroundNearbySettings.self, #"""
        {
          "enabled": true, "participating": true, "pausedUntil": null,
          "consentedAt": "2026-10-26T09:00:00Z", "profileId": "cgp_1",
          "openTo": ["Coffee chat"], "range": 1000, "minScore": 50,
          "alerts": {"requests": true, "matches": false, "matchMinScore": 70, "maxPerDay": 10},
          "location": {"capturedAt": "2026-10-26T09:00:00Z", "freshUntil": "2026-10-26T09:30:00Z", "fresh": true},
          "freshSeconds": 1800
        }
        """#)
        XCTAssertTrue(settings.enabled)
        XCTAssertTrue(settings.participating)
        XCTAssertEqual(settings.profileId, "cgp_1")
        XCTAssertEqual(settings.openTo, ["Coffee chat"])
        XCTAssertEqual(settings.range, 1000)
        XCTAssertEqual(settings.minScore, 50)
        XCTAssertEqual(settings.alerts, CommonGroundNearbyAlerts(requests: true, matches: false, matchMinScore: 70, maxPerDay: 10))
        XCTAssertEqual(settings.location?.fresh, true)
        XCTAssertNotNil(settings.location?.captured)
        XCTAssertTrue(settings.isSharing())
    }

    func testSettingsDefaultsForAnAccountWithoutARow() throws {
        let settings = try decode(CommonGroundNearbySettings.self, #"{"enabled": false, "participating": false, "location": null}"#)
        XCTAssertFalse(settings.enabled)
        XCTAssertEqual(settings.range, 2000)
        XCTAssertEqual(settings.minScore, 0)
        XCTAssertEqual(settings.alerts, CommonGroundNearbyAlerts())
        XCTAssertNil(settings.location)
        XCTAssertEqual(settings.freshSeconds, 1800)
    }

    func testPausedSettingsAreNotSharing() throws {
        let settings = try decode(CommonGroundNearbySettings.self, #"{"enabled": true, "pausedUntil": "2026-10-26T15:00:00Z"}"#)
        let before = try XCTUnwrap(commonGroundParseDate("2026-10-26T14:00:00Z"))
        let after = try XCTUnwrap(commonGroundParseDate("2026-10-26T16:00:00Z"))
        XCTAssertTrue(settings.isPaused(now: before))
        XCTAssertFalse(settings.isSharing(now: before))
        XCTAssertFalse(settings.isPaused(now: after))
        XCTAssertTrue(settings.isSharing(now: after))
    }

    func testPeopleDecode() throws {
        let people = try decode(CommonGroundNearbyPeople.self, #"""
        {
          "people": [
            {
              "person": {"accountId": "acct_maya", "name": "Maya Chen", "handle": "maya", "avatarUrl": null,
                         "profile": {"profileId": "cgp_m", "kind": "work", "name": "Work", "design": null, "icon": null}},
              "relationship": {"contact": false, "request": null, "requestId": null, "conversationId": null},
              "distance": {"minMeters": 0, "maxMeters": 500},
              "openTo": ["Collaborating"], "status": "ready", "score": 92,
              "headline": "Both build memory for agents",
              "requests": [{"needId": "cgn_1", "text": "Someone founding a startup"}]
            },
            {
              "person": {"accountId": "acct_leo", "name": "Leo Park", "avatarUrl": null},
              "distance": {"minMeters": 1000, "maxMeters": 2000},
              "openTo": [], "status": "matching", "score": null, "headline": null, "requests": []
            },
            {
              "person": {"accountId": "acct_ana", "name": "Ana Ruiz", "avatarUrl": null},
              "distance": {"minMeters": 2000, "maxMeters": 5000},
              "status": "failed", "score": null
            }
          ],
          "matching": 3,
          "location": {"capturedAt": "2026-10-26T09:00:00Z", "freshUntil": "2026-10-26T09:30:00Z", "fresh": true}
        }
        """#)
        XCTAssertEqual(people.people.count, 3)
        let maya = people.people[0]
        XCTAssertEqual(maya.person.accountId, "acct_maya")
        XCTAssertEqual(maya.person.profile?.profileId, "cgp_m")
        XCTAssertEqual(maya.relationship, CommonGroundRelationship())
        XCTAssertEqual(maya.detailLine, "92% · Under 500 m")
        XCTAssertEqual(maya.requests.map(\.text), ["Someone founding a startup"])
        XCTAssertEqual(people.people[1].detailLine, "1–2 km")
        XCTAssertTrue(people.people[1].isMatching)
        // Matching people fold into "Matching N more"; failed ones stay as rows.
        XCTAssertEqual(people.shown.map(\.id), ["acct_maya", "acct_ana"])
        XCTAssertEqual(people.matchingMore, 2)
        XCTAssertEqual(people.location?.fresh, true)
    }

    func testPersonDetailDecode() throws {
        let detail = try decode(CommonGroundNearbyPersonDetail.self, #"""
        {
          "person": {"accountId": "acct_maya", "name": "Maya Chen", "avatarUrl": null},
          "relationship": {"contact": true, "request": null, "requestId": null, "conversationId": "c1"},
          "distance": {"minMeters": 0, "maxMeters": 500},
          "openTo": ["Coffee chat"], "status": "ready", "score": 92, "headline": "Both build memory for agents",
          "profileId": "cgp_me",
          "card": {"workingOn": ["Founding Loom Labs"], "interests": [], "canHelp": [], "lookingFor": []},
          "requests": [{
            "needId": "cgn_2", "text": "Coffee with a Fudan or SJTU alum", "met": false,
            "checks": [
              {"condition": 0, "label": "Fudan or SJTU alum", "verdict": "met", "kind": "affiliation", "evidence": "Fudan University"},
              {"condition": 1, "label": "Wants a coffee chat", "verdict": "unknown", "kind": "willingness", "evidence": null}
            ]
          }],
          "shared": [{"topic": "Agent memory", "theirTopic": "Agent memory", "why": "You both build memory stores"}],
          "youBring": [{"topic": "Long-context evaluation", "for": "Memory benchmark", "why": ""}],
          "theyBring": [],
          "nextStep": "Ask about the benchmark"
        }
        """#)
        XCTAssertEqual(detail.person.accountId, "acct_maya")
        XCTAssertEqual(detail.entry.score, 92)
        XCTAssertEqual(detail.entry.relationship?.contact, true)
        XCTAssertEqual(detail.card?.workingOn, ["Founding Loom Labs"])
        XCTAssertEqual(detail.requests.count, 1)
        let checks = detail.requests[0].checks
        XCTAssertEqual(checks.map(\.met), [true, false])
        XCTAssertEqual(checks[0].evidenceLine, "Profile · Fudan University")
        XCTAssertEqual(checks[1].evidenceLine, "Not shared")
        XCTAssertEqual(detail.shared.first?.topic, "Agent memory")
        XCTAssertEqual(detail.youBring.first?.target, "Memory benchmark")
        XCTAssertEqual(detail.nextStep, "Ask about the benchmark")
    }

    func testPersonDetailWhileMatching() throws {
        let detail = try decode(CommonGroundNearbyPersonDetail.self, #"""
        {"person": {"accountId": "acct_leo", "name": "Leo"}, "distance": {"minMeters": 1000, "maxMeters": 2000},
         "status": "matching", "score": null, "requests": []}
        """#)
        XCTAssertTrue(detail.entry.isMatching)
        XCTAssertTrue(detail.shared.isEmpty)
        XCTAssertNil(detail.card)
    }

    func testNeedsDecode() throws {
        let list = try decode(CommonGroundNearbyNeedList.self, #"""
        {"needs": [
          {"needId": "cgn_2", "text": "Coffee with a Fudan or SJTU alum", "range": 1000,
           "startsAt": "2026-10-26T15:00:00Z", "endsAt": "2026-10-26T18:00:00Z", "paused": false,
           "status": "active", "revision": 2, "createdAt": "2026-10-26T09:00:00Z", "updatedAt": "2026-10-26T09:00:00Z"},
          {"needId": "cgn_3", "text": "Demo partner", "range": 2000, "startsAt": null, "endsAt": null,
           "paused": true, "status": "paused", "revision": 1}
        ]}
        """#)
        XCTAssertEqual(list.needs.map(\.needId), ["cgn_2", "cgn_3"])
        XCTAssertEqual(list.needs[0].range, 1000)
        XCTAssertNotNil(list.needs[0].start)
        XCTAssertNotNil(list.needs[0].end)
        XCTAssertEqual(list.needs[0].revision, 2)
        XCTAssertTrue(list.needs[1].paused)
        XCTAssertNil(list.needs[1].end)
    }

    func testLocationReplyDecode() throws {
        let reply = try decode(CommonGroundNearbyLocationReply.self, #"""
        {"location": {"capturedAt": "2026-10-26T09:00:00Z", "freshUntil": "2026-10-26T09:30:00Z", "fresh": true}}
        """#)
        XCTAssertEqual(reply.location?.fresh, true)
    }

    // MARK: Encoding

    func testUpdateSendsOnlyItsFieldsAndNullToResume() throws {
        let resume = try encode(CommonGroundNearbyUpdate(pausedUntil: .some(nil)))
        XCTAssertEqual(Array(resume.keys), ["pausedUntil"])
        XCTAssertTrue(resume["pausedUntil"] is NSNull)
        let filter = try encode(CommonGroundNearbyUpdate(range: 5000))
        XCTAssertEqual(filter as NSDictionary, ["range": 5000] as NSDictionary)
        let turnOn = try encode(CommonGroundNearbyUpdate(enabled: true, consent: true, profileId: "cgp_1"))
        XCTAssertEqual(turnOn as NSDictionary, ["enabled": true, "consent": true, "profileId": "cgp_1"] as NSDictionary)
    }

    func testNeedDraftClearsTheWindowWithNull() throws {
        let cleared = try encode(CommonGroundNearbyNeedDraft(startsAt: .some(nil), endsAt: .some(nil)))
        XCTAssertTrue(cleared["startsAt"] is NSNull)
        XCTAssertTrue(cleared["endsAt"] is NSNull)
        let paused = try encode(CommonGroundNearbyNeedDraft(paused: true))
        XCTAssertEqual(paused as NSDictionary, ["paused": true] as NSDictionary)
    }

    func testEditSendsOnlyWhatChanged() throws {
        let need = CommonGroundNearbyNeed(needId: "cgn_1", text: "Founder", range: 2000)
        XCTAssertNil(CommonGroundNearbyRequestSheet.draft(for: need, text: "Founder", range: 2000, window: nil, paused: false))
        let pause = try XCTUnwrap(CommonGroundNearbyRequestSheet.draft(for: need, text: "Founder", range: 2000, window: nil, paused: true))
        XCTAssertEqual(pause, CommonGroundNearbyNeedDraft(paused: true))
        let new = try XCTUnwrap(CommonGroundNearbyRequestSheet.draft(for: nil, text: "Founder", range: 1000, window: nil, paused: false))
        XCTAssertEqual(try encode(new) as NSDictionary, ["text": "Founder", "range": 1000] as NSDictionary)
    }

    func testFixIsRoundedBeforeItLeavesThePhone() throws {
        let fix = CommonGroundNearbyFix(latitude: 31.230416, longitude: 121.473701, accuracy: 65.4, capturedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(fix.latitude, 31.23, accuracy: 0.000001)
        XCTAssertEqual(fix.longitude, 121.474, accuracy: 0.000001)
        XCTAssertEqual(fix.accuracy, 65)
        XCTAssertEqual(fix.capturedAt, "1970-01-01T00:00:00Z")
    }

    // MARK: Bands and labels

    func testBandLabels() {
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 500), "Under 500 m")
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 1000), "Under 1 km")
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 2000), "1–2 km")
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 5000), "2–5 km")
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 10000), "5–10 km")
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 25000), "10–25 km")
        XCTAssertEqual(CommonGroundNearbyBand.label(maxMeters: 1200), "1–2 km")
    }

    func testFilterLabels() {
        XCTAssertEqual(CommonGroundNearbyBand.ranges.map(CommonGroundNearbyBand.rangeLabel), ["500 m", "1 km", "2 km", "5 km", "10 km", "25 km"])
        XCTAssertEqual(CommonGroundNearbyBand.rangePill(2000), "Within 2 km")
        XCTAssertEqual(CommonGroundNearbyBand.scores.map(CommonGroundNearbyBand.scoreLabel), ["Any", "50%+", "70%+", "85%+"])
        XCTAssertEqual(CommonGroundNearbyBand.scorePill(0), "Any match")
        XCTAssertEqual(CommonGroundNearbyBand.scorePill(70), "70%+ match")
        XCTAssertEqual(CommonGroundNearbyBand.perDayLabel(3), "3 a day")
        XCTAssertEqual(CommonGroundNearbyBand.peopleCount(1), "1 person")
        XCTAssertEqual(CommonGroundNearbyBand.peopleCount(4), "4 people")
    }

    // MARK: Request windows

    func testWindowValidation() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let hour: TimeInterval = 3600
        XCTAssertNil(CommonGroundNearbyWindow.problem(start: nil, end: nil, now: now))
        XCTAssertNil(CommonGroundNearbyWindow.problem(start: now, end: now.addingTimeInterval(3 * hour), now: now))
        XCTAssertNil(CommonGroundNearbyWindow.problem(start: nil, end: now.addingTimeInterval(7 * 24 * hour), now: now))
        XCTAssertEqual(CommonGroundNearbyWindow.problem(start: nil, end: now, now: now), .endPassed)
        XCTAssertEqual(CommonGroundNearbyWindow.problem(start: nil, end: now.addingTimeInterval(7 * 24 * hour + 1), now: now), .endTooFar)
        XCTAssertEqual(CommonGroundNearbyWindow.problem(start: now.addingTimeInterval(2 * hour), end: now.addingTimeInterval(hour), now: now), .startAfterEnd)
        XCTAssertEqual(CommonGroundNearbyWindow.problem(start: now.addingTimeInterval(hour), end: now.addingTimeInterval(hour), now: now), .startAfterEnd)
        XCTAssertEqual(CommonGroundNearbyWindow.message(.endTooFar), "End the request within the next 7 days.")
        XCTAssertEqual(CommonGroundNearbyWindow.message(.startAfterEnd), "Start the request before it ends.")
    }

    func testRequestSubtitle() {
        let now = Date()
        XCTAssertEqual(CommonGroundNearbyWindow.subtitle(CommonGroundNearbyNeed(needId: "a", text: "x", range: 2000), now: now), "No end · 2 km")
        XCTAssertEqual(CommonGroundNearbyWindow.subtitle(CommonGroundNearbyNeed(needId: "b", text: "x", paused: true, status: "paused"), now: now), "Paused")
        XCTAssertEqual(CommonGroundNearbyWindow.subtitle(CommonGroundNearbyNeed(needId: "c", text: "x", status: "ended"), now: now), "Ended")
    }

    // MARK: Post throttle

    func testPostRule() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        typealias Rule = CommonGroundNearbyPostRule
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: nil, lastPostAt: nil, now: now), .post)
        // Old, imprecise or invalid fixes are never sent.
        XCTAssertEqual(Rule.decide(capturedAt: now.addingTimeInterval(-601), accuracy: 65, moved: nil, lastPostAt: nil, now: now), .unusable)
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 2001, moved: nil, lastPostAt: nil, now: now), .unusable)
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: -1, moved: nil, lastPostAt: nil, now: now), .unusable)
        // At most one post a minute, even when forced.
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: 500, lastPostAt: now.addingTimeInterval(-30), now: now), .tooSoon)
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: 10, lastPostAt: now.addingTimeInterval(-30), now: now, force: true), .tooSoon)
        // Not moved within 5 minutes: skipped unless forced.
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: 49, lastPostAt: now.addingTimeInterval(-120), now: now), .unchanged)
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: 49, lastPostAt: now.addingTimeInterval(-120), now: now, force: true), .post)
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: 50, lastPostAt: now.addingTimeInterval(-120), now: now), .post)
        // Still for 5 minutes: posted again so the location stays fresh.
        XCTAssertEqual(Rule.decide(capturedAt: now, accuracy: 65, moved: 5, lastPostAt: now.addingTimeInterval(-300), now: now), .post)
    }

    // MARK: Withdrawal

    func testWithdrawalRules() {
        typealias W = CommonGroundNearbyWithdrawal
        for trigger in [W.Trigger.turnedOff, .paused, .signedOut] {
            XCTAssertTrue(W.withdraws(trigger, enabled: false, backgroundAlerts: false))
        }
        // Leaving the app withdraws unless background operation actually works.
        XCTAssertTrue(W.withdraws(.enteredBackground(worksInBackground: false), enabled: true, backgroundAlerts: false))
        XCTAssertFalse(W.withdraws(.enteredBackground(worksInBackground: true), enabled: true, backgroundAlerts: true))
        XCTAssertFalse(W.withdraws(.enteredBackground(worksInBackground: false), enabled: false, backgroundAlerts: false))
        XCTAssertTrue(W.withdraws(.enteredBackground(worksInBackground: false), enabled: true, backgroundAlerts: true))
        XCTAssertFalse(W.worksInBackground(access: .whenInUse, backgroundAlerts: true, refreshAvailable: true, precise: true))
        XCTAssertFalse(W.worksInBackground(access: .always, backgroundAlerts: true, refreshAvailable: false, precise: true))
        XCTAssertFalse(W.worksInBackground(access: .always, backgroundAlerts: true, refreshAvailable: true, precise: false))
        XCTAssertTrue(W.worksInBackground(access: .always, backgroundAlerts: true, refreshAvailable: true, precise: true))
        // Denied or restricted access always withdraws while on.
        XCTAssertTrue(W.withdraws(.access(from: .whenInUse, to: .denied, inBackground: false), enabled: true, backgroundAlerts: false))
        XCTAssertTrue(W.withdraws(.access(from: .always, to: .restricted, inBackground: true), enabled: true, backgroundAlerts: true))
        XCTAssertFalse(W.withdraws(.access(from: .whenInUse, to: .denied, inBackground: false), enabled: false, backgroundAlerts: false))
        // Always downgraded to When In Use withdraws in the background with background alerts.
        XCTAssertTrue(W.withdraws(.access(from: .always, to: .whenInUse, inBackground: true), enabled: true, backgroundAlerts: true))
        XCTAssertFalse(W.withdraws(.access(from: .always, to: .whenInUse, inBackground: false), enabled: true, backgroundAlerts: true))
        XCTAssertFalse(W.withdraws(.access(from: .always, to: .whenInUse, inBackground: true), enabled: true, backgroundAlerts: false))
        // An upgrade or no change never withdraws.
        XCTAssertFalse(W.withdraws(.access(from: .whenInUse, to: .always, inBackground: true), enabled: true, backgroundAlerts: true))
        XCTAssertFalse(W.withdraws(.access(from: .denied, to: .denied, inBackground: true), enabled: true, backgroundAlerts: true))
    }

    // MARK: Status line

    func testStatusLine() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        typealias S = CommonGroundNearbyStatus
        let later = now.addingTimeInterval(3600)
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .notDetermined, backgroundAlerts: true,
                                 refreshAvailable: true, stale: true, updated: now, now: now), .permissionNeeded)
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .notDetermined, backgroundAlerts: false,
                                 refreshAvailable: true, stale: false, updated: nil, now: now), .permissionNeeded)
        XCTAssertEqual(S.resolve(pausedUntil: later, access: .always, backgroundAlerts: true, refreshAvailable: true, stale: true, updated: nil, now: now),
                       .paused(until: later))
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .denied, backgroundAlerts: true, refreshAvailable: true, stale: false, updated: nil, now: now), .denied)
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .always, backgroundAlerts: true, refreshAvailable: true, stale: true, updated: nil, now: now), .stale)
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .whenInUse, backgroundAlerts: true, refreshAvailable: true, stale: false, updated: nil, now: now),
                       .foregroundOnly)
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .always, backgroundAlerts: true, refreshAvailable: false, stale: false, updated: nil, now: now),
                       .foregroundOnly)
        XCTAssertEqual(S.resolve(pausedUntil: now.addingTimeInterval(-1), access: .always, backgroundAlerts: true, refreshAvailable: true, stale: false,
                                 updated: now, now: now), .background(updated: now))
        XCTAssertEqual(S.resolve(pausedUntil: nil, access: .always, precise: false, backgroundAlerts: true, refreshAvailable: true, stale: false, updated: now, now: now), .imprecise)
        XCTAssertEqual(S.updatedLine(now.addingTimeInterval(-150), now: now), "Updated 2 min ago · Works in the background")
        XCTAssertEqual(S.updatedLine(now.addingTimeInterval(-20), now: now), "Updated just now · Works in the background")
    }

    func testManualLocationUpdateExplainsWhenNearbyIsOff() {
        let name = "nearby-location-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let locator = CommonGroundNearbyLocator(defaults: defaults)
        locator.updateNow()
        XCTAssertFalse(locator.updatingNow)
        XCTAssertEqual(locator.locationError, "Turn on Nearby before updating your location.")
    }

    func testPollingBacksOffWithoutProgress() {
        let changed = Date(timeIntervalSince1970: 1_000_000)
        typealias Poll = CommonGroundNearbyPoll
        XCTAssertEqual(Poll.interval(matching: 2, lastChange: changed, now: changed.addingTimeInterval(119)), 3)
        XCTAssertEqual(Poll.interval(matching: 2, lastChange: changed, now: changed.addingTimeInterval(120)), 30)
        XCTAssertEqual(Poll.interval(matching: 0, lastChange: changed, now: changed), 30)
        XCTAssertEqual(Poll.interval(matching: 2, lastChange: changed.addingTimeInterval(121), now: changed.addingTimeInterval(122)), 3)
    }

    func testPauseEnds() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let now = try XCTUnwrap(commonGroundParseDate("2026-10-26T15:41:00Z"))
        XCTAssertEqual(CommonGroundNearbyStatus.pauseEnd(untilTomorrow: false, now: now, calendar: calendar), now.addingTimeInterval(3600))
        let tomorrow = try XCTUnwrap(commonGroundParseDate("2026-10-27T08:00:00Z"))
        XCTAssertEqual(CommonGroundNearbyStatus.pauseEnd(untilTomorrow: true, now: now, calendar: calendar), tomorrow)
    }

    // MARK: Push

    func testAlertPayload() {
        let payload: [AnyHashable: Any] = [
            "notification_type": "common_ground_nearby", "account_id": "acct_me",
            "other_account_id": "acct_maya", "alert_id": "cgna_1",
        ]
        XCTAssertEqual(CommonGroundNearbyAlertPayload(payload)?.otherAccountID, "acct_maya")
        XCTAssertEqual(CommonGroundNearbyAlertPayload(payload)?.accountID, "acct_me")
        var message = payload
        message["notification_type"] = "message"
        XCTAssertNil(CommonGroundNearbyAlertPayload(message))
        var missing = payload
        missing["other_account_id"] = ""
        XCTAssertNil(CommonGroundNearbyAlertPayload(missing))
    }

    func testCapabilityGatesNearby() throws {
        let both = try decode(CloudAuthCapabilities.self, #"{"oauthProviders": [], "commonGroundVersion": 2, "commonGroundNearbyVersion": 1}"#)
        XCTAssertEqual(both.commonGroundNearbyVersion, 1)
        XCTAssertTrue(CommonGroundAvailability.hasNearby(capabilities: both))
        XCTAssertFalse(CommonGroundAvailability.hasNearby(capabilities: CloudAuthCapabilities(commonGroundVersion: 2)))
        XCTAssertFalse(CommonGroundAvailability.hasNearby(capabilities: nil))
    }

    // MARK: Device state

    func testDeviceStateRoundTrip() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "CommonGroundNearbyTests"))
        defaults.removePersistentDomain(forName: "CommonGroundNearbyTests")
        var state = CommonGroundNearbyDeviceState(accountId: "acct_me", enabled: true, backgroundAlerts: true, lastAccess: .always)
        state.lastPostAt = Date(timeIntervalSince1970: 1_000_000)
        state.lastLatitude = 31.23
        state.lastLongitude = 121.47
        CommonGroundNearbyDeviceState.save(state, to: defaults)
        XCTAssertEqual(CommonGroundNearbyDeviceState.load(from: defaults), state)
        state.forgetLastPost()
        XCTAssertNil(state.lastPostAt)
        XCTAssertNil(state.lastLatitude)
        CommonGroundNearbyDeviceState.save(nil, to: defaults)
        XCTAssertNil(CommonGroundNearbyDeviceState.load(from: defaults))
    }
}
