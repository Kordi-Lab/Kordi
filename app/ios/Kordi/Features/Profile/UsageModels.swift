import Foundation

/// One organization the signed-in account belongs to
/// (`GET /v1/cloud/organizations`).
struct CloudOrganization: Decodable, Hashable, Identifiable {
    let organizationId: String
    let name: String
    /// "personal" or "team".
    let kind: String
    /// "owner", "admin", or "member".
    let role: String

    var id: String { organizationId }

    init(organizationId: String, name: String, kind: String, role: String) {
        self.organizationId = organizationId
        self.name = name
        self.kind = kind
        self.role = role
    }
}

struct CloudOrganizationListResponse: Decodable {
    let organizations: [CloudOrganization]
}

/// One limit of an organization, conversation, or account as the server
/// computed it. `used` and `limit` are present only for owners and admins.
struct CloudUsageSnapshot: Decodable, Hashable {
    let limitId: String
    let scope: String
    let used: Int?
    let limit: Int?
    let usedPercent: Int
    let window: String
    let resetsAt: String
    /// "none", "daily_limit", "spend_limit", or "stopped".
    let reached: String

    init(limitId: String, scope: String, used: Int? = nil, limit: Int? = nil, usedPercent: Int,
         window: String = "day", resetsAt: String, reached: String = "none") {
        self.limitId = limitId
        self.scope = scope
        self.used = used
        self.limit = limit
        self.usedPercent = usedPercent
        self.window = window
        self.resetsAt = resetsAt
        self.reached = reached
    }

    enum CodingKeys: String, CodingKey {
        case limitId, scope, used, limit, usedPercent, window, resetsAt, reached
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        limitId = try container.decode(String.self, forKey: .limitId)
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        used = try? container.decodeIfPresent(Int.self, forKey: .used)
        limit = try? container.decodeIfPresent(Int.self, forKey: .limit)
        usedPercent = min(100, max(0, (try? container.decodeIfPresent(Int.self, forKey: .usedPercent)) ?? 0))
        window = (try? container.decodeIfPresent(String.self, forKey: .window)) ?? "day"
        resetsAt = (try? container.decodeIfPresent(String.self, forKey: .resetsAt)) ?? ""
        reached = (try? container.decodeIfPresent(String.self, forKey: .reached)) ?? "none"
    }

    var isReached: Bool { reached != "none" }
}

struct CloudUsageNotice: Decodable, Hashable {
    let threshold: Int
    let at: String
}

/// `GET /v1/cloud/organizations/{id}/usage`.
struct CloudOrganizationUsage: Decodable, Hashable {
    let organizationId: String
    let role: String?
    let snapshots: [CloudUsageSnapshot]
    /// Owners and admins only, highest first.
    let notices: [CloudUsageNotice]

    init(organizationId: String, role: String?, snapshots: [CloudUsageSnapshot], notices: [CloudUsageNotice] = []) {
        self.organizationId = organizationId
        self.role = role
        self.snapshots = snapshots
        self.notices = notices
    }

    enum CodingKeys: String, CodingKey {
        case organizationId, role, snapshots, notices
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        organizationId = try container.decode(String.self, forKey: .organizationId)
        role = try? container.decodeIfPresent(String.self, forKey: .role)
        snapshots = try container.decodeIfPresent([CloudUsageSnapshot].self, forKey: .snapshots) ?? []
        notices = (try? container.decodeIfPresent([CloudUsageNotice].self, forKey: .notices)) ?? []
    }
}

/// The `usageLimit` of a System agent notice that a limit refused a run.
struct ChatUsageLimit: Codable, Hashable {
    /// "daily_limit", "spend_limit", or "stopped".
    let reached: String
    let resetsAt: String?
    let organizationId: String?

    static let reachedValues: Set<String> = ["daily_limit", "spend_limit", "stopped"]

    init(reached: String, resetsAt: String? = nil, organizationId: String? = nil) {
        self.reached = reached
        self.resetsAt = resetsAt
        self.organizationId = organizationId
    }

    enum CodingKeys: String, CodingKey {
        case reached, resetsAt, organizationId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let reached = try container.decode(String.self, forKey: .reached)
        guard Self.reachedValues.contains(reached) else {
            throw DecodingError.dataCorruptedError(forKey: .reached, in: container, debugDescription: "Unknown limit state")
        }
        self.reached = reached
        resetsAt = try? container.decodeIfPresent(String.self, forKey: .resetsAt)
        organizationId = (try? container.decodeIfPresent(String.self, forKey: .organizationId))?.nonEmpty
    }
}

/// Copy for Settings › Usage and limit notices in chat. The server does all
/// limit math; this only formats its numbers.
enum UsagePresentation {
    static func isManager(role: String?) -> Bool {
        role == "owner" || role == "admin"
    }

    static func label(limitId: String) -> String {
        switch limitId {
        case "pool.runs": "Runs"
        case "pool.spend": "Spend"
        case "account.grounding_runs": "Grounding"
        case "conversation.system_agent_runs", "pool.stopped": "System agent"
        default: "Limit"
        }
    }

    static func value(_ snapshot: CloudUsageSnapshot) -> String {
        if let used = snapshot.used, let limit = snapshot.limit {
            if snapshot.limitId == "pool.spend" {
                return "\(amount(used)) of \(amount(limit))"
            }
            return "\(used) of \(limit)"
        }
        return "\(snapshot.usedPercent)%"
    }

    /// Spend is in millionths of a currency unit.
    static func amount(_ millionths: Int) -> String {
        String(format: "%.2f", Double(millionths) / 1_000_000)
    }

    static func status(_ snapshot: CloudUsageSnapshot) -> String {
        let time = resetTime(snapshot.resetsAt)
        switch snapshot.reached {
        case "none": return "Resets at \(time) UTC"
        case "stopped": return "Paused by an owner."
        default: return "Daily limit reached. Resets at \(time) UTC."
        }
    }

    /// The highest notice, for owners and admins.
    static func noticeLine(_ notices: [CloudUsageNotice]) -> String? {
        guard let threshold = notices.map(\.threshold).max() else { return nil }
        return "\(threshold)% of today's limit used."
    }

    static func chatText(_ limit: ChatUsageLimit, role: String?) -> String {
        if limit.reached == "stopped" { return "Paused by an owner." }
        let reset = "Daily limit reached. Resets at \(resetTime(limit.resetsAt)) UTC."
        return isManager(role: role) ? reset : "\(reset) Ask an owner to raise it."
    }

    /// Whether a limit notice offers View usage to this viewer.
    static func offersUsageLink(_ limit: ChatUsageLimit, role: String?) -> Bool {
        limit.reached != "stopped" && isManager(role: role)
    }

    /// HH:mm in UTC; "00:00" when the time is missing or malformed.
    static func resetTime(_ value: String?) -> String {
        guard let value = value?.nonEmpty else { return "00:00" }
        let date = parseCloudDate(value)
        guard date != .distantPast else { return "00:00" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    /// A limit notice shown with role-aware text instead of its block text.
    static func displayMessage(_ message: ChatMessage, role: String?) -> ChatMessage {
        guard let limit = message.usageLimit else { return message }
        var copy = message
        copy.text = chatText(limit, role: role)
        return copy
    }
}
