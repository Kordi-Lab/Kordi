import Foundation

/// The blocked accounts of one signed-in account, so a list loaded for one
/// account never shows after switching to another.
struct BlockedAccountList: Equatable {
    let viewerAccountId: String
    var accounts: [CloudBlockedAccount]
}

/// The outcome of a block or unblock, with the message to show when it failed.
enum SafetyActionResult: Equatable {
    case done
    case failed(String)
}

extension AppModel {
    /// Nil until the list is loaded for the signed-in account.
    var blockedAccounts: [CloudBlockedAccount]? {
        guard let list = blockedAccountList, list.viewerAccountId == account?.accountId else { return nil }
        return list.accounts
    }

    func isBlocked(_ accountId: String?) -> Bool {
        guard let accountId = accountId?.nonEmpty else { return false }
        return blockedAccounts?.contains { $0.accountId == accountId } == true
    }

    /// Whether an account can be blocked or reported: another person, not a
    /// Kordi service account.
    func allowsSafetyActions(for accountId: String?) -> Bool {
        guard let accountId = accountId?.nonEmpty, accountId != account?.accountId else { return false }
        return !SafetyAccount.isServiceAccount(accountId)
    }

    /// Loads the block list; returns the error message when it failed.
    @discardableResult
    func refreshBlockedAccounts() async -> String? {
        if isPreviewMode {
            if blockedAccounts == nil { setBlockedAccounts([]) }
            return nil
        }
        guard let (api, token, viewer) = try? digestContext() else { return nil }
        do {
            let blocks = try await api.listBlockedAccounts(token: token)
            guard isSafetyContextCurrent(token: token, viewer: viewer) else { return nil }
            blockedAccountList = BlockedAccountList(viewerAccountId: viewer, accounts: blocks)
            return nil
        } catch {
            return safetyMessage(error, fallback: "Could not load blocked accounts.")
        }
    }

    func block(_ target: SafetyAccount) async -> SafetyActionResult {
        if isPreviewMode {
            rememberBlocked(CloudBlockedAccount(accountId: target.accountId, kordiId: target.kordiId, displayName: target.name, avatarUrl: target.avatarUrl))
            return .done
        }
        guard let (api, token, viewer) = try? digestContext() else { return .failed("Could not block \(target.name).") }
        do {
            let result = try await api.blockAccount(token: token, accountId: target.accountId)
            guard isSafetyContextCurrent(token: token, viewer: viewer) else { return .done }
            rememberBlocked(result.block)
            // The server removed the contact and any pending requests.
            await refreshWorkspace(showSyncActivity: false)
            return .done
        } catch {
            return .failed(safetyMessage(error, fallback: "Could not block \(target.name)."))
        }
    }

    func unblock(_ blocked: CloudBlockedAccount) async -> SafetyActionResult {
        if isPreviewMode {
            forgetBlocked(blocked.accountId)
            return .done
        }
        guard let (api, token, viewer) = try? digestContext() else { return .failed("Could not unblock \(blocked.preferredName).") }
        do {
            try await api.unblockAccount(token: token, accountId: blocked.accountId)
            guard isSafetyContextCurrent(token: token, viewer: viewer) else { return .done }
            forgetBlocked(blocked.accountId)
            return .done
        } catch {
            return .failed(safetyMessage(error, fallback: "Could not unblock \(blocked.preferredName)."))
        }
    }

    /// Sends a report. `clientReportId` stays the same while the same report
    /// is retried. Preview data never reaches the network.
    func report(
        _ target: ReportTarget,
        reason: CloudReportReason,
        details: String,
        alsoBlock: Bool,
        clientReportId: String
    ) async -> Result<CloudReportResult, ReportFailure> {
        let request = target.request(reason: reason, details: details, alsoBlock: alsoBlock, clientReportId: clientReportId)
        if isPreviewMode {
            if request.alsoBlock == true, let account = target.account {
                rememberBlocked(CloudBlockedAccount(accountId: account.accountId, kordiId: account.kordiId, displayName: account.name, avatarUrl: account.avatarUrl))
            }
            return .success(CloudReportResult(report: .preview(reason: reason, target: target), blocked: request.alsoBlock == true))
        }
        guard let (api, token, viewer) = try? digestContext() else {
            return .failure(ReportFailure(message: "Could not send the report."))
        }
        do {
            let result = try await api.createReport(token: token, request: request, sessionId: target.sessionId)
            if result.blocked, isSafetyContextCurrent(token: token, viewer: viewer) {
                if let account = target.account {
                    rememberBlocked(CloudBlockedAccount(accountId: account.accountId, kordiId: account.kordiId, displayName: account.name, avatarUrl: account.avatarUrl))
                }
                await refreshWorkspace(showSyncActivity: false)
            }
            return .success(result)
        } catch {
            return .failure(ReportFailure(message: safetyMessage(error, fallback: "Could not send the report.")))
        }
    }

    /// Two synthetic blocked people for `--preview-blocked`.
    func seedPreviewBlockedAccounts() {
        guard isPreviewMode, blockedAccounts?.isEmpty ?? true else { return }
        setBlockedAccounts([
            CloudBlockedAccount(accountId: "acct_preview_blocked_jordan", kordiId: "305118274", displayName: "Jordan Pike"),
            CloudBlockedAccount(accountId: "acct_preview_blocked_rae", kordiId: "771402659", displayName: "Rae Okafor"),
        ])
    }

    /// Blocks the sample group member Ethan Park for `--preview-blocked-message`.
    func seedPreviewBlockedMessageAuthor() {
        guard isPreviewMode, !isBlocked("acct_ethan") else { return }
        rememberBlocked(CloudBlockedAccount(accountId: "acct_ethan", kordiId: "418203576", displayName: "Ethan Park"))
    }

    /// The server's own message, which says why a safety action failed.
    func safetyMessage(_ error: Error, fallback: String) -> String {
        if let error = error as? CloudAPIError {
            if error.code == "network_error" || error.code == "proxy_unreachable" { return userFacing(error, fallback: fallback) }
            return error.message.nonEmpty ?? fallback
        }
        return fallback
    }

    #if DEBUG
    /// Preview data only: puts an account on the local block list.
    func previewMarkBlocked(_ blocked: CloudBlockedAccount) {
        guard isPreviewMode else { return }
        rememberBlocked(blocked)
    }
    #endif

    private func setBlockedAccounts(_ accounts: [CloudBlockedAccount]) {
        guard let viewer = account?.accountId else { return }
        blockedAccountList = BlockedAccountList(viewerAccountId: viewer, accounts: accounts)
    }

    private func rememberBlocked(_ blocked: CloudBlockedAccount) {
        var accounts = blockedAccounts ?? []
        accounts.removeAll { $0.accountId == blocked.accountId }
        accounts.insert(blocked, at: 0)
        setBlockedAccounts(accounts)
    }

    private func forgetBlocked(_ accountId: String) {
        guard var accounts = blockedAccounts else { return }
        accounts.removeAll { $0.accountId == accountId }
        setBlockedAccounts(accounts)
    }

    private func isSafetyContextCurrent(token: String, viewer: String) -> Bool {
        guard let (_, currentToken, currentViewer) = try? digestContext() else { return false }
        return currentToken == token && currentViewer == viewer
    }
}

struct ReportFailure: Error, Equatable {
    let message: String
}

private extension CloudReportReceipt {
    static func preview(reason: CloudReportReason, target: ReportTarget) -> CloudReportReceipt {
        CloudReportReceipt(
            reportId: "report_preview",
            reference: "R-PREVIEW1",
            status: "received",
            reason: reason.rawValue,
            targetKind: target.messageId == nil ? "account" : "message",
            evidenceMessageCount: target.messageId == nil ? 0 : 1,
            reportedDisplayName: target.account?.name,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
    }
}
