import Foundation

/// The outcome of a safety action, with the copy to show when it failed.
enum SafetyActionResult: Equatable {
    case done
    case failed(String)
}

extension AppModel {
    func isBlocked(_ accountId: String?) -> Bool {
        guard let accountId = accountId?.nonEmpty else { return false }
        return blockedAccounts.contains { $0.accountId == accountId }
    }

    /// Whether block, report, and removal can be offered for an account:
    /// the server supports them and the account is another person, not a
    /// Kordi service account.
    func safetyActionsAllowed(for accountId: String?) -> Bool {
        guard safetyFeaturesAvailable,
              let accountId = accountId?.nonEmpty,
              accountId != account?.accountId else { return false }
        return !GroupLeavePlan.isServiceAccount(accountId)
    }

    /// Loads the block list. An empty 404 means the server has no blocks yet,
    /// which hides every new safety action. Other failures keep the last
    /// known state for the next refresh.
    func refreshBlockedAccounts() async {
        guard !isPreviewMode, let (api, token, account) = try? safetyContext() else { return }
        do {
            let blocks = try await api.listBlockedAccounts(token: token)
            guard isCurrent(token: token, accountId: account.accountId) else { return }
            blockedAccounts = blocks
            safetyFeaturesAvailable = true
        } catch let error as CloudAPIError where error.isMissingRoute {
            guard isCurrent(token: token, accountId: account.accountId) else { return }
            blockedAccounts = []
            safetyFeaturesAvailable = false
        } catch {
            // Best effort: the workspace refresh and sync events retry.
        }
    }

    func block(accountId: String, name: String) async -> SafetyActionResult {
        let failure = "Couldn't block \(name). Check your connection and try again."
        if isPreviewMode {
            blockedAccounts.removeAll { $0.accountId == accountId }
            blockedAccounts.insert(
                CloudBlockedAccount(accountId: accountId, kordiId: nil, displayName: name, avatarUrl: nil, blockedAt: nil),
                at: 0
            )
            forgetContactRelationship(with: accountId)
            return .done
        }
        guard let (api, token, account) = try? safetyContext() else { return .failed(failure) }
        do {
            let result = try await api.blockAccount(token: token, accountId: accountId)
            guard isCurrent(token: token, accountId: account.accountId) else { return .done }
            blockedAccounts.removeAll { $0.accountId == accountId }
            blockedAccounts.insert(result.block, at: 0)
            forgetContactRelationship(with: accountId)
            await refreshWorkspace(showSyncActivity: false)
            return .done
        } catch {
            return .failed(safetyUserFacing(error, fallback: failure))
        }
    }

    func unblock(accountId: String, name: String) async -> SafetyActionResult {
        let failure = "Couldn't unblock \(name). Try again."
        if isPreviewMode {
            blockedAccounts.removeAll { $0.accountId == accountId }
            return .done
        }
        guard let (api, token, account) = try? safetyContext() else { return .failed(failure) }
        do {
            try await api.unblockAccount(token: token, accountId: accountId)
            guard isCurrent(token: token, accountId: account.accountId) else { return .done }
            blockedAccounts.removeAll { $0.accountId == accountId }
            return .done
        } catch {
            return .failed(safetyUserFacing(error, fallback: failure))
        }
    }

    func removeContact(accountId: String, name: String) async -> SafetyActionResult {
        let failure = "Couldn't remove \(name) from your contacts. Try again."
        if isPreviewMode {
            forgetContactRelationship(with: accountId)
            return .done
        }
        guard let (api, token, account) = try? safetyContext() else { return .failed(failure) }
        do {
            try await api.removeContact(token: token, peerAccountId: accountId)
            guard isCurrent(token: token, accountId: account.accountId) else { return .done }
            forgetContactRelationship(with: accountId)
            await refreshWorkspace(showSyncActivity: false)
            return .done
        } catch {
            return .failed(safetyUserFacing(error, fallback: failure))
        }
    }

    func withdrawContactRequest(_ request: CloudContactRequest) async -> SafetyActionResult {
        let failure = "Couldn't withdraw the request. Try again."
        guard !request.isIncoming else { return .failed(failure) }
        if isPreviewMode {
            forgetContactRequest(request.requestId)
            return .done
        }
        guard let (api, token, account) = try? safetyContext() else { return .failed(failure) }
        do {
            try await api.withdrawContactRequest(token: token, requestId: request.requestId)
            guard isCurrent(token: token, accountId: account.accountId) else { return .done }
            forgetContactRequest(request.requestId)
            return .done
        } catch {
            if let error = error as? CloudAPIError, error.code == "request_decided" {
                // Answered meanwhile: show what the server has now.
                await refreshContactRequests()
            }
            return .failed(safetyUserFacing(error, fallback: failure))
        }
    }

    /// Sends a report. `clientReportId` stays the same while the person
    /// retries the same report, so a retry after a lost answer is not
    /// counted twice.
    func report(
        _ target: ReportTarget,
        reason: CloudReportReason,
        details: String,
        clientReportId: String
    ) async -> Result<CloudReportReceipt, ReportFailure> {
        let networkFailure = ReportTarget.networkFailureMessage
        if isPreviewMode {
            return .failure(ReportFailure(message: "Reports aren't sent from preview data."))
        }
        guard let (api, token, _) = try? safetyContext() else {
            return .failure(ReportFailure(message: networkFailure))
        }
        do {
            let receipt = try await api.createReport(
                token: token,
                sessionId: target.sessionId,
                messageId: target.messageId,
                reportedAccountId: target.messageId == nil ? target.accountId : nil,
                reason: reason,
                details: ReportTarget.normalizedDetails(details),
                contactRequestId: target.contactRequestId,
                clientReportId: clientReportId
            )
            return .success(receipt)
        } catch {
            return .failure(ReportFailure(message: safetyUserFacing(error, fallback: networkFailure)))
        }
    }

    private func isCurrent(token: String, accountId: String) -> Bool {
        guard let (_, currentToken, currentAccount) = try? safetyContext() else { return false }
        return currentToken == token && currentAccount.accountId == accountId
    }
}

struct ReportFailure: Error, Equatable {
    let message: String
}
