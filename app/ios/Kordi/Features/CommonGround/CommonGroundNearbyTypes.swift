import Foundation

// Shapes of `/v1/cloud/common-ground/nearby…` (docs/development/grounding-nearby.md),
// camelCase as the server sends them. Decoding is lenient like the other
// Grounding types: a missing list is empty and a missing field takes its
// documented default.

extension KeyedDecodingContainer {
    /// The value at `key`, or `fallback` when it is missing, null or malformed.
    func cgNearbyValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

/// The account's latest location as the server holds it, fresh or not.
struct CommonGroundNearbyLocation: Decodable, Hashable {
    var capturedAt: String?
    var freshUntil: String?
    var fresh: Bool

    init(capturedAt: String? = nil, freshUntil: String? = nil, fresh: Bool = false) {
        self.capturedAt = capturedAt
        self.freshUntil = freshUntil
        self.fresh = fresh
    }

    private enum CodingKeys: String, CodingKey { case capturedAt, freshUntil, fresh }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        capturedAt = c.cgNearbyValue(.capturedAt, nil as String?)
        freshUntil = c.cgNearbyValue(.freshUntil, nil as String?)
        fresh = c.cgNearbyValue(.fresh, false)
    }

    var captured: Date? { commonGroundParseDate(capturedAt) }
}

struct CommonGroundNearbyAlerts: Codable, Hashable {
    var requests: Bool
    var matches: Bool
    var matchMinScore: Int
    var maxPerDay: Int

    init(requests: Bool = true, matches: Bool = true, matchMinScore: Int = 85, maxPerDay: Int = 3) {
        self.requests = requests
        self.matches = matches
        self.matchMinScore = matchMinScore
        self.maxPerDay = maxPerDay
    }

    private enum CodingKeys: String, CodingKey { case requests, matches, matchMinScore, maxPerDay }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requests = c.cgNearbyValue(.requests, true)
        matches = c.cgNearbyValue(.matches, true)
        matchMinScore = c.cgNearbyValue(.matchMinScore, 85)
        maxPerDay = c.cgNearbyValue(.maxPerDay, 3)
    }
}

/// `GET|PUT nearby`: the viewer's setting, filters, alerts and status.
struct CommonGroundNearbySettings: Decodable, Hashable {
    var enabled: Bool
    var participating: Bool
    var pausedUntil: String?
    var consentedAt: String?
    var profileId: String?
    var openTo: [String]
    var range: Int
    var minScore: Int
    var alerts: CommonGroundNearbyAlerts
    var location: CommonGroundNearbyLocation?
    var freshSeconds: Int

    init(enabled: Bool = false, participating: Bool = false, pausedUntil: String? = nil, consentedAt: String? = nil,
         profileId: String? = nil, openTo: [String] = [], range: Int = 2000, minScore: Int = 0,
         alerts: CommonGroundNearbyAlerts = .init(), location: CommonGroundNearbyLocation? = nil, freshSeconds: Int = 1800) {
        self.enabled = enabled
        self.participating = participating
        self.pausedUntil = pausedUntil
        self.consentedAt = consentedAt
        self.profileId = profileId
        self.openTo = openTo
        self.range = range
        self.minScore = minScore
        self.alerts = alerts
        self.location = location
        self.freshSeconds = freshSeconds
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, participating, pausedUntil, consentedAt, profileId, openTo, range, minScore, alerts, location, freshSeconds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.cgNearbyValue(.enabled, false)
        participating = c.cgNearbyValue(.participating, false)
        pausedUntil = c.cgNearbyValue(.pausedUntil, nil as String?)
        consentedAt = c.cgNearbyValue(.consentedAt, nil as String?)
        profileId = c.cgNearbyValue(.profileId, nil as String?)
        openTo = c.cgNearbyValue(.openTo, [])
        range = c.cgNearbyValue(.range, 2000)
        minScore = c.cgNearbyValue(.minScore, 0)
        alerts = c.cgNearbyValue(.alerts, CommonGroundNearbyAlerts())
        location = c.cgNearbyValue(.location, nil as CommonGroundNearbyLocation?)
        freshSeconds = c.cgNearbyValue(.freshSeconds, 1800)
    }

    var pausedUntilDate: Date? { commonGroundParseDate(pausedUntil) }

    /// Paused until a time still ahead; a passed pause has ended.
    func isPaused(now: Date = .now) -> Bool { pausedUntilDate.map { $0 > now } ?? false }

    /// On and not paused: this iPhone sends its location.
    func isSharing(now: Date = .now) -> Bool { enabled && !isPaused(now: now) }
}

/// `PUT nearby`: only the fields set are sent. `pausedUntil` `.some(nil)`
/// resumes, sent as null.
struct CommonGroundNearbyUpdate: Encodable, Hashable {
    struct Alerts: Encodable, Hashable {
        var requests: Bool?
        var matches: Bool?
        var matchMinScore: Int?
        var maxPerDay: Int?
    }

    var enabled: Bool?
    var consent: Bool?
    var profileId: String?
    var pausedUntil: String?? = nil
    var openTo: [String]?
    var openToProfileId: String?
    var range: Int?
    var minScore: Int?
    var alerts: Alerts?

    private enum CodingKeys: String, CodingKey { case enabled, consent, profileId, pausedUntil, openTo, openToProfileId, range, minScore, alerts }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        try c.encodeIfPresent(consent, forKey: .consent)
        try c.encodeIfPresent(profileId, forKey: .profileId)
        if let pausedUntil { try c.encode(pausedUntil, forKey: .pausedUntil) }
        try c.encodeIfPresent(openTo, forKey: .openTo)
        try c.encodeIfPresent(openToProfileId, forKey: .openToProfileId)
        try c.encodeIfPresent(range, forKey: .range)
        try c.encodeIfPresent(minScore, forKey: .minScore)
        try c.encodeIfPresent(alerts, forKey: .alerts)
    }
}

/// A distance band; others' distance is never more precise than this.
struct CommonGroundNearbyDistance: Decodable, Hashable {
    let minMeters: Int
    let maxMeters: Int

    init(minMeters: Int = 0, maxMeters: Int) {
        self.minMeters = minMeters
        self.maxMeters = maxMeters
    }

    private enum CodingKeys: String, CodingKey { case minMeters, maxMeters }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        minMeters = c.cgNearbyValue(.minMeters, 0)
        maxMeters = c.cgNearbyValue(.maxMeters, CommonGroundNearbyBand.ranges.last ?? 25_000)
    }

    var label: String { CommonGroundNearbyBand.label(maxMeters: maxMeters) }
}

/// One of the viewer's active requests a person meets: id and text only.
struct CommonGroundNearbyMet: Decodable, Hashable, Identifiable {
    let needId: String
    let text: String
    var id: String { needId }

    private enum CodingKeys: String, CodingKey { case needId, text }

    init(needId: String, text: String) {
        self.needId = needId
        self.text = text
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        needId = c.cgNearbyValue(.needId, "")
        text = c.cgNearbyValue(.text, "")
    }
}

/// One person in nearby search.
struct CommonGroundNearbyEntry: Decodable, Hashable, Identifiable {
    let person: CommonGroundPerson
    let relationship: CommonGroundRelationship?
    let distance: CommonGroundNearbyDistance
    let openTo: [String]
    /// "ready", "matching" or "failed".
    let status: String
    let score: Int?
    let headline: String?
    let requests: [CommonGroundNearbyMet]

    var id: String { person.accountId }

    private enum CodingKeys: String, CodingKey { case person, relationship, distance, openTo, status, score, headline, requests }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        person = try c.decode(CommonGroundPerson.self, forKey: .person)
        relationship = c.cgNearbyValue(.relationship, nil as CommonGroundRelationship?)
        distance = c.cgNearbyValue(.distance, CommonGroundNearbyDistance(maxMeters: 25_000))
        openTo = c.cgNearbyValue(.openTo, [])
        score = c.cgNearbyValue(.score, nil as Int?)
        status = c.cgNearbyValue(.status, score == nil ? "matching" : "ready")
        headline = c.cgNearbyValue(.headline, nil as String?)
        requests = c.cgNearbyValue(.requests, [])
    }

    var isMatching: Bool { status == "matching" }

    /// "92% · Under 500 m", or the band alone before a score.
    var detailLine: String {
        guard let score else { return distance.label }
        return "\(score)% · \(distance.label)"
    }
}

/// `GET nearby/people`.
struct CommonGroundNearbyPeople: Decodable, Hashable {
    let people: [CommonGroundNearbyEntry]
    /// Present people without a stored match, listed or not.
    let matching: Int
    let location: CommonGroundNearbyLocation?

    private enum CodingKeys: String, CodingKey { case people, matching, location }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        people = c.cgNearbyValue(.people, [])
        matching = c.cgNearbyValue(.matching, 0)
        location = c.cgNearbyValue(.location, nil as CommonGroundNearbyLocation?)
    }

    /// The rows: people still being matched are folded into "Matching N more".
    var shown: [CommonGroundNearbyEntry] { people.filter { !$0.isMatching } }

    /// Unmatched people that are not shown as failed rows.
    var matchingMore: Int { max(0, matching - people.filter { $0.status == "failed" }.count) }
}

/// One condition of a request, as the server checked it for one person.
struct CommonGroundNearbyCheck: Decodable, Hashable {
    let condition: Int
    let label: String
    /// "met", "unknown" or "not_met".
    let verdict: String
    /// "interest", "work", "affiliation" or "willingness".
    let kind: String?
    /// A label from their shared card, profile or Meet for activities; nil unless met.
    let evidence: String?

    private enum CodingKeys: String, CodingKey { case condition, label, verdict, kind, evidence }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        condition = c.cgNearbyValue(.condition, 0)
        label = c.cgNearbyValue(.label, "")
        verdict = c.cgNearbyValue(.verdict, "unknown")
        kind = c.cgNearbyValue(.kind, nil as String?)
        evidence = c.cgNearbyValue(.evidence, nil as String?)
    }

    var met: Bool { verdict == "met" }

    /// "Working on · Founding Loom Labs" when met, else "Not shared".
    var evidenceLine: String {
        guard met, let evidence = evidence?.trimmingCharacters(in: .whitespaces), !evidence.isEmpty else { return "Not shared" }
        let source: String? = switch kind {
        case "work": "Working on"
        case "interest": "Card"
        case "affiliation": "Profile"
        case "willingness": "Meet for"
        default: nil
        }
        return source.map { "\($0) · \(evidence)" } ?? evidence
    }
}

/// One of the viewer's requests with its checks, on the person page.
struct CommonGroundNearbyRequestChecks: Decodable, Hashable, Identifiable {
    let needId: String
    let text: String
    let met: Bool
    let checks: [CommonGroundNearbyCheck]
    var id: String { needId }

    private enum CodingKeys: String, CodingKey { case needId, text, met, checks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        needId = c.cgNearbyValue(.needId, "")
        text = c.cgNearbyValue(.text, "")
        met = c.cgNearbyValue(.met, false)
        checks = c.cgNearbyValue(.checks, [])
    }
}

/// `GET nearby/people/:id`: the entry, their shared card, the checks for
/// your requests and the match when it is stored.
struct CommonGroundNearbyPersonDetail: Decodable, Hashable {
    let entry: CommonGroundNearbyEntry
    let card: CommonGroundTopics?
    let requests: [CommonGroundNearbyRequestChecks]
    let shared: [CommonGroundReason]
    let youBring: [CommonGroundTrade]
    let theyBring: [CommonGroundTrade]
    let nextStep: String?

    private enum CodingKeys: String, CodingKey { case card, requests, shared, youBring, theyBring, nextStep }

    init(from decoder: Decoder) throws {
        entry = try CommonGroundNearbyEntry(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        card = c.cgNearbyValue(.card, nil as CommonGroundTopics?)
        requests = c.cgNearbyValue(.requests, [])
        shared = c.cgNearbyValue(.shared, [])
        youBring = c.cgNearbyValue(.youBring, [])
        theyBring = c.cgNearbyValue(.theyBring, [])
        nextStep = c.cgNearbyValue(.nextStep, nil as String?)
    }

    var person: CommonGroundPerson { entry.person }
}
