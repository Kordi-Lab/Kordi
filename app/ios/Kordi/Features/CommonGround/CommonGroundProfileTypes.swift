import Foundation

// Profiles (`commonGroundVersion` 2): a person keeps up to five cards, one
// per profile, and shares exactly one profile in each room or pairing.

private extension KeyedDecodingContainer {
    func cgProfileValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

enum CommonGroundProfileKind: String, CaseIterable, Identifiable {
    case work, health, daily, custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .work: "Work"
        case .health: "Health"
        case .daily: "Daily tasks"
        case .custom: "Custom"
        }
    }

    /// Work, Health and Daily tasks exist at most once per person.
    var isFixed: Bool { self != .custom }
}

/// `{profileId, kind, name, focus, design, icon}`: a profile as a card, room or person carries it.
struct CommonGroundProfileTag: Codable, Hashable {
    let profileId: String
    let kind: String
    let name: String
    var focus: String?
    /// The card's design; nil means the kind's default.
    var design: String?
    /// The card's icon; nil means the design's glyph.
    var icon: String?

    init(profileId: String, kind: String, name: String, focus: String? = nil, design: String? = nil, icon: String? = nil) {
        self.profileId = profileId
        self.kind = kind
        self.name = name
        self.focus = focus
        self.design = design
        self.icon = icon
    }

    private enum CodingKeys: String, CodingKey { case profileId, kind, name, focus, design, icon }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profileId = c.cgProfileValue(.profileId, "")
        kind = c.cgProfileValue(.kind, "work")
        name = c.cgProfileValue(.name, "")
        focus = c.cgProfileValue(.focus, nil as String?)
        design = c.cgProfileValue(.design, nil as String?)
        icon = c.cgProfileValue(.icon, nil as String?)
    }

    var title: String { CommonGroundProfileSummary.title(kind: kind, name: name) }
    var cardDesign: CommonGroundCardDesign { .of(kind: kind, name: name, design: design) }
    var cardIcon: CommonGroundCardIcon? { icon.flatMap(CommonGroundCardIcon.init(rawValue:)) }
    var kindDesign: CommonGroundCardDesign { .of(kind: kind, name: name) }

    /// The label beside a person's name; nil for Work, which needs none.
    var badge: String? { kind == CommonGroundProfileKind.work.rawValue ? nil : title }
}

/// One entry of `GET profiles`, as the owner sees it.
struct CommonGroundProfileSummary: Decodable, Hashable, Identifiable {
    let profileId: String
    let kind: String
    var name: String
    var focus: String?
    let position: Int
    var hasCard: Bool
    var sharing: Bool
    var builtAt: String?
    var topicCount: Int
    /// The card's design; nil means the kind's default.
    var design: String?
    /// The card's icon; nil means the design's glyph.
    var icon: String?
    /// The card's saved source picks; nil until first saved or before version 3.
    var sources: CommonGroundSourcePicks?

    var id: String { profileId }

    init(profileId: String, kind: String, name: String, focus: String? = nil, position: Int = 0,
         hasCard: Bool = false, sharing: Bool = true, builtAt: String? = nil, topicCount: Int = 0, design: String? = nil, icon: String? = nil,
         sources: CommonGroundSourcePicks? = nil) {
        self.profileId = profileId
        self.kind = kind
        self.name = name
        self.focus = focus
        self.position = position
        self.hasCard = hasCard
        self.sharing = sharing
        self.builtAt = builtAt
        self.topicCount = topicCount
        self.design = design
        self.icon = icon
        self.sources = sources
    }

    private enum CodingKeys: String, CodingKey {
        case profileId, kind, name, focus, position, hasCard, sharing, builtAt, topicCount, design, icon, sources
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profileId = try c.decode(String.self, forKey: .profileId)
        kind = c.cgProfileValue(.kind, "work")
        name = c.cgProfileValue(.name, "")
        focus = c.cgProfileValue(.focus, nil as String?)
        position = c.cgProfileValue(.position, 0)
        hasCard = c.cgProfileValue(.hasCard, false)
        sharing = c.cgProfileValue(.sharing, true)
        builtAt = c.cgProfileValue(.builtAt, nil as String?)
        topicCount = c.cgProfileValue(.topicCount, 0)
        design = c.cgProfileValue(.design, nil as String?)
        icon = c.cgProfileValue(.icon, nil as String?)
        sources = c.cgProfileValue(.sources, nil as CommonGroundSourcePicks?)
    }

    var cardDesign: CommonGroundCardDesign { .of(kind: kind, name: name, design: design) }
    var cardIcon: CommonGroundCardIcon? { icon.flatMap(CommonGroundCardIcon.init(rawValue:)) }
    /// The design the kind (or a custom card's name) gives, whose glyph a colour keeps.
    var kindDesign: CommonGroundCardDesign { .of(kind: kind, name: name) }
    /// The glyph the card draws: its icon, else its design's or kind's.
    var glyphSymbol: String { cardIcon?.symbol ?? cardDesign.glyph(kind: kindDesign) }
    var profileKind: CommonGroundProfileKind? { CommonGroundProfileKind(rawValue: kind) }
    var title: String { Self.title(kind: kind, name: name) }
    var isWork: Bool { kind == CommonGroundProfileKind.work.rawValue }
    var focusLine: String? {
        guard let focus = focus?.trimmingCharacters(in: .whitespacesAndNewlines), !focus.isEmpty else { return nil }
        return focus
    }

    /// "Build your profile" for Work, "Build your Health profile" otherwise.
    var buildTitle: String { isWork ? "Build your profile" : "Build your \(title) profile" }

    static func title(kind: String, name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { return trimmed }
        return CommonGroundProfileKind(rawValue: kind)?.title ?? "Profile"
    }
}

struct CommonGroundProfileList: Decodable {
    let profiles: [CommonGroundProfileSummary]

    private enum CodingKeys: String, CodingKey { case profiles }

    init(from decoder: Decoder) throws {
        profiles = try decoder.container(keyedBy: CodingKeys.self).cgProfileValue(.profiles, [])
    }
}

/// `POST profiles`.
struct CommonGroundNewProfile: Encodable, Hashable {
    var kind: String
    var name: String?
    var focus: String?
    var design: String?
    var icon: String?

    /// Trims the fields and drops empty ones; a fixed kind sends no name.
    init(kind: CommonGroundProfileKind, name: String = "", focus: String = "", design: CommonGroundCardDesign? = nil,
         icon: CommonGroundCardIcon? = nil) {
        self.kind = kind.rawValue
        self.design = design?.rawValue
        self.icon = icon?.rawValue
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let focus = focus.trimmingCharacters(in: .whitespacesAndNewlines)
        self.name = kind.isFixed || name.isEmpty ? nil : name
        self.focus = focus.isEmpty ? nil : focus
    }

    var isValid: Bool { kind != CommonGroundProfileKind.custom.rawValue || name != nil }
}

/// `PUT profiles/:id`; nil leaves a field, an empty focus clears it.
/// `icon` is left out when nil, sent as null when `.some(nil)` (back to the design's glyph).
/// `sources` likewise; null forgets the picks.
struct CommonGroundProfileEdit: Encodable, Hashable {
    var name: String?
    var focus: String?
    var design: String?
    var icon: String?? = nil
    var sources: CommonGroundSourcePicks?? = nil

    private enum CodingKeys: String, CodingKey { case name, focus, design, icon, sources }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(focus, forKey: .focus)
        try c.encodeIfPresent(design, forKey: .design)
        if let icon { try c.encode(icon, forKey: .icon) }
        if let sources { try c.encode(sources, forKey: .sources) }
    }
}

/// `POST rooms/:code/join`. `name` and `kind` apply only when this join opens the room.
struct CommonGroundJoinRequest: Encodable, Hashable {
    var name: String?
    var kind: String?
    var profileId: String?
}

/// Which profile is current on Home, per account, and which one a join shares.
enum CommonGroundProfileChoice {
    static func key(account: String) -> String { "commonGround.currentProfile.\(account)" }

    static func saved(account: String, defaults: UserDefaults) -> String? {
        defaults.string(forKey: key(account: account))
    }

    static func save(_ profileId: String?, account: String, defaults: UserDefaults) {
        if let profileId { defaults.set(profileId, forKey: key(account: account)) } else { defaults.removeObject(forKey: key(account: account)) }
    }

    /// The saved profile when it still exists, else Work, else the first one.
    static func current(saved: String?, in profiles: [CommonGroundProfileSummary]) -> String? {
        if let saved, profiles.contains(where: { $0.profileId == saved }) { return saved }
        return (profiles.first(where: \.isWork) ?? profiles.first)?.profileId
    }

    /// The card a room suggests: the first one with a card of the room's kind.
    static func suggested(roomKind: String?, in choices: [CommonGroundProfileSummary]) -> String? {
        guard let roomKind else { return nil }
        return choices.first { $0.kind == roomKind }?.profileId
    }

    /// The profile a join preselects: one of the room's kind with a card,
    /// else the current profile, else the first one with a card.
    static func preselected(roomKind: String?, current: String?, in choices: [CommonGroundProfileSummary]) -> String? {
        if let match = suggested(roomKind: roomKind, in: choices) { return match }
        if let current, choices.contains(where: { $0.profileId == current }) { return current }
        return choices.first?.profileId
    }
}
