import Foundation

/// Pure grouping and labeling logic for the Active sessions screen.
/// Rows from the same physical device are grouped so the list reads like
/// "Where you're logged in" instead of one row per sign-in.

enum CloudDeviceDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    /// Parses ISO-8601 timestamps with or without fractional seconds.
    static func parse(_ value: String?) -> Date? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
}

extension CloudDeviceAuthorization {
    /// Names that old clients and the server used as placeholders, such as
    /// `oauth-google-device` or `cloud-email-password-device`.
    var isPlaceholderName: Bool {
        guard let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !name.isEmpty else {
            return false
        }
        if name == "cloud-email-password-device" { return true }
        guard name.hasPrefix("oauth-"), name.hasSuffix("-device") else { return false }
        let middle = name.dropFirst("oauth-".count).dropLast("-device".count)
        return !middle.isEmpty
    }

    var isLegacySignIn: Bool { legacy || isPlaceholderName }

    var isPendingReview: Bool { needsReview }

    private var realName: String? {
        guard !isPlaceholderName else { return nil }
        return displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    var title: String {
        if let realName { return realName }
        switch platform?.lowercased() {
        case "ios": return "iPhone"
        case "macos": return "Mac"
        case "windows": return "Windows PC"
        case "linux": return "Linux computer"
        default: return "Kordi device"
        }
    }

    var platformLabel: String? {
        switch platform?.lowercased() {
        case "ios": return "iOS"
        case "macos": return "macOS"
        case "windows": return "Windows"
        case "linux": return "Linux"
        default: return nil
        }
    }

    var platformVersionLabel: String? {
        let version = osVersion?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        guard let platformLabel else { return version }
        guard let version else { return platformLabel }
        if version.lowercased().hasPrefix(platformLabel.lowercased()) { return version }
        return "\(platformLabel) \(version)"
    }

    var appVersionLabel: String {
        guard let version = appVersion?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else {
            return "Kordi"
        }
        return "Kordi \(version)"
    }

    var signInMethodLabel: String? {
        guard let method = signInMethod?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else {
            return nil
        }
        switch method.lowercased() {
        case "google": return "Google"
        case "github": return "GitHub"
        case "password", "email", "email-password", "email_password": return "Email and password"
        case "apple": return "Apple"
        default: return method.prefix(1).uppercased() + method.dropFirst()
        }
    }

    var groupKey: String {
        if isLegacySignIn { return "legacy::\(deviceId)" }
        return "\(platform ?? "unknown")::\(title.lowercased())"
    }

    var lastActiveDate: Date? { CloudDeviceDates.parse(lastActiveAt) }
}

struct CloudDeviceGroup: Identifiable, Hashable {
    let id: String
    let title: String
    let platform: String?
    let osVersion: String?
    let location: String?
    let online: Bool
    let lastActiveAt: String
    let sessionCount: Int
    /// Rows in this group, most recent first.
    let devices: [CloudDeviceAuthorization]
    let pending: Bool

    /// The most recent row, used for icon and platform labels.
    var primary: CloudDeviceAuthorization { devices[0] }

    var platformVersionLabel: String? { primary.platformVersionLabel }
}

struct CloudDeviceGrouping: Hashable {
    let current: CloudDeviceAuthorization?
    let groups: [CloudDeviceGroup]
    let legacy: [CloudDeviceAuthorization]

    var otherDevices: [CloudDeviceAuthorization] {
        groups.flatMap(\.devices) + legacy
    }

    static func make(from devices: [CloudDeviceAuthorization]) -> CloudDeviceGrouping {
        let current = devices.first(where: \.currentDevice)
        let others = devices.filter { !$0.currentDevice }
        let legacy = sortedByRecency(others.filter(\.isLegacySignIn))

        var buckets: [String: [CloudDeviceAuthorization]] = [:]
        var order: [String] = []
        for device in others where !device.isLegacySignIn {
            let key = device.groupKey
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(device)
        }

        let groups = order.compactMap { key -> CloudDeviceGroup? in
            let rows = sortedByRecency(buckets[key] ?? [])
            guard let primary = rows.first else { return nil }
            return CloudDeviceGroup(
                id: key,
                title: primary.title,
                platform: primary.platform,
                osVersion: primary.osVersion,
                location: rows.lazy.compactMap { $0.approximateLocation?.nonEmpty }.first,
                online: rows.contains(where: \.online),
                lastActiveAt: primary.lastActiveAt,
                sessionCount: rows.reduce(0) { $0 + max(1, $1.sessionCount) },
                devices: rows,
                pending: rows.contains(where: \.isPendingReview)
            )
        }
        .sorted { lhs, rhs in
            if lhs.online != rhs.online { return lhs.online }
            return isMoreRecent(lhs.lastActiveAt, than: rhs.lastActiveAt)
        }

        return CloudDeviceGrouping(current: current, groups: groups, legacy: legacy)
    }

    private static func sortedByRecency(_ devices: [CloudDeviceAuthorization]) -> [CloudDeviceAuthorization] {
        devices.sorted { isMoreRecent($0.lastActiveAt, than: $1.lastActiveAt) }
    }

    private static func isMoreRecent(_ lhs: String, than rhs: String) -> Bool {
        switch (CloudDeviceDates.parse(lhs), CloudDeviceDates.parse(rhs)) {
        case let (left?, right?): return left > right
        case (.some, nil): return true
        case (nil, .some): return false
        case (nil, nil): return lhs > rhs
        }
    }
}

/// Short activity text for a row that is not online right now.
/// The caller shows "Active now" for online rows.
func lastActiveDescription(_ iso: String?, now: Date = Date()) -> String? {
    guard let date = CloudDeviceDates.parse(iso) else { return nil }
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 60 { return "Active just now" }
    if seconds < 3_600 { return "Active \(Int(seconds / 60)) min ago" }
    if seconds < 86_400 { return "Active \(Int(seconds / 3_600)) hr ago" }
    return "Last active \(date.formatted(date: .abbreviated, time: .shortened))"
}
