import Foundation
import os
import UIKit

/// Holds the stored browser sign-in and refreshes it. One refresh runs at a
/// time per process, so a rotated refresh token is never presented twice,
/// and a refresh writes its result only while the stored sign-in is still
/// the one it refreshed: a sign-out or another sign-in during the request
/// wins, and the tokens it received are revoked.
actor AppSignInSessionStore {
    enum RefreshResult: Equatable {
        /// No browser sign-in is stored (password or provider session, or signed out).
        case notBrowserSession
        /// The access token does not expire within the margin.
        case current(AppSignInCredential)
        case refreshed(AppSignInCredential)
        /// The server ended the sign-in. Sign out.
        case rejected
        /// No usable answer. Keep the session and try again later.
        case unavailable
    }

    private static let stores = OSAllocatedUnfairLock<[String: AppSignInSessionStore]>(initialState: [:])

    /// The one store for this Keychain service, shared by the app model and
    /// background work such as Nearby, so their refreshes never overlap.
    static func shared(keychain: KeychainSessionStore = KeychainSessionStore(), api: CloudAPIClient) -> AppSignInSessionStore {
        stores.withLock { stores in
            if let store = stores[keychain.serviceName] { return store }
            let store = AppSignInSessionStore(keychain: keychain, transport: AppSignInClient.transport(using: api))
            stores[keychain.serviceName] = store
            return store
        }
    }

    private let keychain: KeychainSessionStore
    private let transport: AppSignInClient.Transport
    private let holdsBackgroundTime: Bool
    private var inFlight: Task<RefreshResult, Never>?

    init(keychain: KeychainSessionStore, transport: @escaping AppSignInClient.Transport, holdsBackgroundTime: Bool = true) {
        self.keychain = keychain
        self.transport = transport
        self.holdsBackgroundTime = holdsBackgroundTime
    }

    func credential() -> AppSignInCredential? {
        (try? keychain.loadAppSignInCredential()) ?? nil
    }

    func save(_ credential: AppSignInCredential) throws {
        try keychain.saveAppSignInCredential(credential)
    }

    /// Removes and returns the stored sign-in. A refresh still in flight then
    /// finds nothing to update and revokes what it received.
    func take() -> AppSignInCredential? {
        let stored = credential()
        try? keychain.deleteAppSignInCredential()
        return stored
    }

    func revoke(_ credential: AppSignInCredential) async {
        await AppSignInClient.revoke(credential, transport: transport)
    }

    /// The stored sign-in that belongs to the stored session token, checked
    /// after any refresh in flight. A sign-in from another server is dropped
    /// without contacting it; one left behind by an older session is revoked.
    func launchCredential(origin: URL) async -> AppSignInCredential? {
        if let inFlight { _ = await inFlight.value }
        guard let stored = credential() else { return nil }
        guard Self.sameOrigin(stored.tokenEndpoint, origin) else {
            try? keychain.deleteAppSignInCredential()
            return nil
        }
        guard stored.accessToken == ((try? keychain.loadToken()) ?? nil) else {
            try? keychain.deleteAppSignInCredential()
            await revoke(stored)
            return nil
        }
        return stored
    }

    func refresh(ifExpiringWithin margin: TimeInterval, now: Date = Date()) async -> RefreshResult {
        if let inFlight { return await inFlight.value }
        guard let stored = credential() else { return .notBrowserSession }
        guard stored.expires(within: margin, now: now) else { return .current(stored) }
        let task = Task { await self.performRefresh(stored) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    private func performRefresh(_ stored: AppSignInCredential) async -> RefreshResult {
        // The server's reuse grace is 60 seconds: keep running if the app is
        // backgrounded mid-request, so the rotated token is not lost.
        let backgroundTime = holdsBackgroundTime ? await AppSignInBackgroundTime.begin() : nil
        defer { if let backgroundTime { Task { @MainActor in backgroundTime.end() } } }
        do {
            let next = try await AppSignInClient.refresh(stored, transport: transport)
            guard credential()?.refreshToken == stored.refreshToken else {
                await revoke(next)
                return .notBrowserSession
            }
            try keychain.saveAppSignInCredential(next)
            try keychain.saveToken(next.accessToken)
            return .refreshed(next)
        } catch AppSignInRefreshError.rejected {
            return credential()?.refreshToken == stored.refreshToken ? .rejected : .notBrowserSession
        } catch {
            return .unavailable
        }
    }

    static func sameOrigin(_ endpoint: URL, _ origin: URL) -> Bool {
        endpoint.scheme?.lowercased() == origin.scheme?.lowercased()
            && endpoint.host?.lowercased() == origin.host?.lowercased()
            && endpoint.port == origin.port
    }
}

/// Background execution time for one refresh.
@MainActor
final class AppSignInBackgroundTime {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    static func begin() -> AppSignInBackgroundTime {
        let time = AppSignInBackgroundTime()
        time.identifier = UIApplication.shared.beginBackgroundTask(withName: "Kordi sign-in refresh") { [weak time] in
            time?.end()
        }
        return time
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

/// Browser sign-in for the iPhone app: availability, the
/// ASWebAuthenticationSession attempt, and the refresh schedule.
@MainActor
final class AppSignInController {
    /// Refresh this long before the access token expires.
    static let refreshMargin: TimeInterval = 300
    /// Retry delay after a refresh that got no usable answer.
    static let retryDelay: TimeInterval = 30

    let store: AppSignInSessionStore
    private let api: CloudAPIClient
    private let webSession: CloudOAuthSession
    private let makeClient: () -> AppSignInClient
    private lazy var client = makeClient()
    private var knownAvailability: BrowserSignInAvailability?
    private var probeTask: Task<BrowserSignInAvailability, Never>?
    private var refreshTask: Task<Void, Never>?

    init(api: CloudAPIClient, keychain: KeychainSessionStore, makeClient: (() -> AppSignInClient)? = nil) {
        self.api = api
        self.webSession = CloudOAuthSession(api: api)
        self.store = AppSignInSessionStore.shared(keychain: keychain, api: api)
        self.makeClient = makeClient ?? { AppSignInClient.current(transport: AppSignInClient.transport(using: api)) }
    }

    /// The last settled answer, if any. `unknown` is never remembered.
    var cachedAvailability: BrowserSignInAvailability? { knownAvailability }

    /// Probes once per launch. Only a settled answer is remembered, so a rate
    /// limit, captive portal, or outage asks again next time.
    func availability() async -> BrowserSignInAvailability {
        if let knownAvailability { return knownAvailability }
        if let probeTask { return await probeTask.value }
        let client = client
        let task = Task { await client.probe() }
        probeTask = task
        let result = await task.value
        probeTask = nil
        if result != .unknown { knownAvailability = result }
        return result
    }

    /// Opens the authorize page in a web authentication session, checks
    /// `state`, and exchanges the code. The caller stores the result.
    func signIn(_ intent: AppSignInIntent) async throws -> AppSignInGrant {
        let client = client
        let pkce = AppSignInPKCE.make()
        let callback = try await webSession.open(client.authorizeURL(pkce: pkce, intent: intent))
        let code = try AppSignInCallback.code(from: callback, redirectURI: client.redirectURI, expectedState: pkce.state)
        let device = try? await api.deviceRegistration()
        return try await client.exchange(code: code, pkce: pkce, device: device)
    }

    /// Runs `action` after `delay`, replacing any earlier schedule. Once
    /// started, `action` runs in its own task: the sign-out or reschedule it
    /// triggers cancels only the wait, never its own requests.
    func scheduleRefresh(after delay: TimeInterval, _ action: @escaping @MainActor () async -> Void) {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(1, delay)))
            guard !Task.isCancelled else { return }
            Task { @MainActor in await action() }
        }
    }

    /// Stops the schedule and removes the stored sign-in, for sign-out.
    func endForSignOut() async -> AppSignInCredential? {
        refreshTask?.cancel()
        refreshTask = nil
        return await store.take()
    }

    func revoke(_ credential: AppSignInCredential) async {
        await store.revoke(credential)
    }
}
