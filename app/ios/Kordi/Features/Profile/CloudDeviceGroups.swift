import Foundation

/// Pure list and labeling logic for the Active sessions screen.

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

    var lastActiveDate: Date? { CloudDeviceDates.parse(lastActiveAt) }
}

/// The Active sessions list split into flat sections, with no grouping by name.
struct CloudDeviceList: Hashable {
    let current: CloudDeviceAuthorization?
    /// Other sessions on the same machine as this device.
    let sameMachine: [CloudDeviceAuthorization]
    let others: [CloudDeviceAuthorization]

    /// The server rejects every device action until this device is approved.
    var actionsLocked: Bool { current?.isPendingReview == true }

    var otherDevices: [CloudDeviceAuthorization] { sameMachine + others }

    static func make(from devices: [CloudDeviceAuthorization]) -> CloudDeviceList {
        let current = devices.first(where: \.currentDevice)
        let rest = devices.filter { $0.deviceId != current?.deviceId }
        return CloudDeviceList(
            current: current,
            sameMachine: sorted(rest.filter(\.sameMachine)),
            others: sorted(rest.filter { !$0.sameMachine })
        )
    }

    /// Pending rows first, then most recent.
    static func sorted(_ devices: [CloudDeviceAuthorization]) -> [CloudDeviceAuthorization] {
        devices.sorted { lhs, rhs in
            if lhs.isPendingReview != rhs.isPendingReview { return lhs.isPendingReview }
            return isMoreRecent(lhs.lastActiveAt, than: rhs.lastActiveAt)
        }
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

/// Grey line under a pending current device.
func pendingApprovalHint(reviewEndsAt: String?) -> String {
    guard let date = CloudDeviceDates.parse(reviewEndsAt) else {
        return "Approve from another device."
    }
    return "Approve from another device, or wait until \(date.formatted(date: .abbreviated, time: .shortened))."
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
