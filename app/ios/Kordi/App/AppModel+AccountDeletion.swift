import Foundation

/// How the Delete account page confirms it is the account holder, following
/// the server's proof rules: the password when the account has one, else an
/// emailed code, unless the sign-in is under ten minutes old.
enum AccountDeletionProofMode: Equatable {
    case loading
    /// `allowsEmailCode` is set when the account's sign-in facts are unknown.
    case password(allowsEmailCode: Bool)
    case emailCode
    case recentSignIn
    /// No password, no email for a code, and no recent sign-in.
    case signInAgain

    static func from(_ overview: CloudAccountSecurityOverview) -> Self {
        if overview.password.set { return .password(allowsEmailCode: false) }
        if overview.recentSignIn == true { return .recentSignIn }
        let hasEmail = overview.email?.address?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        return hasEmail ? .emailCode : .signInAgain
    }

    /// The proof a refused delete asks for instead.
    static func after(_ error: Error, current: Self) -> Self {
        switch (error as? CloudAPIError)?.code {
        case "current_password_required": .password(allowsEmailCode: false)
        case "reauthentication_required": current == .signInAgain ? .signInAgain : .emailCode
        case "email_missing": .signInAgain
        default: current
        }
    }
}

/// Local data a deleted account leaves on this iPhone.
@MainActor
enum AccountDeletionCleanup {
    /// Documents keep reader identity under fixed keys.
    static let fixedDefaultsKeys = [
        DocumentReaderModel.readerKeyDefaultsKey,
        DocumentReaderModel.readerNameDefaultsKey,
    ]
    /// Grounding keeps device state and card designs under this prefix.
    static let defaultsPrefixes = ["commonGround."]

    /// Keys scoped to the account (organization choice, Digest calendar sync,
    /// Grounding profile) plus Grounding and document reader state.
    static func defaultsKeysToRemove(allKeys: some Sequence<String>, accountId: String) -> [String] {
        guard !accountId.isEmpty else { return [] }
        return allKeys.filter { key in
            key.contains(accountId)
                || fixedDefaultsKeys.contains(key)
                || defaultsPrefixes.contains(where: key.hasPrefix)
        }
        .sorted()
    }

    static func cacheDirectories(fileManager: FileManager = .default) -> [URL] {
        let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return [
            caches?.appendingPathComponent("Kordi/Attachments", isDirectory: true),
            support?.appendingPathComponent("Kordi/ExpressiveMedia", isDirectory: true),
            caches?.appendingPathComponent("KordiVoiceTranscripts", isDirectory: true),
            EmojiAnimationDiskCache.standard.directory,
        ].compactMap { $0 }
    }

    static func wipe(accountId: String, defaults: UserDefaults = .standard, fileManager: FileManager = .default) {
        for directory in cacheDirectories(fileManager: fileManager) {
            try? fileManager.removeItem(at: directory)
        }
        for key in defaultsKeysToRemove(allKeys: defaults.dictionaryRepresentation().keys, accountId: accountId) {
            defaults.removeObject(forKey: key)
        }
    }
}

extension AppModel {
    func accountDeletionProofMode() async -> AccountDeletionProofMode {
        if isPreviewMode { return .password(allowsEmailCode: false) }
        guard let (api, token, _) = try? projectContext(),
              let overview = try? await api.accountSecurityOverview(token: token) else {
            return .password(allowsEmailCode: true)
        }
        return .from(overview)
    }

    func requestAccountDeletionCode() async throws -> CloudSignupCodeChallenge {
        if isPreviewMode {
            return CloudSignupCodeChallenge(verificationId: "preview", expiresAt: "", retryAfterSeconds: 30)
        }
        let (api, token, _) = try projectContext()
        return try await api.requestReauthenticationCode(token: token)
    }

    /// Deletes the account, then clears this iPhone without the logout call
    /// (the server already ended every session).
    func deleteAccount(_ proof: AccountDeletionRequest, callCoordinator: KordiCallCoordinator) async throws {
        guard !isPreviewMode else { return }
        let (api, token, accountId) = try projectContext()
        try await api.deleteAccount(token: token, proof: proof)
        await callCoordinator.prepareForAccountTeardown()
        await signOut(accountDeleted: true)
        AccountDeletionCleanup.wipe(accountId: accountId)
    }
}
