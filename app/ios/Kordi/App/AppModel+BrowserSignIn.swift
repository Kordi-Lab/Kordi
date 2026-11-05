import Foundation

// Browser sign-in for AppModel: sign-in, launch, refresh, and sign-out.
// The flow and its security rules live in docs/development/browser-sign-in.md.
extension AppModel {
    /// Asks the server once per launch whether it offers browser sign-in.
    /// Preview mode never asks.
    func browserSignInAvailability() async -> BrowserSignInAvailability {
        guard !isPreviewMode else { return .available }
        return await browserSignIn.availability()
    }

    /// Signs in through the system browser. Returns whether it finished.
    func signInWithBrowser(_ intent: AppSignInIntent) async -> Bool {
        guard !isPreviewMode else { return false }
        errorMessage = nil
        let grant: AppSignInGrant
        do {
            grant = try await browserSignIn.signIn(intent)
        } catch CloudOAuthSessionError.cancelled {
            return false
        } catch {
            errorMessage = userFacing(error, fallback: "Could not finish signing in. Try again.")
            return false
        }
        // Another account's data must never show under this one.
        if let previous = account?.accountId, previous != grant.account.accountId {
            await signOut()
        }
        // A sign-in kept after a failed launch is replaced, not left alive.
        if let leftover = await browserSignIn.endForSignOut() { await browserSignIn.revoke(leftover) }
        do {
            try await browserSignIn.store.save(grant.credential)
            try await completeAuthentication(grant.authResponse)
        } catch {
            if let stored = await browserSignIn.endForSignOut() { await browserSignIn.revoke(stored) }
            try? keychain.deleteToken()
            errorMessage = userFacing(error, fallback: "Could not finish signing in. Try again.")
            return false
        }
        scheduleBrowserSessionRefresh(expiresAt: grant.credential.expiresAt)
        return true
    }

    /// The stored access token for launch. A browser sign-in token that
    /// expires within the refresh margin is refreshed first. A refused
    /// refresh throws an ended session; an expired token that could not be
    /// refreshed throws a connection error, which keeps the sign-in.
    func browserSessionTokenForLaunch(_ stored: String?) async throws -> String? {
        guard let stored, !isPreviewMode else { return stored }
        guard await browserSignIn.store.launchCredential(origin: KordiAppEnvironment.current.cloudBaseURL) != nil else {
            return stored
        }
        switch await browserSignIn.store.refresh(ifExpiringWithin: AppSignInController.refreshMargin) {
        case .current(let current):
            scheduleBrowserSessionRefresh(expiresAt: current.expiresAt)
            return current.accessToken
        case .refreshed(let next):
            scheduleBrowserSessionRefresh(expiresAt: next.expiresAt)
            return next.accessToken
        case .rejected:
            throw CloudAPIError(code: "invalid_session", message: "Your session expired. Sign in again.", statusCode: 401)
        case .unavailable:
            guard let current = await browserSignIn.store.credential(), current.expiresAt > Date() else {
                throw CloudAPIError(code: "network_error", message: "Could not reach the server.", statusCode: 0)
            }
            scheduleBrowserSessionRetry()
            return current.accessToken
        case .notBrowserSession:
            return (try? keychain.loadToken()) ?? stored
        }
    }

    /// Whether a failed launch keeps the stored browser sign-in: only the
    /// server ending the session (401, `invalid_session`, `account_missing`)
    /// discards it. Connection and server errors keep it for the next try.
    func keepsBrowserSession(afterLaunchFailure error: Error) async -> Bool {
        guard await browserSignIn.store.credential() != nil else { return false }
        return !Self.sessionEnded(by: error)
    }

    nonisolated static func sessionEnded(by error: Error) -> Bool {
        guard let error = error as? CloudAPIError else { return false }
        return error.statusCode == 401 || ["invalid_session", "account_missing"].contains(error.code)
    }

    /// A password or provider sign-in replaces a kept browser sign-in: it is
    /// removed and revoked, so a later refresh cannot swap its token back in.
    /// The browser path stores its credential first, which this keeps.
    func dropBrowserSignIn(unlessFor token: String) async {
        guard let stored = await browserSignIn.store.credential(), stored.accessToken != token,
              let removed = await browserSignIn.endForSignOut() else { return }
        Task { await browserSignIn.revoke(removed) }
    }

    /// The share extension's expiry for the launch token: the browser
    /// sign-in's expiry when the token came from one, otherwise the saved
    /// expiry of an unchanged, unexpired token.
    func shareExpiry(forLaunchToken token: String, existing: ShareExtensionCredential?) async -> String? {
        if let credential = await browserSignIn.store.credential(), credential.accessToken == token {
            return credential.expiresAtText
        }
        return existing?.token == token && existing?.isExpired == false ? existing?.expiresAt : nil
    }

    /// Removes the stored session after the server ended it, revoking a
    /// browser sign-in instead of only forgetting it.
    func discardStoredSession() async {
        if let stored = await browserSignIn.endForSignOut() {
            Task { await browserSignIn.revoke(stored) }
        }
        try? keychain.deleteToken()
    }

    /// Restores a browser sign-in kept after a failed launch, for example when
    /// the welcome screen appears or the app returns to the foreground.
    func resumeStoredBrowserSession() async {
        guard phase == .signedOut, !isPreviewMode,
              (try? keychain.loadToken()) != nil,
              await browserSignIn.store.credential() != nil else { return }
        await start()
    }

    /// Refreshes a browser sign-in token that expires within the refresh
    /// margin and adopts it, or adopts a token background work already
    /// refreshed. A refused refresh signs out.
    func refreshBrowserSessionIfNeeded() async {
        guard !isPreviewMode else { return }
        switch await browserSignIn.store.refresh(ifExpiringWithin: AppSignInController.refreshMargin) {
        case .current(let credential), .refreshed(let credential):
            applyRefreshedSession(token: credential.accessToken, expiresAt: credential.expiresAtText, accountId: credential.accountId)
            scheduleBrowserSessionRefresh(expiresAt: credential.expiresAt)
        case .rejected:
            await signOut()
            errorMessage = "Your session expired. Sign in again."
        case .unavailable:
            scheduleBrowserSessionRetry()
        case .notBrowserSession:
            break
        }
    }

    /// Ends the server side of a sign-out: revokes the browser sign-in, then
    /// ends the session token. Both are best effort.
    func endSignIn(token: String?, browserSignIn credential: AppSignInCredential?) async {
        if let credential { await browserSignIn.revoke(credential) }
        if let token { try? await api.logout(token: token) }
    }

    func userFacing(_ error: Error, fallback: String) -> String {
        if let error = error as? CloudAPIError {
            switch error.code {
            case "invalid_email": return "That email address looks malformed."
            case "weak_password": return error.message.nonEmpty ?? KordiLoginCopy.weakPasswordMessage
            case "email_in_use": return "An account with that email already exists. Try logging in instead."
            case "invalid_credentials": return "Email or password is incorrect."
            case "rate_limited": return "Too many attempts. Wait a moment, then try again."
            case "invalid_session", "account_missing": return "Your session expired. Sign in again."
            case "network_error": return "Kordi Cloud is unavailable. Check your connection and try again."
            case "proxy_unreachable": return error.message.nonEmpty ?? "Kordi can't reach this network's proxy. Check the proxy settings or connect to another network."
            case "invalid_redirect": return "This Kordi build is not yet allowed to finish social sign-in."
            case "oauth_not_configured": return "This sign-in provider is temporarily unavailable."
            case "device_review_required": return "Approve this device from another device first."
            default: return error.message.nonEmpty ?? fallback
            }
        }
        return error.localizedDescription.nonEmpty ?? fallback
    }

    private func scheduleBrowserSessionRefresh(expiresAt: Date) {
        let delay = expiresAt.timeIntervalSinceNow - AppSignInController.refreshMargin
        browserSignIn.scheduleRefresh(after: delay) { [weak self] in
            await self?.refreshBrowserSessionIfNeeded()
        }
    }

    private func scheduleBrowserSessionRetry() {
        browserSignIn.scheduleRefresh(after: AppSignInController.retryDelay) { [weak self] in
            await self?.refreshBrowserSessionIfNeeded()
        }
    }
}
