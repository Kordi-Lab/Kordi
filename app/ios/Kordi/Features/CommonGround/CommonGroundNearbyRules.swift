import Foundation

// The pure rules behind Nearby: distance bands and filter labels, when a
// location is sent, when it is withdrawn, request windows and the status
// line. Kept free of CoreLocation and UIKit so tests can drive them.

/// Distance bands and the filter values the server accepts.
enum CommonGroundNearbyBand {
    /// Band edges in meters; also the Within values.
    static let ranges = [500, 1000, 2000, 5000, 10000, 25000]
    static let scores = [0, 50, 70, 85]
    static let perDay = [1, 3, 10]
    static let alertScores = [50, 70, 85]

    /// The label for a band's `maxMeters`: the smallest band that holds it.
    static func label(maxMeters: Int) -> String {
        switch maxMeters {
        case ...500: "Under 500 m"
        case ...1000: "Under 1 km"
        case ...2000: "1–2 km"
        case ...5000: "2–5 km"
        case ...10000: "5–10 km"
        default: "10–25 km"
        }
    }

    /// "500 m", "1 km", … "25 km".
    static func rangeLabel(_ meters: Int) -> String {
        meters < 1000 ? "\(meters) m" : "\(meters / 1000) km"
    }

    static func rangePill(_ meters: Int) -> String { "Within \(rangeLabel(meters))" }

    /// "Any", "50%+", in the match menu.
    static func scoreLabel(_ score: Int) -> String { score == 0 ? "Any" : "\(score)%+" }

    static func scorePill(_ score: Int) -> String { score == 0 ? "Any match" : "\(score)%+ match" }

    static func perDayLabel(_ count: Int) -> String { "\(count) a day" }

    /// "1 person", "4 people", for Home's Nearby row.
    static func peopleCount(_ count: Int) -> String { count == 1 ? "1 person" : "\(count) people" }
}

/// Location access as Nearby reads it.
enum CommonGroundNearbyAccess: String, Codable, Equatable {
    case notDetermined
    case denied
    case restricted
    case whenInUse
    case always

    var granted: Bool { self == .whenInUse || self == .always }
}

/// When a location fix is sent.
enum CommonGroundNearbyPostRule {
    /// At most one post this often.
    static let minInterval: TimeInterval = 60
    /// A phone that has not moved posts again after this long, so it stays fresh.
    static let stillInterval: TimeInterval = 5 * 60
    /// Moves shorter than this count as not moved.
    static let stillDistance: Double = 50
    /// Fixes older than this, or less accurate, are dropped.
    static let maxAge: TimeInterval = 10 * 60
    static let maxAccuracy: Double = 2000

    enum Decision: Equatable {
        case post
        /// Old or imprecise: never sent.
        case unusable
        /// Less than a minute after the last post.
        case tooSoon
        /// Moved less than 50 m within 5 minutes of the last post.
        case unchanged
    }

    /// `moved` is the distance from the last posted point, nil without one.
    /// `force` (the Update button) skips the not-moved check only.
    static func decide(capturedAt: Date, accuracy: Double, moved: Double?, lastPostAt: Date?,
                       now: Date, force: Bool = false) -> Decision {
        guard accuracy >= 0, accuracy <= maxAccuracy, now.timeIntervalSince(capturedAt) <= maxAge else { return .unusable }
        guard let lastPostAt else { return .post }
        let since = now.timeIntervalSince(lastPostAt)
        if since < minInterval { return .tooSoon }
        if !force, since < stillInterval, let moved, moved < stillDistance { return .unchanged }
        return .post
    }
}

/// When this iPhone deletes its location from the server and stops watching.
enum CommonGroundNearbyWithdrawal {
    enum Trigger: Equatable {
        /// Location access changed; `inBackground` while the app was not active.
        case access(from: CommonGroundNearbyAccess, to: CommonGroundNearbyAccess, inBackground: Bool)
        /// The app left the foreground; see `worksInBackground`.
        case enteredBackground(worksInBackground: Bool)
        case turnedOff
        case paused
        case signedOut
    }

    /// Background operation actually works: Always access, Alerts in the
    /// background, Background App Refresh and precise location. Otherwise the
    /// phone is only seen while Kordi is open.
    static func worksInBackground(access: CommonGroundNearbyAccess, backgroundAlerts: Bool,
                                  refreshAvailable: Bool, precise: Bool) -> Bool {
        access == .always && backgroundAlerts && refreshAvailable && precise
    }

    /// `enabled`: Nearby is on and not paused on this iPhone. `backgroundAlerts`:
    /// the person chose Alerts in the background.
    static func withdraws(_ trigger: Trigger, enabled: Bool, backgroundAlerts: Bool) -> Bool {
        switch trigger {
        case .turnedOff, .paused, .signedOut:
            return true
        case .enteredBackground(let works):
            return enabled && !works
        case .access(let from, let to, let inBackground):
            guard enabled, from != to else { return false }
            if to == .denied || to == .restricted { return true }
            return from == .always && to == .whenInUse && backgroundAlerts && inBackground
        }
    }
}

/// A request's optional time window: it ends within 7 days and starts before it ends.
enum CommonGroundNearbyWindow {
    static let maxAhead: TimeInterval = 7 * 24 * 60 * 60

    enum Problem: Equatable {
        case endPassed
        case endTooFar
        case startAfterEnd
    }

    static func problem(start: Date?, end: Date?, now: Date) -> Problem? {
        if let end {
            if end <= now { return .endPassed }
            if end > now.addingTimeInterval(maxAhead) { return .endTooFar }
            if let start, start >= end { return .startAfterEnd }
        }
        return nil
    }

    static func message(_ problem: Problem) -> String {
        switch problem {
        case .endPassed, .endTooFar: "End the request within the next 7 days."
        case .startAfterEnd: "Start the request before it ends."
        }
    }

    /// "3–6 PM today", "Until 6 PM tomorrow", "Tue 3 PM – Wed 6 PM".
    static func label(start: Date?, end: Date, now: Date, calendar: Calendar = .current) -> String {
        let endTime = time(end)
        guard let start, start > now else { return "Until \(endTime) \(day(end, now: now, calendar: calendar))" }
        if calendar.isDate(start, inSameDayAs: end) {
            let startTime = time(start)
            let sameHalf = suffix(startTime) != nil && suffix(startTime) == suffix(endTime)
            let first = sameHalf ? String(startTime.dropLast(3)) : startTime
            return "\(first)–\(endTime) \(day(end, now: now, calendar: calendar))"
        }
        return "\(weekday(start)) \(time(start)) – \(weekday(end)) \(endTime)"
    }

    /// "3 PM" for 3:00 PM; minutes stay when they are not zero, and a
    /// 24-hour clock keeps its form.
    static func time(_ date: Date) -> String {
        let text = date.formatted(date: .omitted, time: .shortened)
        return suffix(text) == nil ? text : text.replacingOccurrences(of: ":00", with: "")
    }

    /// "PM" in "3:00 PM"; the formatter may separate it with a narrow space.
    private static func suffix(_ time: String) -> String? {
        let parts = time.split(whereSeparator: \.isWhitespace)
        guard parts.count == 2, ["AM", "PM"].contains(parts[1].uppercased()) else { return nil }
        return String(parts[1])
    }

    private static func day(_ date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "today" }
        if let next = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: next) { return "tomorrow" }
        return weekday(date)
    }

    private static func weekday(_ date: Date) -> String { date.formatted(.dateTime.weekday(.abbreviated)) }

    /// A request's second line: "3–6 PM today · 1 km", "No end · 2 km", "Paused" or "Ended".
    static func subtitle(_ need: CommonGroundNearbyNeed, now: Date, calendar: Calendar = .current) -> String {
        if need.isEnded { return "Ended" }
        if need.paused { return "Paused" }
        let window = need.end.map { label(start: need.start, end: $0, now: now, calendar: calendar) } ?? "No end"
        return "\(window) · \(CommonGroundNearbyBand.rangeLabel(need.range))"
    }
}

/// The line under the Sharing chip.
enum CommonGroundNearbyStatus: Equatable {
    case paused(until: Date)
    /// Location access is off: the People section says so instead.
    case denied
    /// Precise location is off, so no fix is sent.
    case imprecise
    case stale
    case foregroundOnly
    case background(updated: Date?)

    static func resolve(pausedUntil: Date?, access: CommonGroundNearbyAccess, precise: Bool = true, backgroundAlerts: Bool,
                        refreshAvailable: Bool, stale: Bool, updated: Date?, now: Date) -> CommonGroundNearbyStatus {
        if let pausedUntil, pausedUntil > now { return .paused(until: pausedUntil) }
        if access == .denied || access == .restricted { return .denied }
        if access.granted, !precise { return .imprecise }
        if stale { return .stale }
        if access != .always || !refreshAvailable || !backgroundAlerts { return .foregroundOnly }
        return .background(updated: updated)
    }

    /// "Updated 2 min ago · Works in the background".
    static func updatedLine(_ updated: Date?, now: Date) -> String {
        guard let updated else { return "Works in the background" }
        let minutes = Int(max(0, now.timeIntervalSince(updated)) / 60)
        let ago = minutes < 1 ? "Updated just now" : "Updated \(minutes) min ago"
        return "\(ago) · Works in the background"
    }

    /// "Paused until 3:00 PM", "Paused until tomorrow, 8:00 AM".
    static func pausedLine(_ until: Date, now: Date, calendar: Calendar = .current) -> String {
        let time = until.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(until, inSameDayAs: now) { return "Paused until \(time)" }
        if let next = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(until, inSameDayAs: next) {
            return "Paused until tomorrow, \(time)"
        }
        return "Paused until \(until.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }

    /// Pause for 1 hour, or until 8 AM tomorrow.
    static func pauseEnd(untilTomorrow: Bool, now: Date, calendar: Calendar = .current) -> Date {
        guard untilTomorrow else { return now.addingTimeInterval(60 * 60) }
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
}

/// How often the Nearby list is fetched while it shows: every 3 s while
/// people are being matched, for at most 2 minutes after the matching count
/// or the listed people last changed (or a filter was changed), else 30 s.
enum CommonGroundNearbyPoll {
    static let fast: TimeInterval = 3
    static let slow: TimeInterval = 30
    static let fastWindow: TimeInterval = 2 * 60

    static func interval(matching: Int, lastChange: Date, now: Date) -> TimeInterval {
        matching > 0 && now.timeIntervalSince(lastChange) < fastWindow ? fast : slow
    }

    /// The next fetch is due once `interval` has passed since the last one.
    static func isDue(lastFetch: Date?, interval: TimeInterval, now: Date) -> Bool {
        guard let lastFetch else { return true }
        return now.timeIntervalSince(lastFetch) >= interval
    }
}
