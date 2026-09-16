import Foundation

/// Lifecycle of a shared plan card. Unknown server values decode as
/// `.unknown` so a newer server never blanks a whole conversation.
enum PlanCardState: String, Codable, Hashable {
    case polling
    case awaitingConfirmation = "awaiting_confirmation"
    case confirmed
    case canceled
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanCardState(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .polling: "Choosing"
        case .awaitingConfirmation: "Leaning yes"
        case .confirmed: "Confirmed"
        case .canceled: "Canceled"
        case .unknown: "Plan"
        }
    }
}

enum PlanCardRsvp: String, Codable, Hashable {
    case pending
    case yes
    case no

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanCardRsvp(rawValue: raw) ?? .pending
    }
}

struct PlanCardParticipant: Codable, Hashable, Identifiable {
    let participantId: String
    let displayName: String
    let organizer: Bool
    let rsvp: PlanCardRsvp

    var id: String { participantId }

    init(participantId: String, displayName: String, organizer: Bool, rsvp: PlanCardRsvp) {
        self.participantId = participantId
        self.displayName = displayName
        self.organizer = organizer
        self.rsvp = rsvp
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        participantId = try container.decode(String.self, forKey: .participantId)
        displayName = (try? container.decode(String.self, forKey: .displayName)) ?? "Member"
        organizer = (try? container.decode(Bool.self, forKey: .organizer)) ?? false
        rsvp = (try? container.decode(PlanCardRsvp.self, forKey: .rsvp)) ?? .pending
    }
}

/// One choice on a polling card, with the account ids that voted for it.
struct PlanCardOption: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let startAt: String?
    let endAt: String?
    let location: String?
    let votes: [String]

    init(id: String, label: String, startAt: String? = nil, endAt: String? = nil, location: String? = nil, votes: [String] = []) {
        self.id = id
        self.label = label
        self.startAt = startAt
        self.endAt = endAt
        self.location = location
        self.votes = votes
    }

    enum CodingKeys: String, CodingKey { case id, label, startAt, endAt, location, votes }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        startAt = try? container.decodeIfPresent(String.self, forKey: .startAt)
        endAt = try? container.decodeIfPresent(String.self, forKey: .endAt)
        location = try? container.decodeIfPresent(String.self, forKey: .location)
        votes = (try? container.decodeIfPresent([String].self, forKey: .votes)) ?? []
    }
}

/// Snapshot of a shared plan card as carried by a Pip message. The server
/// keeps the live card; every action returns the new snapshot.
struct PlanCard: Codable, Hashable {
    let eventId: String
    let revision: Int64
    let state: PlanCardState
    let title: String
    let startAt: String?
    let endAt: String?
    let location: String?
    let unresolvedFields: [String]
    let participants: [PlanCardParticipant]
    let options: [PlanCardOption]

    enum CodingKeys: String, CodingKey {
        case eventId, revision, state, title, startAt, endAt, location, unresolvedFields, participants, options
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try container.decode(String.self, forKey: .eventId)
        revision = try container.decode(Int64.self, forKey: .revision)
        state = (try? container.decode(PlanCardState.self, forKey: .state)) ?? .unknown
        title = try container.decode(String.self, forKey: .title)
        startAt = try container.decodeIfPresent(String.self, forKey: .startAt)
        endAt = try container.decodeIfPresent(String.self, forKey: .endAt)
        location = try container.decodeIfPresent(String.self, forKey: .location)
        unresolvedFields = (try? container.decodeIfPresent([String].self, forKey: .unresolvedFields)) ?? []
        participants = (try? container.decodeIfPresent([PlanCardParticipant].self, forKey: .participants)) ?? []
        options = (try? container.decodeIfPresent([PlanCardOption].self, forKey: .options)) ?? []
    }

    /// Voting is open while the card polls between concrete options.
    var isPolling: Bool { state == .polling && !options.isEmpty }

    /// The option with the most votes, if anyone has voted yet.
    var leadingOption: PlanCardOption? {
        options.filter { !$0.votes.isEmpty }.max { $0.votes.count < $1.votes.count }
    }

    var startDate: Date? {
        startAt.flatMap { value in
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        }
    }

    var goingCount: Int { participants.filter { $0.rsvp == .yes }.count }

    func participant(_ accountId: String?) -> PlanCardParticipant? {
        guard let accountId else { return nil }
        return participants.first { $0.participantId == accountId }
    }
}

/// One member action on a plan card, sent as the flat body
/// `/v1/cloud/plan_cards` expects.
struct PlanCardAction: Encodable, Hashable {
    let action: String
    let eventId: String
    let revision: Int64
    var participantId: String? = nil
    var rsvp: String? = nil
    var confirmedBy: String? = nil
    var canceledBy: String? = nil
    var reason: String? = nil
    var optionId: String? = nil

    static func rsvp(_ card: PlanCard, accountId: String, going: Bool) -> PlanCardAction {
        PlanCardAction(action: "rsvp", eventId: card.eventId, revision: card.revision,
                       participantId: accountId, rsvp: going ? "yes" : "no")
    }

    static func vote(_ card: PlanCard, accountId: String, optionId: String) -> PlanCardAction {
        PlanCardAction(action: "vote", eventId: card.eventId, revision: card.revision,
                       participantId: accountId, optionId: optionId)
    }

    static func confirm(_ card: PlanCard, accountId: String, optionId: String? = nil) -> PlanCardAction {
        PlanCardAction(action: "confirm", eventId: card.eventId, revision: card.revision,
                       confirmedBy: accountId, optionId: optionId)
    }
}

/// One card per plan in a transcript: the newest message carrying a card
/// renders the newest snapshot, every earlier copy keeps only its text.
struct PlanCardTranscriptResolution {
    private var latest: [String: PlanCard] = [:]
    private var holderMessageID: [String: String] = [:]

    init(messages: [ChatMessage]) {
        for message in messages {
            guard let card = message.planCard else { continue }
            holderMessageID[card.eventId] = message.id
            if let known = latest[card.eventId], known.revision >= card.revision { continue }
            latest[card.eventId] = card
        }
    }

    var isEmpty: Bool { latest.isEmpty }

    func resolve(_ message: ChatMessage) -> ChatMessage {
        guard let card = message.planCard else { return message }
        var copy = message
        if holderMessageID[card.eventId] != message.id {
            copy.planCard = nil
        } else if let newest = latest[card.eventId], newest.revision > card.revision {
            copy.planCard = newest
        } else {
            return message
        }
        return copy
    }
}
