import Foundation

// Wire models for AI access settings, actions that need a person, and "About
// this reply". Every field is optional on read and every decoder is lenient:
// an older or newer server may omit or reshape a field, and that must never
// break chat sync or the screens that show these values.

/// A JSON object key that the app does not have to know ahead of time.
struct AgentTrustJSONKey: CodingKey, Hashable {
    let stringValue: String
    var intValue: Int? { nil }

    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

extension KeyedDecodingContainer where Key == AgentTrustJSONKey {
    func lenientString(_ key: String) -> String? {
        guard let value = try? decodeIfPresent(String.self, forKey: AgentTrustJSONKey(key)) else { return nil }
        return value.nonEmpty
    }

    func lenientBool(_ key: String) -> Bool? {
        guard let value = try? decodeIfPresent(Bool.self, forKey: AgentTrustJSONKey(key)) else { return nil }
        return value
    }

    func lenientInt(_ key: String) -> Int? {
        guard let value = try? decodeIfPresent(Int.self, forKey: AgentTrustJSONKey(key)) else { return nil }
        return value
    }

    /// The nested object at `key`, or `nil` when it is missing, `null`, or not an object.
    func lenientObject(_ key: String) -> KeyedDecodingContainer<AgentTrustJSONKey>? {
        try? nestedContainer(keyedBy: AgentTrustJSONKey.self, forKey: AgentTrustJSONKey(key))
    }

    /// Decodes `T` only when the value at `key` is an object.
    func lenientDecode<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        guard lenientObject(key) != nil else { return nil }
        return try? decode(T.self, forKey: AgentTrustJSONKey(key))
    }

    /// The array at `key`, skipping elements that fail to decode.
    func lenientArray<T: Decodable>(of type: T.Type, _ key: String) -> [T] {
        guard let items = try? decodeIfPresent([LenientAgentTrustElement<T>].self, forKey: AgentTrustJSONKey(key)) else {
            return []
        }
        return items.compactMap(\.value)
    }

    func lenientStrings(_ key: String) -> [String] {
        var seen = Set<String>()
        return lenientArray(of: String.self, key).compactMap(\.nonEmpty).filter { seen.insert($0).inserted }
    }
}

/// One array element whose failure to decode is recorded as `nil` instead of
/// failing the whole array.
private struct LenientAgentTrustElement<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

// MARK: - AI access

enum CloudAIHistoryScope: String, Hashable, CaseIterable, Identifiable {
    /// Agents asked here see only messages sent to them.
    case mentions
    /// Agents asked here can also read recent messages.
    case recent

    var id: String { rawValue }
}

struct CloudPipAccess: Hashable {
    var available: Bool
    /// The setting is on and PiP is an active member.
    var enabled: Bool
    var providerLabel: String?

    init(available: Bool, enabled: Bool, providerLabel: String? = nil) {
        self.available = available
        self.enabled = enabled
        self.providerLabel = providerLabel
    }

    init(_ container: KeyedDecodingContainer<AgentTrustJSONKey>) {
        available = container.lenientBool("available") ?? false
        enabled = container.lenientBool("enabled") ?? false
        providerLabel = container.lenientString("provider_label")
    }
}

/// `ai_access` on a conversation, as the signed-in member sees it.
///
/// `CloudChatConversation` deliberately does not declare this field: unknown
/// keys stay ignored there, so a malformed value can never fail chat sync.
struct CloudAIAccess: Decodable, Hashable {
    var historyScope: CloudAIHistoryScope
    /// PiP's state in a group; `nil` for direct conversations.
    var pip: CloudPipAccess?
    /// Active members who turned on "Don't let AI use my messages".
    var excludedMemberIds: [String]
    var viewerExcluded: Bool
    var viewerCanManage: Bool

    init(
        historyScope: CloudAIHistoryScope = .mentions,
        pip: CloudPipAccess? = nil,
        excludedMemberIds: [String] = [],
        viewerExcluded: Bool = false,
        viewerCanManage: Bool = false
    ) {
        self.historyScope = historyScope
        self.pip = pip
        self.excludedMemberIds = excludedMemberIds
        self.viewerExcluded = viewerExcluded
        self.viewerCanManage = viewerCanManage
    }

    /// Never throws: a missing or malformed field falls back to its default.
    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        self.init(container)
    }

    init(_ container: KeyedDecodingContainer<AgentTrustJSONKey>?) {
        historyScope = container?.lenientString("history_scope") == CloudAIHistoryScope.recent.rawValue
            ? .recent
            : .mentions
        pip = container?.lenientObject("pip").map(CloudPipAccess.init)
        excludedMemberIds = container?.lenientStrings("excluded_member_ids") ?? []
        viewerExcluded = container?.lenientBool("viewer_excluded") ?? false
        viewerCanManage = container?.lenientBool("viewer_can_manage") ?? false
    }

    /// `ai_access` inside an object, or `nil` when it is absent or not an object.
    static func embedded(in container: KeyedDecodingContainer<AgentTrustJSONKey>?) -> CloudAIAccess? {
        container?.lenientObject("ai_access").map { CloudAIAccess($0) }
    }
}

/// `GET /v2/chat/ai-features`.
struct CloudAIFeatures: Decodable, Hashable {
    var pipAvailable: Bool
    var pipProviderLabel: String?

    init(pipAvailable: Bool, pipProviderLabel: String? = nil) {
        self.pipAvailable = pipAvailable
        self.pipProviderLabel = pipProviderLabel
    }

    init(from decoder: Decoder) throws {
        let pip = (try? decoder.container(keyedBy: AgentTrustJSONKey.self))?.lenientObject("pip")
        pipAvailable = pip?.lenientBool("available") ?? false
        pipProviderLabel = pip?.lenientString("provider_label")
    }
}

/// One AI access change. The server accepts exactly one per request.
enum CloudAIAccessChange: Hashable {
    case historyScope(CloudAIHistoryScope)
    case pipEnabled(Bool)
    case excludeMyMessages(Bool)
}

struct CloudAIAccessChangeRequest: Encodable {
    let clientOperationId: String
    let change: CloudAIAccessChange

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AgentTrustJSONKey.self)
        try container.encode(clientOperationId, forKey: AgentTrustJSONKey("client_operation_id"))
        switch change {
        case .historyScope(let scope):
            try container.encode(scope.rawValue, forKey: AgentTrustJSONKey("history_scope"))
        case .pipEnabled(let enabled):
            try container.encode(enabled, forKey: AgentTrustJSONKey("pip_enabled"))
        case .excludeMyMessages(let excluded):
            try container.encode(excluded, forKey: AgentTrustJSONKey("exclude_my_messages"))
        }
    }
}

/// `GET …/ai-access` returns `{conversation_id, ai_access}`; `PUT` returns
/// `{conversation}` whose snapshot carries `ai_access`.
struct CloudAIAccessResponse: Decodable {
    let aiAccess: CloudAIAccess?
    let conversation: CloudChatConversation?

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        conversation = container?.lenientDecode(CloudChatConversation.self, "conversation")
        aiAccess = CloudAIAccess.embedded(in: container)
            ?? CloudAIAccess.embedded(in: container?.lenientObject("conversation"))
    }
}

// MARK: - Actions that need a person

/// Something an agent or PiP wants to do that waits for a person.
struct CloudPendingAgentAction: Decodable, Hashable, Identifiable {
    enum Kind: String, Hashable, CaseIterable {
        case calendarDisclosure = "calendar_disclosure"
        case planRSVP = "plan_rsvp"
        case planVote = "plan_vote"
        case planConfirm = "plan_confirm"
        case planCancel = "plan_cancel"
        case planReopen = "plan_reopen"
    }

    struct Proposer: Hashable {
        var accountId: String?
        var displayName: String?
        var isPip: Bool
    }

    /// The fields each kind describes. Unknown or malformed fields are `nil`.
    struct Subject: Hashable {
        var agentId: String?
        var agentName: String?
        var startAt: String?
        var endAt: String?
        var conversationTitle: String?
        var eventId: String?
        var title: String?
        var location: String?
        var rsvp: String?
        var note: String?
        var optionId: String?
        var optionLabel: String?
        var revision: Int?
        var reason: String?

        init(
            agentId: String? = nil, agentName: String? = nil, startAt: String? = nil, endAt: String? = nil,
            conversationTitle: String? = nil, eventId: String? = nil, title: String? = nil,
            location: String? = nil, rsvp: String? = nil, note: String? = nil, optionId: String? = nil,
            optionLabel: String? = nil, revision: Int? = nil, reason: String? = nil
        ) {
            self.agentId = agentId
            self.agentName = agentName
            self.startAt = startAt
            self.endAt = endAt
            self.conversationTitle = conversationTitle
            self.eventId = eventId
            self.title = title
            self.location = location
            self.rsvp = rsvp
            self.note = note
            self.optionId = optionId
            self.optionLabel = optionLabel
            self.revision = revision
            self.reason = reason
        }

        init(_ container: KeyedDecodingContainer<AgentTrustJSONKey>?) {
            self.init(
                agentId: container?.lenientString("agentId"),
                agentName: container?.lenientString("agentName"),
                startAt: container?.lenientString("startAt"),
                endAt: container?.lenientString("endAt"),
                conversationTitle: container?.lenientString("conversationTitle"),
                eventId: container?.lenientString("eventId"),
                title: container?.lenientString("title"),
                location: container?.lenientString("location"),
                rsvp: container?.lenientString("rsvp"),
                note: container?.lenientString("note"),
                optionId: container?.lenientString("optionId"),
                optionLabel: container?.lenientString("optionLabel"),
                revision: container?.lenientInt("revision"),
                reason: container?.lenientString("reason")
            )
        }
    }

    var actionId: String
    /// `nil` for a kind this app does not know; such actions are not shown.
    var kind: Kind?
    var sessionId: String?
    var conversationId: String?
    var status: String
    var createdAt: String?
    var expiresAt: String?
    var proposedBy: Proposer
    var subject: Subject

    var id: String { actionId }

    /// Only pending actions of a known kind can be shown and decided.
    var isActionable: Bool { !actionId.isEmpty && kind != nil && status == "pending" }

    init(
        actionId: String, kind: Kind?, sessionId: String? = nil, conversationId: String? = nil,
        status: String = "pending", createdAt: String? = nil, expiresAt: String? = nil,
        proposedBy: Proposer = Proposer(accountId: nil, displayName: nil, isPip: false),
        subject: Subject = Subject()
    ) {
        self.actionId = actionId
        self.kind = kind
        self.sessionId = sessionId
        self.conversationId = conversationId
        self.status = status
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.proposedBy = proposedBy
        self.subject = subject
    }

    /// Never throws: an action without an id or with an unknown kind decodes
    /// as not actionable and is dropped by the list.
    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        let proposer = container?.lenientObject("proposedBy")
        self.init(
            actionId: container?.lenientString("actionId") ?? "",
            kind: container?.lenientString("kind").flatMap(Kind.init(rawValue:)),
            sessionId: container?.lenientString("sessionId"),
            conversationId: container?.lenientString("conversationId"),
            status: container?.lenientString("status") ?? "pending",
            createdAt: container?.lenientString("createdAt"),
            expiresAt: container?.lenientString("expiresAt"),
            proposedBy: Proposer(
                accountId: proposer?.lenientString("accountId"),
                displayName: proposer?.lenientString("displayName"),
                isPip: proposer?.lenientString("kind") == "pip"
            ),
            subject: Subject(container?.lenientObject("subject"))
        )
    }
}

enum CloudAgentActionDecision: String, Hashable {
    case approve
    case decline
}

struct CloudPendingAgentActionList: Decodable {
    let actions: [CloudPendingAgentAction]

    init(actions: [CloudPendingAgentAction]) { self.actions = actions }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        actions = (container?.lenientArray(of: CloudPendingAgentAction.self, "actions") ?? [])
            .filter(\.isActionable)
    }
}

struct CloudAgentActionDecisionResponse: Decodable {
    let action: CloudPendingAgentAction?

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        action = container?.lenientDecode(CloudPendingAgentAction.self, "action")
    }
}

struct CloudAgentActionDecisionRequest: Encodable {
    let decision: String
}

// MARK: - About this reply

struct CloudAgentReplyDisclosureRequest: Encodable, Hashable {
    /// The client's key for the reply; echoed back.
    let key: String
    /// The request the reply answers.
    let requestId: String
    let ownerAccountId: String
}

struct CloudAgentReplyDisclosuresRequest: Encodable {
    let sessionId: String
    let replies: [CloudAgentReplyDisclosureRequest]
}

/// Who wrote an agent reply and where it ran, as Kordi recorded the run.
struct CloudAgentReplyDisclosure: Decodable, Hashable {
    enum Runtime: String, Hashable {
        case kordiCloud = "kordi_cloud"
        case ownerDevice = "owner_device"
    }

    enum Credentials: String, Hashable {
        case owner
        case kordi
    }

    var key: String
    var agentId: String?
    var agentName: String?
    var ownerAccountId: String?
    var ownerName: String?
    var requesterAccountId: String?
    var requesterName: String?
    var runtime: Runtime?
    var credentials: Credentials?
    var provider: String?
    var providerLabel: String?
    var model: String?

    init(
        key: String, agentId: String? = nil, agentName: String? = nil, ownerAccountId: String? = nil,
        ownerName: String? = nil, requesterAccountId: String? = nil, requesterName: String? = nil,
        runtime: Runtime? = nil, credentials: Credentials? = nil, provider: String? = nil,
        providerLabel: String? = nil, model: String? = nil
    ) {
        self.key = key
        self.agentId = agentId
        self.agentName = agentName
        self.ownerAccountId = ownerAccountId
        self.ownerName = ownerName
        self.requesterAccountId = requesterAccountId
        self.requesterName = requesterName
        self.runtime = runtime
        self.credentials = credentials
        self.provider = provider
        self.providerLabel = providerLabel
        self.model = model
    }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        self.init(
            key: container?.lenientString("key") ?? "",
            agentId: container?.lenientString("agentId"),
            agentName: container?.lenientString("agentName"),
            ownerAccountId: container?.lenientString("ownerAccountId"),
            ownerName: container?.lenientString("ownerName"),
            requesterAccountId: container?.lenientString("requesterAccountId"),
            requesterName: container?.lenientString("requesterName"),
            runtime: container?.lenientString("runtime").flatMap(Runtime.init(rawValue:)),
            credentials: container?.lenientString("credentials").flatMap(Credentials.init(rawValue:)),
            provider: container?.lenientString("provider"),
            providerLabel: container?.lenientString("providerLabel"),
            model: container?.lenientString("model")
        )
    }
}

struct CloudAgentReplyDisclosureList: Decodable {
    let disclosures: [CloudAgentReplyDisclosure]

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: AgentTrustJSONKey.self)
        disclosures = (container?.lenientArray(of: CloudAgentReplyDisclosure.self, "disclosures") ?? [])
            .filter { !$0.key.isEmpty }
    }
}
