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
    /// expires within the refresh margin is refreshed first; a refused
    /// refresh throws so launch signs out.
    func browserSessionTokenForLaunch(_ stored: String?) async throws -> String? {
        guard let stored, !isPreviewMode else { return stored }
        guard let credential = await browserSignIn.store.credential() else { return stored }
        guard credential.accessToken == stored else {
            // Left behind by an older session; it does not belong to this token.
            _ = await browserSignIn.store.take()
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
            scheduleBrowserSessionRetry()
            return stored
        case .notBrowserSession:
            return stored
        }
    }

    /// Refreshes a browser sign-in token that expires within the refresh
    /// margin and adopts it. A refused refresh signs out.
    func refreshBrowserSessionIfNeeded() async {
        guard !isPreviewMode else { return }
        switch await browserSignIn.store.refresh(ifExpiringWithin: AppSignInController.refreshMargin) {
        case .current(let current):
            scheduleBrowserSessionRefresh(expiresAt: current.expiresAt)
        case .refreshed(let next):
            applyRefreshedSession(token: next.accessToken, expiresAt: next.expiresAtText, accountId: next.accountId)
            scheduleBrowserSessionRefresh(expiresAt: next.expiresAt)
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
