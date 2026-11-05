import Foundation

/// Holds the stored browser sign-in and refreshes it. One refresh runs at a
/// time, so a rotated refresh token is never presented twice, and a refresh
/// writes its result only while the stored sign-in is still the one it
/// refreshed: a sign-out or another sign-in during the request wins.
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

    private let keychain: KeychainSessionStore
    private let session: URLSession
    private var inFlight: Task<RefreshResult, Never>?

    init(keychain: KeychainSessionStore, session: URLSession = CloudAPIClient.reliableSession) {
        self.keychain = keychain
        self.session = session
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
        do {
            let next = try await AppSignInClient.refresh(stored, session: session)
            guard credential()?.refreshToken == stored.refreshToken else {
                await AppSignInClient.revoke(next, session: session)
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

    init(
        api: CloudAPIClient,
        keychain: KeychainSessionStore,
        makeClient: @escaping () -> AppSignInClient = { AppSignInClient.current() }
    ) {
        self.api = api
        self.webSession = CloudOAuthSession(api: api)
        self.store = AppSignInSessionStore(keychain: keychain)
        self.makeClient = makeClient
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
        await AppSignInClient.revoke(credential, session: client.session)
    }
}
