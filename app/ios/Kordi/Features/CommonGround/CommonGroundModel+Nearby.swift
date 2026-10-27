import Foundation

/// Nearby's state on the Grounding model: one value, so a change anywhere
/// redraws Home's row and the Nearby screens together.
struct CommonGroundNearbyState {
    var settings: CommonGroundNearbySettings?
    var people: CommonGroundNearbyPeople?
    var needs: [CommonGroundNearbyNeed] = []
    var persons: [String: CommonGroundNearbyPersonDetail] = [:]
    /// Search answered `common_ground_nearby_no_location`.
    var noLocation = false
    /// When Home last loaded the summary, for the 30-second throttle.
    var lastSummary: Date?
    /// When the matching count or the listed people last changed, or a
    /// filter was changed: fast polling lasts 2 minutes from here.
    var peopleChangedAt: Date = .distantPast
}

extension CommonGroundNearbyPeople {
    /// What fast polling watches: the matching count and the listed people.
    var pollSignature: [String] {
        ["\(matching)"] + people.map { "\($0.id)|\($0.status)|\($0.score ?? -1)|\($0.requests.count)" }
    }
}

/// Nearby people (`commonGroundNearbyVersion` 1): settings, search, requests
/// and the nearby person. Location posts go through CommonGroundNearbyLocator.
extension CommonGroundModel {
    static let nearbyMessages: [String: String] = [
        "common_ground_nearby_off": "Turn on Nearby first.",
        "common_ground_nearby_consent_required": "Turn on Nearby first.",
        "common_ground_nearby_no_location": "Location is out of date.",
        "common_ground_nearby_too_many_needs": "You can have up to 10 requests.",
        "common_ground_nearby_need_not_found": "This request was deleted.",
        "common_ground_nearby_inaccurate": "Your location isn't precise enough.",
        "common_ground_nearby_card_changed": "The Nearby card changed. Refresh before editing its activities.",
    ]

    /// How often the poll checks whether a fetch is due.
    nonisolated static let nearbyPollTick: Duration = .seconds(3)
    static let nearbyPersonGone = "This person is no longer nearby."

    private var locator: CommonGroundNearbyLocator { .shared }

    /// On, consented, not paused and seen by others once a location arrives.
    var nearbySharing: Bool {
        guard let settings = nearby.settings else { return false }
        return settings.isSharing() && settings.participating
    }

    /// Home's Nearby row: Off, Paused or the people count; nil while unknown.
    var nearbyRowValue: String? {
        guard let settings = nearby.settings else { return nil }
        if !settings.enabled { return "Off" }
        if settings.isPaused() { return "Paused" }
        return nearby.people.map { CommonGroundNearbyBand.peopleCount($0.shown.count) }
    }

    /// The profile Nearby shares: the stored one, else the current one.
    var nearbyProfileID: String? { nearby.settings?.profileId ?? currentProfileID }

    // MARK: Settings

    /// Quiet on Home, where a failure only leaves the row without a value.
    func loadNearby(quiet: Bool = false) async {
        guard nearbyEnabled else { return }
        do {
            applyNearby(try await call { try await $0.commonGroundNearby(token: $1) })
        } catch {
            if !quiet { report(error) }
        }
    }

    func applyNearby(_ settings: CommonGroundNearbySettings) {
        nearby.settings = settings
        if !settings.enabled { nearby.people = nil }
        locator.sync(accountId: me.accountId, sharing: settings.isSharing() && settings.participating)
    }

    /// Home: the settings, then the people count when on. At most every 30 s.
    func refreshNearbySummary(now: Date = .now) async {
        guard nearbyEnabled else { return }
        if let last = nearby.lastSummary, now.timeIntervalSince(last) < Self.syncInterval { return }
        nearby.lastSummary = now
        await loadNearby(quiet: true)
        guard nearbySharing else { return }
        if nearby.settings?.location?.fresh != true { await locator.refreshOnce() }
        await loadNearbyPeople()
    }

    /// Writes `update`, showing `optimistic` at once and undoing it on failure.
    @discardableResult
    func updateNearby(_ update: CommonGroundNearbyUpdate,
                      optimistic: (inout CommonGroundNearbySettings) -> Void = { _ in }) async -> Bool {
        let previous = nearby.settings
        if var next = previous {
            optimistic(&next)
            nearby.settings = next
        }
        guard let saved = await run("nearby", { try await $0.updateCommonGroundNearby(token: $1, update: update) }) else {
            nearby.settings = previous
            return false
        }
        applyNearby(saved)
        return true
    }

    /// Consent and the card to share. Location access is asked for after
    /// the sheet closes, by the screen.
    func turnOnNearby(profileId: String?, backgroundAlerts: Bool) async -> Bool {
        let update = CommonGroundNearbyUpdate(enabled: true, consent: true, profileId: profileId, pausedUntil: .some(nil))
        guard let saved = await run("nearby", { try await $0.updateCommonGroundNearby(token: $1, update: update) }) else { return false }
        locator.turnedOn(accountId: me.accountId, backgroundAlerts: backgroundAlerts)
        nearby.noLocation = false
        applyNearby(saved)
        return true
    }

    func turnOffNearby() async {
        guard await updateNearby(CommonGroundNearbyUpdate(enabled: false), optimistic: { $0.enabled = false }) else { return }
        locator.turnedOff()
        nearby.people = nil
    }

    func pauseNearby(untilTomorrow: Bool, now: Date = .now) async {
        let until = ISO8601DateFormatter().string(from: CommonGroundNearbyStatus.pauseEnd(untilTomorrow: untilTomorrow, now: now))
        guard await updateNearby(CommonGroundNearbyUpdate(pausedUntil: .some(until)), optimistic: { $0.pausedUntil = until }) else { return }
        locator.turnedOff()
    }

    func resumeNearby() async {
        guard await updateNearby(CommonGroundNearbyUpdate(pausedUntil: .some(nil)), optimistic: { $0.pausedUntil = nil }) else { return }
        locator.startForeground()
    }

    func setNearbyProfile(_ profileId: String) async {
        guard busy == nil, profileId != nearby.settings?.profileId else { return }
        if await updateNearby(CommonGroundNearbyUpdate(profileId: profileId), optimistic: {
            $0.profileId = profileId
            $0.openTo = []
        }) {
            nearby.peopleChangedAt = .now
            await loadNearbyPeople()
        }
    }

    /// Turns one activity on or off for the card shown at the tap; at most 5.
    func toggleNearbyOpenTo(_ entry: String, profileId: String?) async {
        guard busy == nil, let profileId, let settings = nearby.settings,
              settings.profileId == profileId else { return }
        var list = settings.openTo
        if let index = list.firstIndex(where: { $0.caseInsensitiveCompare(entry) == .orderedSame }) {
            list.remove(at: index)
        } else {
            guard list.count < 5 else { return }
            list.append(entry)
        }
        if !(await updateNearby(CommonGroundNearbyUpdate(openTo: list, openToProfileId: profileId), optimistic: { $0.openTo = list })) {
            await loadNearby(quiet: true)
        }
    }

    /// A typed activity: trimmed, up to 30 characters, not a duplicate.
    func addNearbyOpenTo(_ text: String, profileId: String?) async {
        let clean = String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(30))
        guard !clean.isEmpty, let list = nearby.settings?.openTo, list.count < 5,
              !list.contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) else { return }
        await toggleNearbyOpenTo(clean, profileId: profileId)
    }

    /// Within and the minimum match are stored, then the list is fetched again.
    func setNearbyFilter(range: Int? = nil, minScore: Int? = nil) async {
        let update = CommonGroundNearbyUpdate(range: range, minScore: minScore)
        let changed = await updateNearby(update) { settings in
            if let range { settings.range = range }
            if let minScore { settings.minScore = minScore }
        }
        guard changed else { return }
        nearby.peopleChangedAt = .now
        await loadNearbyPeople()
    }

    func setNearbyAlerts(requests: Bool? = nil, matches: Bool? = nil, maxPerDay: Int? = nil) async {
        let alerts = CommonGroundNearbyUpdate.Alerts(requests: requests, matches: matches, maxPerDay: maxPerDay)
        await updateNearby(CommonGroundNearbyUpdate(alerts: alerts)) { settings in
            if let requests { settings.alerts.requests = requests }
            if let matches { settings.alerts.matches = matches }
            if let maxPerDay { settings.alerts.maxPerDay = maxPerDay }
        }
    }

    // MARK: People

    /// Search with the stored filters. Quiet: errors only change the state.
    @discardableResult
    func loadNearbyPeople() async -> Bool {
        guard nearbySharing else { return false }
        do {
            let people = try await call { try await $0.commonGroundNearbyPeople(token: $1) }
            if nearby.people?.pollSignature != people.pollSignature { nearby.peopleChangedAt = .now }
            nearby.people = people
            nearby.noLocation = false
            if let location = people.location { nearby.settings?.location = location }
            return true
        } catch let error as CloudAPIError where error.code == "common_ground_nearby_no_location" {
            nearby.noLocation = true
        } catch let error as CloudAPIError where error.code == "common_ground_nearby_off" {
            await loadNearby()
        } catch {}
        return false
    }

    /// Polls search while the Nearby screen shows (CommonGroundNearbyPoll):
    /// every 3 s while people are being matched, for 2 minutes after the
    /// last change, else every 30 s. It checks every 3 s, so a filter change
    /// or a new count brings back the fast rate at once.
    func pollNearby() async {
        var lastFetch: Date?
        var lastSettings: Date?
        while !Task.isCancelled {
            let now = Date()
            if CommonGroundNearbyPoll.isDue(lastFetch: lastSettings, interval: Self.syncInterval, now: now) {
                await loadNearby(quiet: true)
                await loadNearbyNeeds()
                lastSettings = Date()
            }
            let interval = CommonGroundNearbyPoll.interval(
                matching: nearby.people?.matchingMore ?? 0, lastChange: nearby.peopleChangedAt, now: now
            )
            if CommonGroundNearbyPoll.isDue(lastFetch: lastFetch, interval: interval, now: now) {
                await loadNearbyPeople()
                lastFetch = Date()
            }
            try? await Task.sleep(for: Self.nearbyPollTick)
        }
    }

    /// A new location was accepted: the status and the list follow.
    func nearbyLocationPosted(_ location: CommonGroundNearbyLocation?) async {
        if let location { nearby.settings?.location = location }
        nearby.noLocation = false
        await loadNearbyPeople()
    }

    /// False when the person is no longer visible through Nearby.
    @discardableResult
    func loadNearbyPerson(_ accountId: String) async -> Bool {
        do {
            let detail = try await call { try await $0.commonGroundNearbyPerson(token: $1, accountId: accountId) }
            nearby.persons[accountId] = detail
            if let relationship = detail.entry.relationship { relationships[accountId] = relationship }
            return true
        } catch let error as CloudAPIError where error.statusCode == 404 || error.code == "common_ground_nearby_off" || error.code == "common_ground_nearby_no_location" {
            nearby.persons[accountId] = nil
            notice = error.code == "common_ground_nearby_off" ? Self.nearbyMessages[error.code] : Self.nearbyPersonGone
            return false
        } catch {
            report(error)
            return nearby.persons[accountId] != nil
        }
    }

    /// Rechecks access while the person is open, with bounded fast polling.
    func waitForNearbyPerson(_ accountId: String) async -> Bool {
        var changedAt = Date()
        var signature = nearby.persons[accountId]?.entry
        while !Task.isCancelled {
            let interval = CommonGroundNearbyPoll.interval(
                matching: signature?.isMatching == true ? 1 : 0, lastChange: changedAt, now: Date()
            )
            do { try await Task.sleep(for: .seconds(interval)) } catch { return true }
            guard !Task.isCancelled else { return true }
            guard await loadNearbyPerson(accountId) else { return false }
            let next = nearby.persons[accountId]?.entry
            if next?.status != signature?.status || next?.score != signature?.score { changedAt = Date() }
            signature = next
        }
        return true
    }

    // MARK: Requests

    func loadNearbyNeeds() async {
        guard nearbyEnabled, let list = try? await call({ try await $0.commonGroundNearbyNeeds(token: $1) }) else { return }
        nearby.needs = list.needs
    }

    /// Creates a request, or edits the one with `needId`. True when saved.
    func saveNearbyNeed(_ needId: String?, draft: CommonGroundNearbyNeedDraft) async -> Bool {
        let saved: CommonGroundNearbyNeed? = if let needId {
            await run("need", { try await $0.updateCommonGroundNearbyNeed(token: $1, needId: needId, draft: draft) })
        } else {
            await run("need", { try await $0.createCommonGroundNearbyNeed(token: $1, draft: draft) })
        }
        guard let saved else { return false }
        if let index = nearby.needs.firstIndex(where: { $0.needId == saved.needId }) {
            nearby.needs[index] = saved
        } else {
            nearby.needs.insert(saved, at: 0)
        }
        await loadNearbyPeople()
        return true
    }

    func deleteNearbyNeed(_ needId: String) async -> Bool {
        guard await run("need", { try await $0.deleteCommonGroundNearbyNeed(token: $1, needId: needId) }) != nil else { return false }
        nearby.needs.removeAll { $0.needId == needId }
        await loadNearbyPeople()
        return true
    }
}
