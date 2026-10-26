import BackgroundTasks
import CoreLocation
import UIKit

/// Sends this iPhone's location for Grounding Nearby (#2100). One instance,
/// created when the app launches so the location and region events that
/// relaunch it in the background reach a delegate. It only works while the
/// saved state says Nearby is on and not paused for the signed-in account.
///
/// In the foreground, the Nearby screen asks for one fix on appear and then
/// updates while it is visible. In the background, with Always access and
/// Alerts in the background, significant changes, a 200 m region around
/// the last point and a refresh task each send a point. There is no
/// `location` background mode, so nothing tracks continuously.
@MainActor
final class CommonGroundNearbyLocator: NSObject, ObservableObject {
    static let shared = CommonGroundNearbyLocator()
    static let refreshTaskID = "ai.kordi.nearby.refresh"
    static let regionID = "ai.kordi.nearby.region"
    static let regionRadius: CLLocationDistance = 200
    /// The refresh task asks to run again after this long, at the earliest.
    static let refreshInterval: TimeInterval = 15 * 60

    @Published private(set) var access: CommonGroundNearbyAccess = .notDetermined
    /// Precise location is on; with reduced accuracy no fix is sent.
    @Published private(set) var precise = true
    @Published var refreshAvailable = true
    /// The location the server last accepted from this iPhone.
    @Published private(set) var lastReply: CommonGroundNearbyLocation?
    /// Counts accepted posts, so screens can refetch after one.
    @Published private(set) var postCount = 0
    @Published private(set) var posting = false
    @Published private(set) var updatingNow = false
    @Published private(set) var locationError: String?

    let defaults: UserDefaults
    let api: CloudAPIClient
    var manager: CLLocationManager?
    var launched = false
    /// The Nearby screen is visible.
    var foreground = false
    var updating = false
    /// The next fix skips the not-moved check (the Update button).
    var forceNext = false
    var retryAfter: Date?
    var locationGeneration = 0
    var fixWaiters: [UUID: CheckedContinuation<CLLocation?, Never>] = [:]
    var accessWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    var backgroundTimes: [UUID: UIBackgroundTaskIdentifier] = [:]
    /// The refresh task iOS is running, completed once.
    var pendingRefresh: BGTask?

    private(set) var state: CommonGroundNearbyDeviceState? {
        didSet { if state != oldValue { CommonGroundNearbyDeviceState.save(state, to: defaults) } }
    }

    init(defaults: UserDefaults = .standard, api: CloudAPIClient = CloudAPIClient()) {
        self.defaults = defaults
        self.api = api
        state = CommonGroundNearbyDeviceState.load(from: defaults)
        super.init()
    }

    /// Background operation works: Always, Alerts in the background,
    /// Background App Refresh and precise location.
    var worksInBackground: Bool {
        CommonGroundNearbyWithdrawal.worksInBackground(
            access: access, backgroundAlerts: backgroundAlerts, refreshAvailable: refreshAvailable, precise: precise
        )
    }

    /// Background work is allowed: on, and background operation works.
    var backgroundAllowed: Bool { state?.enabled == true && worksInBackground }

    var backgroundAlerts: Bool { state?.backgroundAlerts ?? false }

    /// Called once from `application(_:didFinishLaunchingWithOptions:)`.
    func launch() {
        guard !launched else { return }
        launched = true
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 100
        self.manager = manager
        access = Self.access(manager.authorizationStatus)
        precise = manager.accuracyAuthorization == .fullAccuracy
        refreshAvailable = UIApplication.shared.backgroundRefreshStatus == .available
        registerRefreshTask()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(refreshStatusChanged), name: UIApplication.backgroundRefreshStatusDidChangeNotification, object: nil)
        // A relaunch for a location event must restart significant changes to
        // receive it. Without a saved state there is nothing to start.
        if state != nil { applyBackgroundMode() }
    }

    static func access(_ status: CLAuthorizationStatus) -> CommonGroundNearbyAccess {
        switch status {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorizedAlways: .always
        case .authorizedWhenInUse: .whenInUse
        @unknown default: .notDetermined
        }
    }

    // MARK: Settings from the model

    /// After the settings load: whether Nearby is on and not paused for this
    /// account. Another account's state is replaced; nothing is saved for an
    /// account that has never turned Nearby on here.
    func sync(accountId: String, sharing: Bool) {
        guard !accountId.isEmpty else { return }
        guard state?.accountId == accountId || sharing else {
            if state != nil {
                stopBackground()
                state = nil
            }
            return
        }
        var next = state?.accountId == accountId ? state! : CommonGroundNearbyDeviceState(
            accountId: accountId, enabled: false, backgroundAlerts: access == .always, lastAccess: access
        )
        next.enabled = sharing
        if !sharing { next.forgetLastPost() }
        state = next
        applyBackgroundMode()
    }

    /// Turned on from the consent sheet, with the person's choice of Alerts
    /// in the background. The screen asks for access once the sheet closes.
    func turnedOn(accountId: String, backgroundAlerts: Bool) {
        var next = state?.accountId == accountId ? state! : CommonGroundNearbyDeviceState(
            accountId: accountId, enabled: true, backgroundAlerts: backgroundAlerts, lastAccess: access
        )
        next.enabled = true
        next.backgroundAlerts = backgroundAlerts
        state = next
        applyBackgroundMode()
    }

    /// Turned off or paused: the location is deleted and nothing is watched.
    func turnedOff() {
        state?.enabled = false
        withdraw()
    }

    /// Asks for When In Use first; Always only after it is granted and only
    /// for Alerts in the background.
    func requestAccess(background: Bool) async {
        guard let manager else { return }
        if access == .notDetermined {
            await waitForAccess { manager.requestWhenInUseAuthorization() }
        }
        if background, access == .whenInUse { manager.requestAlwaysAuthorization() }
    }

    private func waitForAccess(request: () -> Void) async {
        let key = UUID()
        await withCheckedContinuation { continuation in
            accessWaiters[key] = continuation
            request()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(120))
                self?.accessWaiters.removeValue(forKey: key)?.resume()
            }
        }
    }

    func resolveAccessWaiters() {
        let waiters = accessWaiters.values
        accessWaiters = [:]
        waiters.forEach { $0.resume() }
    }

    // MARK: Foreground

    /// The Nearby screen appeared: one fix now, then updates while it shows.
    func startForeground() {
        foreground = true
        guard let manager, state?.enabled == true, access.granted else { return }
        manager.requestLocation()
    }

    func stopForeground() {
        foreground = false
        if updating { manager?.stopUpdatingLocation() }
        updating = false
    }

    /// An explicit update also requests access on a phone that has never been asked.
    func updateNow() {
        guard !updatingNow, !posting else { return }
        locationError = nil
        guard state?.enabled == true else {
            locationError = "Turn on Nearby before updating your location."
            return
        }
        updatingNow = true
        foreground = true
        let generation = locationGeneration
        Task { @MainActor in
            defer { updatingNow = false }
            await requestAccess(background: false)
            guard generation == locationGeneration, foreground else { return }
            guard access.granted else { return }
            guard precise else { return }
            guard let fix = await oneFix(timeout: 30) else {
                locationError = "Could not find your location. Try again."
                return
            }
            guard generation == locationGeneration, foreground else { return }
            forceNext = true
            if !(await consider(fix)), locationError == nil {
                locationError = "Could not update your location. Try again in a minute."
            }
            forceNext = false
        }
    }

    /// One fix and a post when the rules allow it, for Home's Nearby row.
    func refreshOnce() async {
        guard state?.enabled == true, access.granted, let fix = await oneFix(timeout: 12) else { return }
        await consider(fix)
    }

    // MARK: Posting

    /// Sends `location` when the post rule allows it; true when sent.
    @discardableResult
    func consider(_ location: CLLocation) async -> Bool {
        // Reduced accuracy: the status line says so; nothing is sent.
        guard let state, state.enabled, precise, access.granted,
              UIApplication.shared.applicationState != .background || backgroundAllowed else { return false }
        let last = state.lastLatitude.flatMap { latitude in
            state.lastLongitude.map { CLLocation(latitude: latitude, longitude: $0) }
        }
        let decision = CommonGroundNearbyPostRule.decide(
            capturedAt: location.timestamp,
            accuracy: location.horizontalAccuracy,
            moved: last.map { location.distance(from: $0) },
            lastPostAt: state.lastPostAt,
            now: Date(),
            force: forceNext
        )
        guard decision == .post else { return false }
        forceNext = false
        return await post(location)
    }

    private func post(_ location: CLLocation) async -> Bool {
        guard !posting, state?.enabled == true else { return false }
        if let retryAfter, retryAfter > Date() { return false }
        // Signed out, or iOS ran the app before the first unlock: skip this one.
        guard let token = CommonGroundNearbyCredentials.token() else { return false }
        posting = true
        let generation = locationGeneration
        let accountId = state?.accountId
        let time = beginBackgroundTime()
        defer {
            posting = false
            endBackgroundTime(time)
        }
        let fix = CommonGroundNearbyFix(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracy: location.horizontalAccuracy,
            capturedAt: location.timestamp
        )
        do {
            let reply = try await api.postCommonGroundNearbyLocation(token: token, fix: fix)
            guard state?.enabled == true, state?.accountId == accountId, locationGeneration == generation else {
                // A withdrawal can race an accepted POST. Remove that late fix
                // with the original credential before another post can start.
                try? await api.deleteCommonGroundNearbyLocation(token: token)
                return false
            }
            state?.lastPostAt = Date()
            state?.lastLatitude = location.coordinate.latitude
            state?.lastLongitude = location.coordinate.longitude
            lastReply = reply.location
            locationError = nil
            postCount += 1
            if backgroundAllowed { placeRegion(around: location.coordinate) }
            return true
        } catch let error as CloudAPIError {
            if updatingNow {
                locationError = error.code == "common_ground_nearby_inaccurate"
                    ? "Your location is not accurate enough yet. Try again."
                    : "Could not save your location. Check your connection and try again."
            }
            if error.code == "common_ground_nearby_off" {
                // Turned off or paused elsewhere: stop until the settings say otherwise.
                state?.enabled = false
                state?.forgetLastPost()
                stopBackground()
            } else if error.statusCode == 429 || error.code == "rate_limited" {
                retryAfter = Date().addingTimeInterval(TimeInterval(error.retryAfterSeconds ?? 60))
            }
            return false
        } catch {
            if updatingNow { locationError = "Could not save your location. Check your connection and try again." }
            return false
        }
    }

    // MARK: Withdrawal

    /// Deletes this device's location and stops background work.
    func withdraw() {
        locationGeneration += 1
        stopForeground()
        stopBackground()
        state?.forgetLastPost()
        lastReply = nil
        Task { await deleteLocation() }
    }

    private func deleteLocation() async {
        guard let token = CommonGroundNearbyCredentials.token() else { return }
        let time = beginBackgroundTime()
        defer { endBackgroundTime(time) }
        try? await api.deleteCommonGroundNearbyLocation(token: token)
    }

    /// Before signing out: deletes the location with the old token, waiting
    /// at most 3 seconds, then forgets everything.
    func signOut(api: CloudAPIClient, token: String) async {
        locationGeneration += 1
        let wasSending = state?.enabled == true || state?.lastPostAt != nil
        stopForeground()
        stopBackground()
        state = nil
        lastReply = nil
        guard wasSending else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { try? await api.deleteCommonGroundNearbyLocation(token: token) }
            group.addTask { try? await Task.sleep(for: .seconds(3)) }
            await group.next()
            group.cancelAll()
        }
    }

    // MARK: App state

    @objc private func didEnterBackground() {
        stopForeground()
        guard let state else { return }
        let trigger = CommonGroundNearbyWithdrawal.Trigger.enteredBackground(worksInBackground: worksInBackground)
        if CommonGroundNearbyWithdrawal.withdraws(trigger, enabled: state.enabled, backgroundAlerts: state.backgroundAlerts) {
            withdraw()
        } else {
            applyBackgroundMode()
        }
    }

    @objc private func refreshStatusChanged() {
        refreshAvailable = UIApplication.shared.backgroundRefreshStatus == .available
        if state != nil {
            if UIApplication.shared.applicationState == .background, !worksInBackground { withdraw() }
            else { applyBackgroundMode() }
        }
    }

    /// Location access changed, also right after launch.
    func accessChanged() {
        guard let manager else { return }
        let next = Self.access(manager.authorizationStatus)
        let previous = state?.lastAccess ?? access
        let wasPrecise = precise
        access = next
        precise = manager.accuracyAuthorization == .fullAccuracy
        if next != .notDetermined { resolveAccessWaiters() }
        guard var current = state else { return }
        let trigger = CommonGroundNearbyWithdrawal.Trigger.access(
            from: previous, to: next, inBackground: UIApplication.shared.applicationState == .background
        )
        if (wasPrecise && !precise) || CommonGroundNearbyWithdrawal.withdraws(trigger, enabled: current.enabled, backgroundAlerts: current.backgroundAlerts) {
            withdraw()
            current = state ?? current
        }
        // Choosing Always in Settings while Nearby is on turns background alerts on.
        if next == .always, previous != .always, current.enabled { current.backgroundAlerts = true }
        current.lastAccess = next
        state = current
        applyBackgroundMode()
        if foreground, next.granted { startForeground() }
    }

    // MARK: Background time

    func beginBackgroundTime() -> UUID {
        let key = UUID()
        backgroundTimes[key] = UIApplication.shared.beginBackgroundTask(withName: "Nearby location") { [weak self] in
            self?.endBackgroundTime(key)
        }
        return key
    }

    func endBackgroundTime(_ key: UUID) {
        guard let id = backgroundTimes.removeValue(forKey: key), id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
    }
}
