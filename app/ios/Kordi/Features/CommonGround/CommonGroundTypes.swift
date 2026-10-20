import Foundation

// Shapes of the `/v1/cloud/common-ground` routes, camelCase as the server
// sends them. Decoding is lenient: a missing list is empty and a missing
// optional field is nil, so older servers still load.

private extension KeyedDecodingContainer {
    func cgValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

/// How the viewer is connected to a person.
struct CommonGroundRelationship: Codable, Hashable {
    var contact: Bool
    /// "incoming" or "outgoing" while a contact request is pending.
    var request: String?
    var requestId: String?
    var conversationId: String?

    init(contact: Bool = false, request: String? = nil, requestId: String? = nil, conversationId: String? = nil) {
        self.contact = contact
        self.request = request
        self.requestId = requestId
        self.conversationId = conversationId
    }
}

/// The contact action a person shows, derived from the relationship.
enum CommonGroundContactAction: Equatable {
    case add
    case requested
    case accept
    case message
    /// The server sent no relationship, so no action can be offered.
    case hidden

    init(_ relationship: CommonGroundRelationship?) {
        guard let relationship else { self = .hidden; return }
        if relationship.contact {
            self = .message
        } else if relationship.request == "incoming" {
            self = relationship.requestId == nil ? .requested : .accept
        } else if relationship.request == "outgoing" {
            self = .requested
        } else {
            self = .add
        }
    }

    var title: String {
        switch self {
        case .add: "Add"
        case .requested: "Requested"
        case .accept: "Accept"
        case .message, .hidden: "Message"
        }
    }

    var symbol: String {
        switch self {
        case .add: "person.badge.plus"
        case .requested: "clock"
        case .accept: "person.crop.circle.badge.checkmark"
        case .message, .hidden: "message"
        }
    }

    /// Meet needs both people to be contacts.
    static func canMeet(_ relationship: CommonGroundRelationship?) -> Bool {
        relationship?.contact == true
    }
}

struct CommonGroundPerson: Decodable, Hashable, Identifiable {
    let accountId: String
    let name: String
    let avatarUrl: String?
    var hasCard: Bool?
    var relationship: CommonGroundRelationship?

    var id: String { accountId }

    init(accountId: String, name: String, avatarUrl: String? = nil, hasCard: Bool? = nil, relationship: CommonGroundRelationship? = nil) {
        self.accountId = accountId
        self.name = name
        self.avatarUrl = avatarUrl
        self.hasCard = hasCard
        self.relationship = relationship
    }

    private enum CodingKeys: String, CodingKey { case accountId, name, avatarUrl, hasCard, relationship }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try c.decode(String.self, forKey: .accountId)
        name = c.cgValue(.name, "")
        avatarUrl = c.cgValue(.avatarUrl, nil as String?)
        hasCard = c.cgValue(.hasCard, nil as Bool?)
        relationship = c.cgValue(.relationship, nil as CommonGroundRelationship?)
    }

    /// The name to show; the server may send an empty one.
    var displayName: String { name.isEmpty ? "Kordi user" : name }
}

/// The four topic lists of a card.
struct CommonGroundTopics: Codable, Hashable {
    var workingOn: [String]
    var interests: [String]
    var canHelp: [String]
    var lookingFor: [String]

    init(workingOn: [String] = [], interests: [String] = [], canHelp: [String] = [], lookingFor: [String] = []) {
        self.workingOn = workingOn
        self.interests = interests
        self.canHelp = canHelp
        self.lookingFor = lookingFor
    }

    private enum CodingKeys: String, CodingKey { case workingOn, interests, canHelp, lookingFor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workingOn = c.cgValue(.workingOn, [])
        interests = c.cgValue(.interests, [])
        canHelp = c.cgValue(.canHelp, [])
        lookingFor = c.cgValue(.lookingFor, [])
    }

    static let sections: [(title: String, key: WritableKeyPath<CommonGroundTopics, [String]>)] = [
        ("Working on", \.workingOn),
        ("Interests", \.interests),
        ("Can help with", \.canHelp),
        ("Looking for", \.lookingFor),
    ]

    var all: [String] { workingOn + interests + canHelp + lookingFor }
}

/// Where each topic came from and when it was active. Only the owner sees it.
struct CommonGroundProfile: Decodable, Hashable {
    struct Period: Decodable, Hashable {
        let period: String
        let topics: [String]
    }

    struct TopicInfo: Decodable, Hashable {
        let refs: [String]
        let firstSeen: String?
        let lastSeen: String?
    }

    struct Evidence: Decodable, Hashable {
        let source: String
        let title: String
        let date: String?
        let url: String?
        let snippet: String
    }

    var latest: [String]
    var earlier: [String]
    var timeline: [Period]
    var topics: [String: TopicInfo]
    var evidence: [String: Evidence]

    private enum CodingKeys: String, CodingKey { case latest, earlier, timeline, topics, evidence }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        latest = c.cgValue(.latest, [])
        earlier = c.cgValue(.earlier, [])
        timeline = c.cgValue(.timeline, [])
        topics = c.cgValue(.topics, [:])
        evidence = c.cgValue(.evidence, [:])
    }

    func evidence(for label: String) -> [(id: String, item: Evidence)] {
        (topics[label]?.refs ?? []).compactMap { id in evidence[id].map { (id, $0) } }
    }
}

struct CommonGroundOwnCard: Decodable, Hashable {
    var topics: CommonGroundTopics
    var hidden: [String]
    let revision: Int
    let builtAt: String?
    let profile: CommonGroundProfile?

    private enum CodingKeys: String, CodingKey { case hidden, revision, builtAt, profile }

    init(from decoder: Decoder) throws {
        topics = try CommonGroundTopics(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hidden = c.cgValue(.hidden, [])
        revision = c.cgValue(.revision, 0)
        builtAt = c.cgValue(.builtAt, nil as String?)
        profile = c.cgValue(.profile, nil as CommonGroundProfile?)
    }
}

struct CommonGroundBuildState: Decodable, Hashable {
    /// "idle", "building" or "failed".
    let status: String
    let errorCode: String?
}

/// `GET card`: the owner's card, sharing and the build state.
struct CommonGroundOwnerView: Decodable, Hashable {
    var card: CommonGroundOwnCard?
    var sharing: Bool
    var build: CommonGroundBuildState

    private enum CodingKeys: String, CodingKey { case card, sharing, build }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        card = c.cgValue(.card, nil as CommonGroundOwnCard?)
        sharing = c.cgValue(.sharing, true)
        build = c.cgValue(.build, CommonGroundBuildState(status: "idle", errorCode: nil))
    }
}

struct CommonGroundDeviceItem: Codable, Hashable { let title: String; let date: String? }
struct CommonGroundDeviceItems: Encodable, Hashable { let source: String; let items: [CommonGroundDeviceItem] }

struct CommonGroundBuildRequest: Encodable, Hashable {
    var memory: Bool
    var connectors: Bool
    var device: [CommonGroundDeviceItems]
    var links: String
    var notes: String
}

/// Someone's shared card: topics only.
struct CommonGroundPersonCard: Decodable, Hashable {
    let person: CommonGroundPerson
    let card: CommonGroundTopics
    let relationship: CommonGroundRelationship?
}

struct CommonGroundPairCode: Decodable, Hashable {
    let code: String
    let expiresAt: String

    var expiry: Date? { commonGroundParseDate(expiresAt) }
}

struct CommonGroundRecentEntry: Decodable, Hashable, Identifiable {
    let person: CommonGroundPerson
    let score: Int?
    let headline: String?
    let relationship: CommonGroundRelationship?
    var id: String { person.accountId }
}

struct CommonGroundGroup: Decodable, Hashable, Identifiable {
    let groupSpaceId: String
    let conversationId: String?
    let name: String
    let memberCount: Int
    let createdBy: CommonGroundPerson?
    var joined: Bool
    /// The shared topic the group was started from.
    var topic: String?
    var id: String { groupSpaceId }

    init(groupSpaceId: String, conversationId: String?, name: String, memberCount: Int, createdBy: CommonGroundPerson? = nil, joined: Bool, topic: String? = nil) {
        self.groupSpaceId = groupSpaceId
        self.conversationId = conversationId
        self.name = name
        self.memberCount = memberCount
        self.createdBy = createdBy
        self.joined = joined
        self.topic = topic
    }

    private enum CodingKeys: String, CodingKey { case groupSpaceId, conversationId, name, memberCount, createdBy, joined, topic }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groupSpaceId = try c.decode(String.self, forKey: .groupSpaceId)
        conversationId = c.cgValue(.conversationId, nil as String?)
        name = c.cgValue(.name, "")
        memberCount = c.cgValue(.memberCount, 0)
        createdBy = c.cgValue(.createdBy, nil as CommonGroundPerson?)
        joined = c.cgValue(.joined, false)
        topic = c.cgValue(.topic, nil as String?)
    }
}

struct CommonGroundInvitation: Decodable, Hashable, Identifiable {
    let invitationRef: String
    let groupSpaceId: String
    let name: String
    let from: CommonGroundPerson
    var id: String { invitationRef }
}

struct CommonGroundRoom: Decodable, Hashable {
    let code: String
    let name: String
    let openedByYou: Bool
    /// False once the room is closed; its results stay readable.
    let open: Bool
    let expiresAt: String?
    /// Everyone in the room except you.
    let members: [CommonGroundPerson]
    var groups: [CommonGroundGroup]
    var invitations: [CommonGroundInvitation]

    private enum CodingKeys: String, CodingKey { case code, name, openedByYou, open, expiresAt, members, groups, invitations }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        name = c.cgValue(.name, "")
        openedByYou = c.cgValue(.openedByYou, false)
        open = c.cgValue(.open, true)
        expiresAt = c.cgValue(.expiresAt, nil as String?)
        members = c.cgValue(.members, [])
        groups = c.cgValue(.groups, [])
        invitations = c.cgValue(.invitations, [])
    }

    var title: String { name.trimmingCharacters(in: .whitespaces).isEmpty ? "Room \(code)" : name }
}

struct CommonGroundTheme: Decodable, Hashable, Identifiable {
    let label: String
    let people: [CommonGroundPerson]
    var id: String { label }
}

struct CommonGroundRanked: Decodable, Hashable, Identifiable {
    let person: CommonGroundPerson
    let score: Int
    let headline: String
    let relationship: CommonGroundRelationship?
    var id: String { person.accountId }
}

struct CommonGroundResults: Decodable, Hashable {
    /// "ready", "matching" or "failed".
    let status: String
    let people: [CommonGroundRanked]
    let topics: [CommonGroundTheme]
    let suggestion: CommonGroundTheme?
    var groups: [CommonGroundGroup]
    var invitations: [CommonGroundInvitation]

    private enum CodingKeys: String, CodingKey { case status, people, topics, suggestion, groups, invitations }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.cgValue(.status, "ready")
        people = c.cgValue(.people, [])
        topics = c.cgValue(.topics, [])
        suggestion = c.cgValue(.suggestion, nil as CommonGroundTheme?)
        groups = c.cgValue(.groups, [])
        invitations = c.cgValue(.invitations, [])
    }

    var isMatching: Bool { status == "matching" }
}

struct CommonGroundReason: Decodable, Hashable {
    let topic: String
    let theirTopic: String
    let why: String
}

/// A skill one person offers and the other person's topic it helps.
struct CommonGroundTrade: Decodable, Hashable {
    let topic: String
    let target: String
    let why: String

    private enum CodingKeys: String, CodingKey {
        case topic, why
        case target = "for"
    }
}

/// `GET people/:id/match`: 200 with `status: ready` and the match, or 202
/// with `status: matching|failed` while it is being found.
struct CommonGroundMatch: Decodable, Hashable {
    let status: String
    let person: CommonGroundPerson
    let score: Int?
    let headline: String?
    let shared: [CommonGroundReason]
    let youBring: [CommonGroundTrade]
    let theyBring: [CommonGroundTrade]
    let nextStep: String?
    let relationship: CommonGroundRelationship?

    private enum CodingKeys: String, CodingKey {
        case status, person, score, headline, shared, youBring, theyBring, nextStep, relationship
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        person = try c.decode(CommonGroundPerson.self, forKey: .person)
        score = c.cgValue(.score, nil as Int?)
        status = c.cgValue(.status, score == nil ? "matching" : "ready")
        headline = c.cgValue(.headline, nil as String?)
        shared = c.cgValue(.shared, [])
        youBring = c.cgValue(.youBring, [])
        theyBring = c.cgValue(.theyBring, [])
        nextStep = c.cgValue(.nextStep, nil as String?)
        relationship = c.cgValue(.relationship, nil as CommonGroundRelationship?)
    }

    var isReady: Bool { status == "ready" }
    var isMatching: Bool { status == "matching" }
}

struct CommonGroundMeetInput: Encodable, Hashable {
    var title: String?
    var startAt: String
    var endAt: String?
    var location: String?
}

struct CommonGroundCreatedGroup: Decodable, Hashable {
    let group: CommonGroundGroup
    let added: [CommonGroundPerson]
    let invited: [CommonGroundPerson]
}

struct CommonGroundJoinedGroup: Decodable, Hashable {
    let status: String?
    let groupSpaceId: String
    let conversationId: String?
    let name: String?
}

struct CommonGroundRelationshipResponse: Decodable, Hashable { let relationship: CommonGroundRelationship }

struct CommonGroundChatResponse: Decodable, Hashable {
    let conversationId: String
    let sessionId: String?
    let relationship: CommonGroundRelationship?
}

struct CommonGroundMeetResponse: Decodable, Hashable {
    let conversationId: String
    let planCardId: String?
    let relationship: CommonGroundRelationship?
}

struct CommonGroundPeopleResponse<Entry: Decodable>: Decodable { let people: [Entry] }

/// RFC 3339 with or without fractional seconds.
func commonGroundParseDate(_ raw: String?) -> Date? {
    guard let raw else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: raw) { return date }
    return ISO8601DateFormatter().date(from: raw)
}
