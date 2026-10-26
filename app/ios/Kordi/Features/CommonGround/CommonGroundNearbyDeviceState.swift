import Foundation

/// What this iPhone keeps about Nearby for the signed-in account, so a
/// launch in the background (a significant change, a region exit or a
/// refresh task) knows whether to send a location. Precise coordinates stay
/// on the phone; only the last posted point is kept, to measure movement.
struct CommonGroundNearbyDeviceState: Codable, Equatable {
    var accountId: String
    /// Nearby is on and not paused for this account.
    var enabled: Bool
    /// The person chose Alerts in the background.
    var backgroundAlerts: Bool
    var lastPostAt: Date?
    var lastLatitude: Double?
    var lastLongitude: Double?
    /// The location access seen last, to notice a change after a relaunch.
    var lastAccess: CommonGroundNearbyAccess?

    init(accountId: String, enabled: Bool, backgroundAlerts: Bool, lastAccess: CommonGroundNearbyAccess? = nil) {
        self.accountId = accountId
        self.enabled = enabled
        self.backgroundAlerts = backgroundAlerts
        self.lastAccess = lastAccess
    }

    static let defaultsKey = "commonGround.nearby.device"

    static func load(from defaults: UserDefaults) -> CommonGroundNearbyDeviceState? {
        guard let data = defaults.data(forKey: defaultsKey) else { return nil }
        return try? JSONDecoder().decode(CommonGroundNearbyDeviceState.self, from: data)
    }

    static func save(_ state: CommonGroundNearbyDeviceState?, to defaults: UserDefaults) {
        guard let state, let data = try? JSONEncoder().encode(state) else {
            defaults.removeObject(forKey: defaultsKey)
            return
        }
        defaults.set(data, forKey: defaultsKey)
    }

    /// Forgets the last posted point after the location was withdrawn.
    mutating func forgetLastPost() {
        lastPostAt = nil
        lastLatitude = nil
        lastLongitude = nil
    }
}

/// The session token for background posts, read from the Keychain the app
/// signs in with. The item is readable after the first unlock since the
/// phone started, so a post that iOS runs before that finds no token and is
/// skipped.
enum CommonGroundNearbyCredentials {
    static func token(store: KeychainSessionStore = KeychainSessionStore()) -> String? {
        guard let token = (try? store.loadToken()) ?? nil, !token.isEmpty else { return nil }
        return token
    }
}
