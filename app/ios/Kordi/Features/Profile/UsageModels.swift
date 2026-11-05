import SwiftUI

/// One limit as the server computed it. `used` and `limit` are present only
/// for owners and admins.
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
    /// On `conversation.system_agent_runs`: the viewer's busiest chat today.
    let conversationId: String?
    /// When a limit first refused the System agent in this window.
    let pausedSince: String?

    init(limitId: String, scope: String, used: Int? = nil, limit: Int? = nil, usedPercent: Int,
         window: String = "day", resetsAt: String, reached: String = "none",
         conversationId: String? = nil, pausedSince: String? = nil) {
        self.limitId = limitId
        self.scope = scope
        self.used = used
        self.limit = limit
        self.usedPercent = usedPercent
        self.window = window
        self.resetsAt = resetsAt
        self.reached = reached
        self.conversationId = conversationId
        self.pausedSince = pausedSince
    }

    enum CodingKeys: String, CodingKey {
        case limitId, scope, used, limit, usedPercent, window, resetsAt, reached, conversationId, pausedSince
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        limitId = try container.decode(String.self, forKey: .limitId)
        scope = (try? container.decodeIfPresent(String.self, forKey: .scope)) ?? ""
        used = (try? container.decodeIfPresent(Int.self, forKey: .used)) ?? nil
        limit = (try? container.decodeIfPresent(Int.self, forKey: .limit)) ?? nil
        usedPercent = min(100, max(0, (try? container.decodeIfPresent(Int.self, forKey: .usedPercent)) ?? 0))
        window = (try? container.decodeIfPresent(String.self, forKey: .window)) ?? "day"
        resetsAt = (try? container.decodeIfPresent(String.self, forKey: .resetsAt)) ?? ""
        reached = (try? container.decodeIfPresent(String.self, forKey: .reached)) ?? "none"
        conversationId = ((try? container.decodeIfPresent(String.self, forKey: .conversationId)) ?? nil)?.nonEmpty
        pausedSince = ((try? container.decodeIfPresent(String.self, forKey: .pausedSince)) ?? nil)?.nonEmpty
    }

    var isReached: Bool { reached != "none" }
}

/// One organization in `GET /v1/cloud/account/usage`.
struct CloudOrganizationUsageSummary: Decodable, Hashable, Identifiable {
    let organizationId: String
    let name: String
    /// "personal" or "team".
    let kind: String
    /// "owner", "admin", or "member".
    let role: String?
    let snapshots: [CloudUsageSnapshot]

    var id: String { organizationId }

    init(organizationId: String, name: String, kind: String, role: String?, snapshots: [CloudUsageSnapshot]) {
        self.organizationId = organizationId
        self.name = name
        self.kind = kind
        self.role = role
        self.snapshots = snapshots
    }

    enum CodingKeys: String, CodingKey {
        case organizationId, name, kind, role, snapshots
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        organizationId = try container.decode(String.self, forKey: .organizationId)
        name = try container.decode(String.self, forKey: .name)
        kind = (try? container.decodeIfPresent(String.self, forKey: .kind)) ?? "team"
        role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? nil
        snapshots = try container.decodeIfPresent([CloudUsageSnapshot].self, forKey: .snapshots) ?? []
    }
}

/// `GET /v1/cloud/account/usage`, personal organization first.
struct CloudAccountUsage: Decodable, Hashable {
    let organizations: [CloudOrganizationUsageSummary]
}

/// `GET /v1/cloud/organizations/{id}/usage`.
struct CloudOrganizationUsage: Decodable, Hashable {
    let organizationId: String
    let role: String?
    let snapshots: [CloudUsageSnapshot]

    enum CodingKeys: String, CodingKey {
        case organizationId, role, snapshots
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        organizationId = try container.decode(String.self, forKey: .organizationId)
        role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? nil
        snapshots = try container.decodeIfPresent([CloudUsageSnapshot].self, forKey: .snapshots) ?? []
    }
}

/// Copy and warning levels for Settings › Usage. The server does all limit
/// math; this only formats its numbers.
enum UsagePresentation {
    enum Level: Equatable {
        case normal, warning, critical
    }

    static func isManager(role: String?) -> Bool {
        role == "owner" || role == "admin"
    }

    static func label(limitId: String) -> String {
        switch limitId {
        case "pool.runs": "Runs"
        case "pool.spend": "Spend"
        case "account.grounding_runs": "Grounding"
        case "conversation.system_agent_runs": "System agent per chat"
        case "pool.stopped": "System agent"
        default: "Limit"
        }
    }

    static func level(_ snapshot: CloudUsageSnapshot) -> Level {
        if snapshot.isReached || snapshot.usedPercent >= 90 { return .critical }
        return snapshot.usedPercent >= 75 ? .warning : .normal
    }

    static func tint(_ level: Level, accent: Color) -> Color {
        switch level {
        case .normal: accent
        case .warning: .orange
        case .critical: .red
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

    static func status(_ snapshot: CloudUsageSnapshot, role: String?) -> String {
        let reset = utcTime(snapshot.resetsAt)
        switch snapshot.reached {
        case "none":
            return "Resets at \(reset) UTC"
        case "stopped":
            return "Paused by an owner."
        default:
            let line = snapshot.pausedSince.map { "Paused since \(utcTime($0)), resets \(reset) UTC." }
                ?? "Limit reached. Resets at \(reset) UTC."
            return isManager(role: role) ? line : "\(line) Ask an owner to raise it."
        }
    }

    /// HH:mm in UTC; "00:00" when the time is missing or malformed.
    static func utcTime(_ value: String?) -> String {
        guard let value = value?.nonEmpty else { return "00:00" }
        let date = parseCloudDate(value)
        guard date != .distantPast else { return "00:00" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}
