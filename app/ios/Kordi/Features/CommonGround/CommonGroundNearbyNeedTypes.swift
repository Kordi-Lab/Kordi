import Foundation

// Requests ("needs") and location posts for `/v1/cloud/common-ground/nearby…`.
// Lenient decoding through `cgNearbyValue`, as in CommonGroundNearbyTypes.swift.

/// A request ("need"): who the viewer wants to meet nearby.
struct CommonGroundNearbyNeed: Decodable, Hashable, Identifiable {
    let needId: String
    var text: String
    var range: Int
    var startsAt: String?
    var endsAt: String?
    var paused: Bool
    /// "active", "scheduled", "ended" or "paused".
    var status: String
    var revision: Int

    var id: String { needId }

    init(needId: String, text: String, range: Int = 2000, startsAt: String? = nil, endsAt: String? = nil,
         paused: Bool = false, status: String = "active", revision: Int = 1) {
        self.needId = needId
        self.text = text
        self.range = range
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.paused = paused
        self.status = status
        self.revision = revision
    }

    private enum CodingKeys: String, CodingKey { case needId, text, range, startsAt, endsAt, paused, status, revision }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        needId = try c.decode(String.self, forKey: .needId)
        text = c.cgNearbyValue(.text, "")
        range = c.cgNearbyValue(.range, 2000)
        startsAt = c.cgNearbyValue(.startsAt, nil as String?)
        endsAt = c.cgNearbyValue(.endsAt, nil as String?)
        paused = c.cgNearbyValue(.paused, false)
        status = c.cgNearbyValue(.status, paused ? "paused" : "active")
        revision = c.cgNearbyValue(.revision, 1)
    }

    var start: Date? { commonGroundParseDate(startsAt) }
    var end: Date? { commonGroundParseDate(endsAt) }
    var isEnded: Bool { status == "ended" }
}

struct CommonGroundNearbyNeedList: Decodable {
    let needs: [CommonGroundNearbyNeed]

    private enum CodingKeys: String, CodingKey { case needs }

    init(from decoder: Decoder) throws {
        needs = try decoder.container(keyedBy: CodingKeys.self).cgNearbyValue(.needs, [])
    }
}

/// `POST|PUT nearby/needs`: only the fields set are sent; a window edge
/// `.some(nil)` clears it, sent as null.
struct CommonGroundNearbyNeedDraft: Encodable, Hashable {
    var text: String?
    var range: Int?
    var startsAt: String?? = nil
    var endsAt: String?? = nil
    var paused: Bool?

    private enum CodingKeys: String, CodingKey { case text, range, startsAt, endsAt, paused }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(range, forKey: .range)
        if let startsAt { try c.encode(startsAt, forKey: .startsAt) }
        if let endsAt { try c.encode(endsAt, forKey: .endsAt) }
        try c.encodeIfPresent(paused, forKey: .paused)
    }
}

/// `POST nearby/location`, rounded to 3 decimals before it leaves the phone.
struct CommonGroundNearbyFix: Encodable, Hashable {
    let latitude: Double
    let longitude: Double
    /// Horizontal accuracy in meters.
    let accuracy: Double
    let capturedAt: String

    init(latitude: Double, longitude: Double, accuracy: Double, capturedAt: Date) {
        self.latitude = (latitude * 1000).rounded() / 1000
        self.longitude = (longitude * 1000).rounded() / 1000
        self.accuracy = accuracy.rounded()
        self.capturedAt = ISO8601DateFormatter().string(from: capturedAt)
    }
}

struct CommonGroundNearbyLocationReply: Decodable {
    let location: CommonGroundNearbyLocation?

    private enum CodingKeys: String, CodingKey { case location }

    init(from decoder: Decoder) throws {
        location = try decoder.container(keyedBy: CodingKeys.self).cgNearbyValue(.location, nil as CommonGroundNearbyLocation?)
    }
}
