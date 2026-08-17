import Foundation
import SwiftUI

enum AppPhase: Equatable {
    case launching
    case signedOut
    case signedIn
}

enum AgentPromptContext {
    static func compose(userText: String, referenceText: String?) -> String {
        guard let referenceText = referenceText?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty else { return userText }
        return "\(referenceText)\n\nRequest:\n\(userText)"
    }
}

enum CloudConnectionState: Equatable {
    case connecting
    case connected
    case unavailable
}

enum MessageSyncState: Equatable {
    case syncing
    case upToDate
    case offline
}

struct ConversationReadPresentation: Equatable {
    let conversationID: String
    let isPresented: Bool
    let isAppForeground: Bool
    let isAtLatest: Bool

    var canMarkRead: Bool {
        isPresented && isAppForeground && isAtLatest
    }
}

@MainActor
final class AppModel: ObservableObject {
    private static let cloudUnavailableMessage = "Kordi Cloud is unavailable. Check your connection and try again."

    private struct ConversationPresentationSnapshot: Equatable {
        let latestMessageID: String?
        let lastActivityAt: Date
    }

    @Published private(set) var phase: AppPhase = .launching
    @Published private(set) var account: CloudAccount?
    @Published private(set) var contacts: [CloudContact] = []
    @Published private(set) var contactRequests: [CloudContactRequest] = []
    @Published private(set) var conversations: [ConversationSummary] = []
    @Published private(set) var messagesByConversation: [String: [ChatMessage]] = [:]
    @Published private(set) var callsByConversationID: [String: CloudCall] = [:]
    @Published private(set) var latestCallSnapshot: CloudCall?
    @Published private(set) var sessionActivityByID: [String: CloudSessionActivity] = [:]
    @Published private(set) var sessionPinsByID: [String: CloudSessionPin] = [:]
    @Published private(set) var providerAuthSnapshot: CloudProviderAuthSnapshot?
    @Published private(set) var providerAuthSnapshots: [String: CloudProviderAuthSnapshot] = [:]
    @Published private(set) var isRefreshingProviderAuthentication = false
    @Published private(set) var isRefreshingFactory = false
    @Published private(set) var providerAuthenticationErrorMessage: String?
    @Published private(set) var devices: [CloudDeviceAuthorization] = []
    @Published private(set) var isRefreshingDevices = false
    @Published private(set) var deviceErrorMessage: String?
    @Published private(set) var deviceReviewRequired = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var agentRunState: [String: AgentActivity] = [:]
    @Published private(set) var agentExecutionLocation: [String: AgentExecutionLocation] = [:]
    @Published private(set) var cloudConnectionState: CloudConnectionState = .connecting
    @Published private(set) var messageSyncState: MessageSyncState = .syncing
    @Published private(set) var lastMessageSyncAt: Date?
    @Published private(set) var loadingConversationIDs = Set<String>()
    @Published var errorMessage: String?

    private let api: CloudAPIClient
    private let oauth: CloudOAuthSession
    private let keychain: KeychainSessionStore
    private let cache: LocalMessageStore?
    private let wireCache: CloudWireCache
    private let sessionRuntimeRouteStore: SessionRuntimeRouteStore
    private let attachmentFileStore = AttachmentFileStore()
    private let expressiveMediaLibrary = ExpressiveMediaLibraryStore()
    let conversationViewportMemory = ConversationViewportMemory()
    private var token: String?
    private var currentDeviceId: String?
    private var deviceOperationIds: [String: String] = [:]
    private var cloudSyncTask: Task<Void, Never>?
    private var expressiveMediaSyncTask: Task<Void, Never>?
    private var expressiveMediaSyncTaskID: UUID?
    private var cloudSyncCursor = "0"
    private var hasHydratedWireSnapshot = false
    private var hasHydratedForkLineage = false
    private var fullyHydratedCanonicalGroupSessionIds = Set<String>()
    private var cloudMessagesByPeer: [String: [CloudMessageDTO]] = [:]
    private var cloudMessageIndicesByPeer: [String: [String: Int]] = [:]
    private var sessionForksById: [String: CloudSessionForkSummary] = [:]
    private var canonicalConversationIDBySessionID: [String: String] = [:]
    @Published private var ownedCloudAgents: [CloudAgent] = []
    private var sharedCloudAgents: [CloudAgent] = []
    private var hiddenCloudSessionIds = Set<String>()
    private var deletedCloudSessionIds = Set<String>()
    private var pendingAgentRequestIds: [String: String] = [:]
    private var pendingAttachmentDraftsByMessageId: [String: [PendingAttachment]] = [:]
    private var pendingReplyByMessageId: [String: MessageActionSource] = [:]
    private var pendingMessageActionByMessageId: [String: MessageActionMetadata] = [:]
    private var pendingMentionByMessageId: [String: ComposerMentionTarget] = [:]
    private var pendingAgentContextByMessageId: [String: String] = [:]
    private var conversationLoadCounts: [String: Int] = [:]
    private var settledConversationPresentations: [String: ConversationPresentationSnapshot] = [:]
    private var conversationReadPresentations: [UUID: ConversationReadPresentation] = [:]
    private var pendingVisibleReadMessageBySessionID: [String: String] = [:]
    private var persistedVisibleReadMessageBySessionID: [String: String] = [:]
    private var sessionTitleOverrides: [String: String] = UserDefaults.standard.dictionary(forKey: "kordi.session-title-overrides") as? [String: String] ?? [:]
    private let previewMode: Bool

    var isPreviewMode: Bool { previewMode }

    init(
        api: CloudAPIClient = CloudAPIClient(),
        keychain: KeychainSessionStore = KeychainSessionStore(),
        cache: LocalMessageStore? = nil,
        wireCache: CloudWireCache = CloudWireCache(),
        sessionRuntimeRouteStore: SessionRuntimeRouteStore = SessionRuntimeRouteStore(),
        previewMode: Bool = ProcessInfo.processInfo.arguments.contains("--preview-data")
            || ProcessInfo.processInfo.arguments.contains("--preview-markdown")
            || ProcessInfo.processInfo.arguments.contains("--preview-login")
            || ProcessInfo.processInfo.arguments.contains("--preview-signup")
            || ProcessInfo.processInfo.arguments.contains("--preview-account")
            || ProcessInfo.processInfo.arguments.contains("--preview-devices")
            || ProcessInfo.processInfo.arguments.contains("--preview-authentication")
            || ProcessInfo.processInfo.arguments.contains("--preview-authentication-detail")
            || ProcessInfo.processInfo.arguments.contains("--preview-new-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-add-contact")
            || ProcessInfo.processInfo.arguments.contains("--preview-companion-panel")
            || ProcessInfo.processInfo.arguments.contains("--preview-companion-return")
            || ProcessInfo.processInfo.arguments.contains("--preview-contact-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-direct-call")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-call")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-detail")
            || ProcessInfo.processInfo.arguments.contains("--preview-group-invite")
            || ProcessInfo.processInfo.arguments.contains("--preview-media")
            || ProcessInfo.processInfo.arguments.contains("--preview-media-messages")
            || ProcessInfo.processInfo.arguments.contains("--preview-media-expanded")
            || ProcessInfo.processInfo.arguments.contains("--preview-media-separated")
            || ProcessInfo.processInfo.arguments.contains("--preview-photo-send")
    ) {
        self.api = api
        self.oauth = CloudOAuthSession(api: api)
        self.keychain = keychain
        self.cache = cache ?? (try? LocalMessageStore())
        self.wireCache = wireCache
        self.sessionRuntimeRouteStore = sessionRuntimeRouteStore
        self.previewMode = previewMode
        if ProcessInfo.processInfo.arguments.contains("--preview-login")
            || ProcessInfo.processInfo.arguments.contains("--preview-signup") {
            phase = .signedOut
        } else if previewMode {
            installPreviewData()
        }
    }

    deinit {
        cloudSyncTask?.cancel()
        expressiveMediaSyncTask?.cancel()
    }

    func start() async {
        guard !previewMode else { return }
        do {
            guard let savedToken = try keychain.loadToken() else {
                phase = .signedOut
                return
            }
            let restoredAccount = try await api.me(token: savedToken)
            token = savedToken
            account = restoredAccount
            conversations = cache?.loadConversations() ?? []
            conversations.forEach(hydrateCachedMessages)
            if let snapshot = await wireCache.load(accountId: restoredAccount.accountId) {
                cloudMessagesByPeer = snapshot.messagesByPeer
                sessionForksById = snapshot.sessionForksById ?? [:]
                rebuildCloudMessageIndices()
                cloudSyncCursor = snapshot.cursor
                lastMessageSyncAt = snapshot.savedAt
                hasHydratedWireSnapshot = snapshot.cursor != "0"
                hasHydratedForkLineage = snapshot.sessionForksById != nil
                    && snapshot.forkLineageVersion == CloudWireSnapshot.currentForkLineageVersion
            }
            conversations.forEach(prepareConversationForPresentation)
            phase = .signedIn
            startCloudSync(resetCursor: CloudSyncRecoveryPolicy.requiresBootstrap(
                hasHydratedWireSnapshot: hasHydratedWireSnapshot,
                hasHydratedForkLineage: hasHydratedForkLineage
            ))
            scheduleExpressiveMediaLibrarySync()
            await refreshWorkspace()
        } catch {
            if CloudTransportErrorPolicy.isCancellation(error) || Task.isCancelled { return }
            try? keychain.deleteToken()
            token = nil
            currentDeviceId = nil
            account = nil
            devices = []
            deviceOperationIds = [:]
            phase = .signedOut
        }
    }

    func signIn(email: String, password: String) async -> Bool {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty, !password.isEmpty else {
            errorMessage = "Enter your email and password."
            return false
        }
        errorMessage = nil
        do {
            let response = try await api.login(email: cleanEmail, password: password)
            try await completeAuthentication(response)
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not sign in.")
            return false
        }
    }

    func signUp(
        email: String,
        password: String,
        displayName: String?,
        avatarUrl: String
    ) async -> Bool {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        guard !cleanEmail.isEmpty else {
            errorMessage = "Enter your email address."
            return false
        }
        guard password.count >= 8 else {
            errorMessage = "Password must be at least 8 characters."
            return false
        }
        errorMessage = nil
        do {
            let response = try await api.signup(
                email: cleanEmail,
                password: password,
                displayName: cleanName,
                avatarUrl: avatarUrl
            )
            try await completeAuthentication(response)
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not create account.")
            return false
        }
    }

    func signIn(with provider: CloudOAuthProvider) async -> Bool {
        errorMessage = nil
        do {
            let response = try await oauth.authenticate(with: provider)
            try await completeAuthentication(response)
            return true
        } catch CloudOAuthSessionError.cancelled {
            return false
        } catch {
            errorMessage = userFacing(error, fallback: "Could not sign in with \(provider.displayName).")
            return false
        }
    }

    func signOut() async {
        let oldToken = token
        let oldAccountId = account?.accountId
        cloudSyncTask?.cancel()
        cloudSyncTask = nil
        expressiveMediaSyncTask?.cancel()
        expressiveMediaSyncTask = nil
        expressiveMediaSyncTaskID = nil
        cloudSyncCursor = "0"
        hasHydratedWireSnapshot = false
        hasHydratedForkLineage = false
        fullyHydratedCanonicalGroupSessionIds = []
        cloudConnectionState = .connecting
        messageSyncState = .syncing
        token = nil
        currentDeviceId = nil
        account = nil
        contacts = []
        contactRequests = []
        conversations = []
        messagesByConversation = [:]
        callsByConversationID = [:]
        latestCallSnapshot = nil
        sessionActivityByID = [:]
        sessionPinsByID = [:]
        providerAuthSnapshot = nil
        providerAuthSnapshots = [:]
        devices = []
        deviceOperationIds = [:]
        deviceErrorMessage = nil
        deviceReviewRequired = false
        cloudMessagesByPeer = [:]
        cloudMessageIndicesByPeer = [:]
        sessionForksById = [:]
        canonicalConversationIDBySessionID = [:]
        ownedCloudAgents = []
        sharedCloudAgents = []
        hiddenCloudSessionIds = []
        deletedCloudSessionIds = []
        agentRunState = [:]
        agentExecutionLocation = [:]
        loadingConversationIDs = []
        conversationLoadCounts = [:]
        settledConversationPresentations = [:]
        conversationReadPresentations = [:]
        pendingVisibleReadMessageBySessionID = [:]
        persistedVisibleReadMessageBySessionID = [:]
        pendingAgentRequestIds = [:]
        pendingAttachmentDraftsByMessageId = [:]
        pendingReplyByMessageId = [:]
        pendingMessageActionByMessageId = [:]
        pendingMentionByMessageId = [:]
        pendingAgentContextByMessageId = [:]
        cache?.clear()
        if let oldAccountId { await wireCache.clear(accountId: oldAccountId) }
        try? keychain.deleteToken()
        phase = .signedOut
        if let oldToken { try? await api.logout(token: oldToken) }
    }

    func refreshWorkspace(showSyncActivity: Bool = true) async {
        guard let token, let account, !isRefreshing else { return }
        isRefreshing = true
        if showSyncActivity { messageSyncState = .syncing }
        defer { isRefreshing = false }
        do {
            async let fetchedContacts = api.listContacts(token: token)
            async let fetchedRequests = api.listContactRequests(token: token)
            async let ownedAgents = api.listAgents(token: token)
            async let fetchedVisibility = api.listSessionVisibility(token: token)
            async let fetchedAuth = try? api.currentProviderAuthSnapshot(token: token)
            async let fetchedDevices = try? api.listDevices(token: token)
            async let canonicalLatestMessages = api.bootstrapChatLatestMessages(token: token)
            let (contactList, requests, owned, visibility, authSnapshot, deviceList, latestCanonical) = try await (
                fetchedContacts, fetchedRequests, ownedAgents, fetchedVisibility, fetchedAuth,
                fetchedDevices, canonicalLatestMessages
            )
            var shared = try await api.listSharedAgents(
                token: token,
                ownerAccountIds: contactList.map(\.accountId)
            )
            contacts = contactList.sorted { $0.preferredName.localizedCaseInsensitiveCompare($1.preferredName) == .orderedAscending }
            contactRequests = requests
            ownedCloudAgents = owned
            providerAuthSnapshot = authSnapshot
            if let deviceList {
                devices = deviceList
                currentDeviceId = deviceList.first(where: \.currentDevice)?.deviceId
                deviceReviewRequired = deviceList.contains { $0.needsReview && !$0.currentDevice }
            }
            if let authSnapshot {
                providerAuthSnapshots[ProviderAuthenticationDefinition.canonicalID(authSnapshot.provider)] = authSnapshot
            }
            sharedCloudAgents = shared
            hiddenCloudSessionIds = Set(visibility.hiddenSessionIds.compactMap(\.nonEmpty))
            deletedCloudSessionIds = Set(visibility.deletedSessionIds.compactMap(\.nonEmpty))
            for message in latestCanonical { mergeCloudMessage(message, peerHint: nil) }
            let peerAccountIds = Set(
                [account.accountId]
                + contactList.map(\.accountId)
                + owned.map(\.ownerAccountId)
                + shared.map(\.ownerAccountId)
            )
            let history = await loadMessageHistories(token: token, peerAccountIds: peerAccountIds)
            applySyncedSessionTitles(await api.cachedChatSessionTitles())
            let canonicalGroupSessionIds = await api.cachedChatConversations()
                .filter { $0.kind == "group" && $0.latestMessageSequence > 0 }
                .compactMap { $0.legacySessionId?.nonEmpty ?? $0.id.nonEmpty }
            let groupHistoryComplete = await loadCanonicalGroupHistories(
                token: token,
                sessionIds: canonicalGroupSessionIds
            )
            let groupParticipantIds = Set(cloudMessagesByPeer.values.flatMap { messages in
                messages.flatMap { CloudGroupMessageCodec.parse($0.body)?.participants.map(\.accountId) ?? [] }
            })
            let alreadyLoadedOwners = Set(shared.map(\.ownerAccountId))
            let additionalOwners = groupParticipantIds
                .subtracting(alreadyLoadedOwners)
                .subtracting([account.accountId])
            if !additionalOwners.isEmpty {
                let additional = try await api.listSharedAgents(
                    token: token,
                    ownerAccountIds: Array(additionalOwners)
                )
                var byId = Dictionary(uniqueKeysWithValues: shared.map { ($0.agentId, $0) })
                additional.forEach { byId[$0.agentId] = $0 }
                shared = Array(byId.values)
                sharedCloudAgents = shared
            }
            mergeMessageHistories(history.messagesByPeer)
            await rebuildConversationCatalog()
            cloudConnectionState = .connected
            messageSyncState = history.complete
                && groupHistoryComplete
                ? (hasHydratedWireSnapshot ? .upToDate : .syncing)
                : .offline
            if history.complete && groupHistoryComplete && hasHydratedWireSnapshot {
                lastMessageSyncAt = Date()
            }
            await persistCloudSnapshot(accountId: account.accountId)
            errorMessage = nil
        } catch {
            if CloudTransportErrorPolicy.isCancellation(error) || Task.isCancelled { return }
            recordCloudConnectionFailure(error)
            messageSyncState = .offline
            errorMessage = userFacing(error, fallback: "Could not refresh conversations.")
        }
    }

    func refreshContactRequests() async {
        guard let token else { return }
        do {
            let requests = try await api.listContactRequests(token: token)
            guard token == self.token else { return }
            contactRequests = requests
        } catch {
            // The chat sync loop retries this best-effort inbox refresh. User-triggered
            // contact actions continue to surface their own actionable errors.
        }
    }

    func appDidBecomeActive() async {
        guard phase == .signedIn, !previewMode else { return }
        await refreshWorkspace()
        startCloudSync(resetCursor: CloudSyncRecoveryPolicy.requiresBootstrap(
            hasHydratedWireSnapshot: hasHydratedWireSnapshot,
            hasHydratedForkLineage: hasHydratedForkLineage
        ))
    }

    func updateProfile(displayName: String, avatarUrl: String?) async -> Bool {
        guard let token else { return false }
        let cleanName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else {
            errorMessage = "Enter a display name."
            return false
        }
        do {
            account = try await api.updateProfile(
                token: token,
                displayName: cleanName,
                avatarUrl: avatarUrl?.nonEmpty
            )
            errorMessage = nil
            await rebuildConversationCatalog()
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not update your profile.")
            return false
        }
    }

    func refreshDevices() async {
        if previewMode {
            deviceErrorMessage = nil
            return
        }
        guard let token, let account, !isRefreshingDevices else { return }
        isRefreshingDevices = true
        defer { isRefreshingDevices = false }
        do {
            let refreshed = try await api.listDevices(token: token)
            guard self.token == token, self.account?.accountId == account.accountId else { return }
            devices = refreshed
            currentDeviceId = refreshed.first(where: \.currentDevice)?.deviceId
            deviceReviewRequired = refreshed.contains { $0.needsReview && !$0.currentDevice }
            deviceErrorMessage = nil
        } catch {
            deviceErrorMessage = userFacing(error, fallback: "Could not load active devices.")
        }
    }

    func markDeviceReviewSeen() {
        deviceReviewRequired = false
    }

    func confirmDevice(_ device: CloudDeviceAuthorization) async -> Bool {
        guard let token else { return false }
        let operationKey = "confirm:\(device.deviceId)"
        let operationId = deviceOperationId(for: operationKey)
        deviceErrorMessage = nil
        do {
            _ = try await api.confirmDevice(
                token: token,
                deviceId: device.deviceId,
                clientOperationId: operationId
            )
            deviceOperationIds.removeValue(forKey: operationKey)
            await refreshDevices()
            return true
        } catch {
            deviceErrorMessage = userFacing(error, fallback: "Could not confirm this device.")
            return false
        }
    }

    func renameDevice(_ device: CloudDeviceAuthorization, displayName: String) async -> Bool {
        guard let token, device.currentDevice else { return false }
        let cleanName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, cleanName.count <= 80 else {
            deviceErrorMessage = "Enter a device name between 1 and 80 characters."
            return false
        }
        let operationKey = "rename:\(device.deviceId):\(cleanName)"
        let operationId = deviceOperationId(for: operationKey)
        deviceErrorMessage = nil
        do {
            _ = try await api.renameDevice(
                token: token,
                deviceId: device.deviceId,
                displayName: cleanName,
                clientOperationId: operationId
            )
            deviceOperationIds.removeValue(forKey: operationKey)
            await refreshDevices()
            return true
        } catch {
            deviceErrorMessage = userFacing(error, fallback: "Could not rename this device.")
            return false
        }
    }

    func revokeDevice(_ device: CloudDeviceAuthorization) async -> Bool {
        guard let token, !device.currentDevice else { return false }
        let operationKey = "revoke:\(device.deviceId)"
        let operationId = deviceOperationId(for: operationKey)
        let previous = devices
        devices.removeAll { $0.deviceId == device.deviceId }
        deviceErrorMessage = nil
        do {
            _ = try await api.revokeDevice(
                token: token,
                deviceId: device.deviceId,
                clientOperationId: operationId
            )
            deviceOperationIds.removeValue(forKey: operationKey)
            await refreshDevices()
            return true
        } catch {
            devices = previous
            deviceErrorMessage = userFacing(error, fallback: "Could not terminate this device.")
            return false
        }
    }

    func revokeOtherDevices() async -> Bool {
        guard let token else { return false }
        let operationKey = "revoke-others"
        let operationId = deviceOperationId(for: operationKey)
        let previous = devices
        devices.removeAll { !$0.currentDevice }
        deviceErrorMessage = nil
        do {
            _ = try await api.revokeOtherDevices(
                token: token,
                clientOperationId: operationId
            )
            deviceOperationIds.removeValue(forKey: operationKey)
            await refreshDevices()
            return true
        } catch {
            devices = previous
            deviceErrorMessage = userFacing(error, fallback: "Could not terminate other devices.")
            return false
        }
    }

    private func deviceOperationId(for key: String) -> String {
        if let existing = deviceOperationIds[key] { return existing }
        let created = UUID().uuidString.lowercased()
        deviceOperationIds[key] = created
        return created
    }

    func refreshProviderAuthentication() async {
        guard let token, !isRefreshingProviderAuthentication else { return }
        isRefreshingProviderAuthentication = true
        providerAuthenticationErrorMessage = nil
        defer { isRefreshingProviderAuthentication = false }

        do {
            // Treat one unfiltered request as the connectivity check. Provider-specific
            // lookups are best effort so one slow alias cannot invalidate every saved
            // access profile or turn an unrelated background error into a page error.
            let latestSnapshot = try await api.currentProviderAuthSnapshot(token: token)
            let queried = await withTaskGroup(
                of: (String, CloudProviderAuthSnapshot?, Bool).self,
                returning: [String: [(CloudProviderAuthSnapshot?, Bool)]].self
            ) { group in
                for definition in ProviderAuthenticationDefinition.all {
                    for queryProviderID in definition.queryProviderIDs {
                        group.addTask {
                            do {
                                let snapshot = try await self.api.currentProviderAuthSnapshot(
                                    token: token,
                                    provider: queryProviderID
                                )
                                return (definition.id, snapshot, true)
                            } catch {
                                return (definition.id, nil, false)
                            }
                        }
                    }
                }
                var results: [String: [(CloudProviderAuthSnapshot?, Bool)]] = [:]
                for await (providerID, snapshot, succeeded) in group {
                    results[providerID, default: []].append((snapshot, succeeded))
                }
                return results
            }

            var snapshots = providerAuthSnapshots
            for definition in ProviderAuthenticationDefinition.all {
                guard let results = queried[definition.id] else { continue }
                let successfulSnapshots = results.compactMap { result in
                    result.1 ? result.0 : nil
                }
                if let newest = successfulSnapshots.max(by: { $0.createdAt < $1.createdAt }) {
                    snapshots[definition.id] = newest
                } else if results.allSatisfy({ $0.1 }) {
                    snapshots[definition.id] = nil
                }
            }
            if let latestSnapshot {
                snapshots[ProviderAuthenticationDefinition.canonicalID(latestSnapshot.provider)] = latestSnapshot
            }
            providerAuthSnapshot = latestSnapshot
            providerAuthSnapshots = snapshots
            providerAuthenticationErrorMessage = nil
        } catch {
            providerAuthenticationErrorMessage = authenticationUserFacing(
                error,
                fallback: "Authentication could not be refreshed. Your saved access is unchanged."
            )
        }
    }

    func saveProviderAPIKey(
        provider: ProviderAuthenticationDefinition,
        apiKey: String
    ) async -> Bool {
        guard let token, provider.acceptsAPIKeyOnPhone else { return false }
        let cleanKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanKey.isEmpty else {
            providerAuthenticationErrorMessage = "Enter an API key."
            return false
        }
        var payload = ["apiKey": cleanKey]
        if let baseURL = provider.baseURL { payload["baseUrl"] = baseURL }
        if let defaultModel = provider.defaultModel { payload["model"] = defaultModel }
        do {
            let snapshot = try await api.publishProviderAuthSnapshot(
                token: token,
                provider: provider.id,
                authChoice: "ios-api-key",
                payload: payload
            )
            providerAuthSnapshot = snapshot
            providerAuthSnapshots[provider.id] = snapshot
            providerAuthenticationErrorMessage = nil
            return true
        } catch {
            providerAuthenticationErrorMessage = authenticationUserFacing(
                error,
                fallback: "Could not save \(provider.name) authentication."
            )
            return false
        }
    }

    func revokeProviderAuthentication(_ snapshot: CloudProviderAuthSnapshot) async -> Bool {
        guard let token else { return false }
        do {
            _ = try await api.revokeProviderAuthSnapshot(token: token, snapshotId: snapshot.snapshotId)
            let providerID = ProviderAuthenticationDefinition.canonicalID(snapshot.provider)
            if providerAuthSnapshots[providerID]?.snapshotId == snapshot.snapshotId {
                providerAuthSnapshots[providerID] = nil
            }
            if providerAuthSnapshot?.snapshotId == snapshot.snapshotId {
                providerAuthSnapshot = nil
            }
            await refreshProviderAuthentication()
            return true
        } catch {
            providerAuthenticationErrorMessage = authenticationUserFacing(
                error,
                fallback: "Could not remove provider authentication."
            )
            return false
        }
    }

    func authenticationSnapshot(for providerID: String) -> CloudProviderAuthSnapshot? {
        providerAuthSnapshots[ProviderAuthenticationDefinition.canonicalID(providerID)]
    }

    var hasConfiguredProviderAuthentication: Bool {
        !providerAuthSnapshots.isEmpty
    }

    func clearProviderAuthenticationError() {
        providerAuthenticationErrorMessage = nil
    }

    func appDidEnterBackground() {
        cloudSyncTask?.cancel()
        cloudSyncTask = nil
    }

    func hydrateCachedMessages(for conversation: ConversationSummary) {
        guard messagesByConversation[conversation.id] == nil else { return }
        let cached = cache?.loadMessages(conversationId: conversation.id) ?? []
        if !cached.isEmpty {
            messagesByConversation[conversation.id] = cached
        }
    }

    func prepareConversationForPresentation(_ conversation: ConversationSummary) {
        hydrateCachedMessages(for: conversation)
        let projected = projectedMessages(
            for: conversation,
            wireSnapshot: cloudMessagesByPeer,
            account: account
        )
        guard !projected.isEmpty else { return }
        let existing = messagesByConversation[conversation.id, default: []]
        var byID = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })
        projected.forEach { byID[$0.id] = $0 }
        let merged = byID.values.sorted {
            $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id)
        }
        guard merged != existing else { return }
        messagesByConversation[conversation.id] = merged
        cache?.saveMessages(merged, conversationId: conversation.id)
    }

    /// An explicitly read or actively presented session updates the local
    /// catalog before network work so list and parent-space badges react at once.
    func markConversationOpened(_ conversation: ConversationSummary) {
        guard let index = conversations.firstIndex(where: { $0.id == conversation.id }),
              conversations[index].unreadCount != 0 else { return }
        conversations[index].unreadCount = 0
        cache?.saveConversations(conversations)
    }

    func updateConversationReadPresentation(
        id: UUID,
        conversationID: String,
        isPresented: Bool,
        isAppForeground: Bool,
        isAtLatest: Bool
    ) {
        if isPresented {
            conversationReadPresentations[id] = ConversationReadPresentation(
                conversationID: conversationID,
                isPresented: true,
                isAppForeground: isAppForeground,
                isAtLatest: isAtLatest
            )
        } else {
            conversationReadPresentations[id] = nil
        }

        guard conversationReadPresentations.values.contains(where: {
            $0.conversationID == conversationID && $0.canMarkRead
        }), let conversation = conversations.first(where: { $0.id == conversationID }) else {
            return
        }
        markConversationOpened(conversation)
        Task { [weak self] in
            await self?.reconcileVisibleConversationReadState()
        }
    }

    func isConversationActivelyReadable(canonicalConversationID: String) -> Bool {
        guard let conversation = conversationForNotification(
            canonicalConversationID: canonicalConversationID
        ) else { return false }
        return conversationReadPresentations.values.contains {
            $0.conversationID == conversation.id && $0.canMarkRead
        }
    }

    func conversationForNotification(canonicalConversationID: String) -> ConversationSummary? {
        conversations.first { conversation in
            conversation.id == canonicalConversationID
                || conversation.sessionId == canonicalConversationID
                || canonicalConversationIDBySessionID[conversation.id] == canonicalConversationID
                || canonicalConversationIDBySessionID[conversation.sessionId] == canonicalConversationID
        }
    }

    func canRevealConversationImmediately(_ conversation: ConversationSummary) -> Bool {
        guard let messages = messagesByConversation[conversation.id], !messages.isEmpty else {
            return false
        }
        let presentationSnapshot = ConversationPresentationSnapshot(
            latestMessageID: messages.last?.id,
            lastActivityAt: conversation.lastActivityAt
        )
        let localTimelineCoversCatalogRevision = messages.last.map {
            $0.createdAt >= conversation.lastActivityAt
        } ?? false
        return localTimelineCoversCatalogRevision
            || settledConversationPresentations[conversation.id] == presentationSnapshot
    }

    func markConversationPresentationSettled(_ conversation: ConversationSummary) {
        settledConversationPresentations[conversation.id] = ConversationPresentationSnapshot(
            latestMessageID: messagesByConversation[conversation.id]?.last?.id,
            lastActivityAt: conversation.lastActivityAt
        )
    }

    private func projectedMessages(
        for conversation: ConversationSummary,
        wireSnapshot: [String: [CloudMessageDTO]],
        account: CloudAccount?
    ) -> [ChatMessage] {
        guard let account else { return [] }
        if conversation.kind == .group {
            let wireMessages = wireSnapshot.values.flatMap { $0 }.filter { wire in
                CloudGroupMessageCodec.parse(wire.body)?.groupId == conversation.sessionId
            }
            return Self.mapGroupMessages(
                wireMessages,
                conversation: conversation,
                ownAccountId: account.accountId
            )
        }
        let wireMessages = Self.directWireMessages(for: conversation, in: wireSnapshot)
        return CloudDirectMessageProjector.project(
            wireMessages,
            conversation: conversation,
            ownAccountId: account.accountId
        )
    }

    func loadConversation(_ conversation: ConversationSummary) async {
        beginConversationLoad(conversation.id)
        defer { endConversationLoad(conversation.id) }
        prepareConversationForPresentation(conversation)

        if previewMode {
            guard ProcessInfo.processInfo.arguments.contains("--preview-slow-session-load") else {
                return
            }
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
            return
        }

        guard let token, let account else { return }
        async let fetchedPin = try? api.sessionPin(token: token, sessionId: conversation.sessionId)
        do {
            let fetchedWireMessages = try await loadWireMessages(for: conversation, token: token)
            try Task.checkCancellation()
            let projection = await Task.detached(priority: .userInitiated) {
                let projectedMessages = conversation.kind == .group
                    ? Self.mapGroupMessages(
                        fetchedWireMessages,
                        conversation: conversation,
                        ownAccountId: account.accountId
                    )
                    : CloudDirectMessageProjector.project(
                        fetchedWireMessages.filter { message in
                            guard let sessionId = message.sessionId?.nonEmpty else {
                                return conversation.kind == .person
                            }
                            return sessionId == conversation.sessionId
                        },
                        conversation: conversation,
                        ownAccountId: account.accountId
                    )
                return projectedMessages
            }.value
            let remote = projection
            if messagesByConversation[conversation.id] != remote {
                messagesByConversation[conversation.id] = remote
                cache?.saveMessages(remote, conversationId: conversation.id)
            }
            if let requestId = pendingAgentRequestIds[conversation.id],
               remote.contains(where: { $0.author == .agent && $0.requestMessageId == requestId }) {
                completeAgentRequest(conversationId: conversation.id)
            }
            await rebuildConversationCatalog()
            if let pin = await fetchedPin {
                sessionPinsByID[conversation.sessionId] = pin
            }
            if errorMessage == Self.cloudUnavailableMessage {
                errorMessage = nil
            }
        } catch {
            if CloudTransportErrorPolicy.isCancellation(error) || Task.isCancelled { return }
            if let pin = await fetchedPin {
                sessionPinsByID[conversation.sessionId] = pin
            }
            recordCloudConnectionFailure(error)
        }
    }

    /// macOS treats an expanded participant space as the active group and
    /// clears unread state across its visible canonical sessions. Mirror that
    /// behavior locally first so badges react immediately, then persist the
    /// same session-scoped receipts to Cloud.
    func markGroupSpaceRead(_ space: GroupSpaceSummary) async {
        let conversationIds = Set(space.sessions.map(\.id))
        var changedUnreadState = false
        for index in conversations.indices
        where conversationIds.contains(conversations[index].id)
            && conversations[index].unreadCount != 0 {
            conversations[index].unreadCount = 0
            changedUnreadState = true
        }
        if changedUnreadState {
            cache?.saveConversations(conversations)
        }

        guard !previewMode, let token, let account else { return }
        let sessionIds = Set(space.sessions.map(\.sessionId).filter { !$0.isEmpty })
        guard !sessionIds.isEmpty else { return }

        let readAt = ISO8601DateFormatter().string(from: Date())
        let wireSnapshot = cloudMessagesByPeer
        let projected = await Task.detached(priority: .userInitiated) {
            CloudMessageStateProjector.markingIncomingRead(
                wireSnapshot,
                ownAccountId: account.accountId,
                scope: .sessions(sessionIds),
                readAt: readAt
            )
        }.value
        if projected != cloudMessagesByPeer {
            cloudMessagesByPeer = projected
            rebuildCloudMessageIndices()
            await rebuildConversationCatalog()
            await refreshLoadedConversationProjections()
            await persistCloudSnapshot(accountId: account.accountId)
        }

        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                for sessionId in sessionIds {
                    group.addTask { [api] in
                        try await api.markSessionMessagesRead(token: token, sessionId: sessionId)
                    }
                }
                try await group.waitForAll()
            }
            cloudConnectionState = .connected
        } catch {
            recordCloudConnectionFailure(error)
        }
    }

    func send(
        _ rawText: String,
        attachments: [PendingAttachment] = [],
        replyingTo replySource: MessageActionSource? = nil,
        mentioning mentionTarget: ComposerMentionTarget? = nil,
        messageAction actionOverride: MessageActionMetadata? = nil,
        agentContext: String? = nil,
        to conversation: ConversationSummary
    ) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty), let token, let account else { return }
        if let error = MemeAttachmentPolicy.draftError(for: attachments) {
            errorMessage = error
            return
        }
        let localId = "ios_\(UUID().uuidString.lowercased())"
        let messageAction = actionOverride ?? replySource.map(MessageActionMetadata.quote)
        let optimistic = ChatMessage(
            id: localId,
            conversationId: conversation.id,
            author: .me,
            authorName: "You",
            text: text,
            createdAt: Date(),
            deliveryState: .sending,
            errorMessage: nil,
            requestMessageId: nil,
            attachments: attachments.map(\.optimisticAttachment),
            replyToMessageId: messageAction?.replyToMessageId,
            messageAction: messageAction
        )
        if !attachments.isEmpty { pendingAttachmentDraftsByMessageId[localId] = attachments }
        if let replySource { pendingReplyByMessageId[localId] = replySource }
        if let messageAction { pendingMessageActionByMessageId[localId] = messageAction }
        if let mentionTarget { pendingMentionByMessageId[localId] = mentionTarget }
        if let agentContext = agentContext?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
            pendingAgentContextByMessageId[localId] = agentContext
        }
        messagesByConversation[conversation.id, default: []].append(optimistic)
        cacheCurrentMessages(conversation.id)
        updateConversationPreview(
            conversation.id,
            text: text.nonEmpty ?? attachmentSummary(attachments.count),
            date: optimistic.createdAt
        )

        do {
            let uploadedAttachments = try await uploadAttachments(attachments, token: token)
            if conversation.kind == .group {
                let sentRows = try await sendGroupMessage(
                    text: text,
                    localMessageId: localId,
                    conversation: conversation,
                    token: token,
                    account: account,
                    attachments: uploadedAttachments,
                    messageAction: messageAction,
                    mentionTarget: mentionTarget
                )
                sentRows.forEach { mergeCloudMessage($0, peerHint: nil) }
                replaceMessage(localId, with: ChatMessage(
                    id: localId,
                    conversationId: conversation.id,
                    author: .me,
                    authorName: "You",
                    text: text,
                    createdAt: optimistic.createdAt,
                    deliveryState: .delivered,
                    errorMessage: nil,
                    requestMessageId: nil,
                    readByCount: 0,
                    attachments: uploadedAttachments.map(\.chatAttachment),
                    replyToMessageId: messageAction?.replyToMessageId,
                    messageAction: messageAction
                ))
                clearPendingSendMetadata(localId)
                if mentionTarget?.kind == .agent {
                    await startAgentRun(
                        conversation: conversation,
                        requestMessageId: localId,
                        ownerAccountId: mentionTarget?.accountId ?? conversation.peerAccountId,
                        prompt: AgentPromptContext.compose(
                            userText: promptText(text, removing: mentionTarget),
                            referenceText: agentContext
                        ),
                        token: token,
                        account: account,
                        runtimeRoute: requestedRuntimeRoute(for: conversation)
                    )
                }
                return
            }
            let wireBody: String
            let routedAgent = mentionTarget?.kind == .agent ? mentionTarget : nil
            let routesToSupportAgent = conversation.representsKordiSupport
                && KordiSupportIdentity.isSystemAgentSession(conversation.sessionId)
            if conversation.kind == .agent || routedAgent != nil || messageAction != nil || routesToSupportAgent {
                wireBody = try CloudMessageCodec.encodeDirect(
                    text: text,
                    agentId: routedAgent?.agentId
                        ?? (routesToSupportAgent ? KordiSupportIdentity.agentId : conversation.agentId),
                    agentName: routedAgent?.displayName
                        ?? (routesToSupportAgent ? KordiSupportIdentity.displayName : conversation.agentDisplayName),
                    ownerAccountId: routedAgent?.accountId
                        ?? ((conversation.kind == .agent || routesToSupportAgent) ? conversation.peerAccountId : nil),
                    ownerName: routedAgent?.ownerName
                        ?? ((conversation.kind == .agent || routesToSupportAgent) ? conversation.ownerDisplayName : nil),
                    agentRuntimeRoute: requestedRuntimeRoute(for: conversation),
                    messageAction: messageAction
                )
            } else {
                wireBody = text
            }
            let sent = try await api.sendMessage(
                token: token,
                peerAccountId: conversation.peerAccountId,
                body: wireBody,
                sessionId: conversation.sessionId,
                clientMessageId: localId,
                attachments: uploadedAttachments
            )
            mergeCloudMessage(sent, peerHint: conversation.peerAccountId)
            replaceMessage(localId, with: mapMessage(sent, conversation: conversation, ownAccountId: account.accountId))
            cloudConnectionState = .connected
            clearPendingSendMetadata(localId)

            if conversation.kind == .agent || routedAgent != nil || routesToSupportAgent {
                await startAgentRun(
                    conversation: conversation,
                    requestMessageId: sent.messageId,
                    ownerAccountId: routedAgent?.accountId ?? conversation.peerAccountId,
                    prompt: AgentPromptContext.compose(
                        userText: promptText(text, removing: routedAgent),
                        referenceText: agentContext
                    ),
                    token: token,
                    account: account,
                    runtimeRoute: requestedRuntimeRoute(for: conversation)
                )
            }
        } catch {
            recordCloudConnectionFailure(error)
            markMessageFailed(localId, error: userFacing(error, fallback: "Message not sent."))
        }
    }

    func retry(_ message: ChatMessage, in conversation: ConversationSummary) async {
        let attachments = pendingAttachmentDraftsByMessageId[message.id] ?? []
        let reply = pendingReplyByMessageId[message.id]
        let messageAction = pendingMessageActionByMessageId[message.id]
        let mention = pendingMentionByMessageId[message.id]
        let agentContext = pendingAgentContextByMessageId[message.id]
        removeMessage(message.id, conversationId: conversation.id)
        clearPendingSendMetadata(message.id)
        await send(
            message.text,
            attachments: attachments,
            replyingTo: reply,
            mentioning: mention,
            messageAction: messageAction,
            agentContext: agentContext,
            to: conversation
        )
    }

    func forward(
        _ sourceMessages: [ChatMessage],
        caption: String,
        from sourceConversation: ConversationSummary,
        to destination: ConversationSummary
    ) async -> Bool {
        guard !sourceMessages.isEmpty else { return false }
        let cleanCaption = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        for (index, message) in sourceMessages.enumerated() {
            let source = message.forwardSource(sessionId: sourceConversation.sessionId)
            let fallback = message.text.nonEmpty ?? attachmentSummary(message.attachments.count)
            let text = sourceMessages.count == 1 && index == 0
                ? cleanCaption.nonEmpty ?? fallback
                : fallback
            guard let attachments = await forwardingAttachments(message.attachments) else {
                return false
            }
            await send(
                text,
                attachments: attachments,
                messageAction: .forward(source),
                to: destination
            )
            guard messagesByConversation[destination.id]?.last?.deliveryState != .failed else {
                return false
            }
        }
        return true
    }

    private func forwardingAttachments(_ attachments: [ChatAttachment]) async -> [PendingAttachment]? {
        guard !attachments.isEmpty else { return [] }
        var urls: [URL] = []
        urls.reserveCapacity(attachments.count)
        for attachment in attachments {
            guard let url = await prepareAttachmentForPresentation(attachment) else { return nil }
            urls.append(url)
        }
        do {
            let loaded = try await Task.detached(priority: .userInitiated) {
                try PendingAttachmentLoader.load(urls: urls)
            }.value
            return loaded.enumerated().map { index, pending in
                guard attachments.indices.contains(index) else { return pending }
                let source = attachments[index]
                var forwarded = pending
                forwarded.subtype = source.subtype
                forwarded.altText = source.altText
                forwarded.memeRightsConfirmed = source.subtype == .meme
                return forwarded
            }
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func pin(
        _ message: ChatMessage,
        in conversation: ConversationSummary,
        shared: Bool
    ) async -> Bool {
        guard let token else { return false }
        do {
            let pin = try await api.updateSessionPin(
                token: token,
                sessionId: conversation.sessionId,
                messageId: message.id,
                scope: shared ? "shared" : "private"
            )
            sessionPinsByID[conversation.sessionId] = pin
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not pin this message.")
            return false
        }
    }

    func unpin(_ message: ChatMessage, in conversation: ConversationSummary) async -> Bool {
        guard let token else { return false }
        let current = sessionPinsByID[conversation.sessionId]
        let scope = current?.privateMessageId == message.id ? "private" : "shared"
        do {
            let pin = try await api.updateSessionPin(
                token: token,
                sessionId: conversation.sessionId,
                messageId: nil,
                scope: scope
            )
            sessionPinsByID[conversation.sessionId] = pin
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not unpin this message.")
            return false
        }
    }

    func messages(for conversation: ConversationSummary) -> [ChatMessage] {
        messagesByConversation[conversation.id] ?? []
    }

    func activeCall(for conversation: ConversationSummary) -> CloudCall? {
        let canonicalID = canonicalConversationIDBySessionID[conversation.sessionId]
            ?? canonicalConversationIDBySessionID[conversation.id]
            ?? conversation.sessionId
        return callsByConversationID[canonicalID]
    }

    func conversation(for call: CloudCall) -> ConversationSummary? {
        conversations.first { conversation in
            canonicalConversationIDBySessionID[conversation.sessionId] == call.conversationId
                || canonicalConversationIDBySessionID[conversation.id] == call.conversationId
                || conversation.sessionId == call.conversationId
        }
    }

    func startCall(
        in conversation: ConversationSummary,
        kind: CloudCallKind
    ) async throws -> CloudCallSessionResponse {
        guard let token else {
            throw CloudAPIError(
                code: "invalid_session",
                message: "Sign in again before starting a call.",
                statusCode: 401
            )
        }
        let response = try await api.startCall(
            token: token,
            conversation: conversation,
            kind: kind
        )
        applyCallSnapshot(response.call)
        return response
    }

    func refreshActiveCall(in conversation: ConversationSummary) async {
        guard let token, !previewMode else { return }
        do {
            if let call = try await api.activeCall(token: token, conversation: conversation) {
                applyCallSnapshot(call)
            }
        } catch {
            recordCloudConnectionFailure(error)
        }
    }

    func joinCall(_ call: CloudCall) async throws -> CloudCallSessionResponse {
        guard let token else {
            throw CloudAPIError(
                code: "invalid_session",
                message: "Sign in again before joining the call.",
                statusCode: 401
            )
        }
        let response = try await api.joinCall(token: token, callId: call.id)
        applyCallSnapshot(response.call)
        return response
    }

    func inviteCallParticipants(_ call: CloudCall) async throws -> CloudCall {
        guard let token else {
            throw CloudAPIError(
                code: "invalid_session",
                message: "Sign in again before inviting participants.",
                statusCode: 401
            )
        }
        guard let updated = try await api.inviteCallParticipants(token: token, callId: call.id) else {
            throw CloudAPIError(
                code: "CALL_NOT_FOUND",
                message: "The meeting is no longer available.",
                statusCode: 404
            )
        }
        applyCallSnapshot(updated)
        return updated
    }

    func declineCall(_ call: CloudCall) async {
        guard let token, !previewMode else {
            callsByConversationID[call.conversationId] = nil
            return
        }
        do {
            if let updated = try await api.declineCall(token: token, callId: call.id) {
                applyCallSnapshot(updated)
            }
        } catch {
            errorMessage = userFacing(error, fallback: "Could not decline the call.")
        }
    }

    func leaveCall(_ call: CloudCall) async {
        guard let token, !previewMode else {
            callsByConversationID[call.conversationId] = nil
            return
        }
        do {
            if let updated = try await api.leaveCall(token: token, callId: call.id) {
                applyCallSnapshot(updated)
            }
        } catch {
            errorMessage = userFacing(error, fallback: "Could not leave the call.")
        }
    }

    func endCall(_ call: CloudCall) async {
        guard let token, !previewMode else {
            callsByConversationID[call.conversationId] = nil
            return
        }
        do {
            if let updated = try await api.endCall(token: token, callId: call.id) {
                applyCallSnapshot(updated)
            }
        } catch {
            errorMessage = userFacing(error, fallback: "Could not end the call.")
        }
    }

    func recordPreviewCallStarted(_ call: CloudCall, in conversation: ConversationSummary) {
        guard previewMode else { return }
        applyCallSnapshot(call)
        appendPreviewCallActivity(.started, call: call, conversation: conversation)
    }

    func recordPreviewCallEnded(_ call: CloudCall, in conversation: ConversationSummary) {
        guard previewMode else { return }
        callsByConversationID[call.conversationId] = nil
        appendPreviewCallActivity(.ended, call: call, conversation: conversation)
    }

    func registerVoIPPushToken(_ deviceToken: String) async {
        guard let token, !previewMode else { return }
        do {
#if DEBUG
            let environment = "development"
#else
            let environment = "production"
#endif
            try await api.registerVoIPPushToken(
                token: token,
                deviceToken: deviceToken,
                environment: environment
            )
        } catch {
            recordCloudConnectionFailure(error)
        }
    }

    func registerNotificationPushToken(
        _ deviceToken: String,
        messagesEnabled: Bool,
        soundEnabled: Bool,
        previewsEnabled: Bool,
        badgeEnabled: Bool
    ) async {
        guard let token, !previewMode else { return }
        do {
#if DEBUG
            let environment = "development"
#else
            let environment = "production"
#endif
            try await api.registerNotificationPushToken(
                token: token,
                deviceToken: deviceToken,
                environment: environment,
                messagesEnabled: messagesEnabled,
                soundEnabled: soundEnabled,
                previewsEnabled: previewsEnabled,
                badgeEnabled: badgeEnabled
            )
        } catch {
            recordCloudConnectionFailure(error)
        }
    }

    private func applyCallSnapshot(_ call: CloudCall) {
        latestCallSnapshot = call
        if call.state == .ended {
            callsByConversationID[call.conversationId] = nil
        } else {
            callsByConversationID[call.conversationId] = call
        }
    }

    func mentionTargets(for conversation: ConversationSummary) -> [ComposerMentionTarget] {
        guard let account else { return [] }
        var targets: [ComposerMentionTarget] = []
        let participantIds: Set<String>
        switch conversation.kind {
        case .group:
            participantIds = Set(conversation.groupParticipants.map(\.accountId))
            for participant in conversation.groupParticipants where participant.accountId != account.accountId {
                targets.append(ComposerMentionTarget(
                    id: "person:\(participant.accountId)",
                    displayName: participant.displayName.nonEmpty ?? "Participant",
                    kind: .person,
                    accountId: participant.accountId,
                    agentId: nil,
                    ownerName: participant.displayName,
                    avatarSource: participant.avatarUrl
                ))
            }
        case .person:
            participantIds = [account.accountId, conversation.peerAccountId]
        case .agent:
            participantIds = [conversation.peerAccountId]
        }

        let agentPool = ownedCloudAgents + sharedCloudAgents
        for agent in agentPool where participantIds.contains(agent.ownerAccountId) {
            targets.append(ComposerMentionTarget(
                id: "agent:\(agent.agentId)",
                displayName: agent.name,
                kind: .agent,
                accountId: agent.ownerAccountId,
                agentId: agent.agentId,
                ownerName: agent.ownerDisplayName ?? (agent.ownerAccountId == account.accountId ? account.preferredName : nil),
                avatarSource: agent.avatarUrl
            ))
        }

        var seen = Set<String>()
        return targets
            .filter { seen.insert($0.id).inserted }
            .sorted {
                if $0.kind != $1.kind { return $0.kind == .agent }
                return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
    }

    func prepareAttachmentForPresentation(_ attachment: ChatAttachment) async -> URL? {
        await prepareAttachment(attachment, allowsPreviewFallback: false)
    }

    func prepareAttachmentForSharing(_ attachment: ChatAttachment) async -> URL? {
        await prepareAttachment(attachment, allowsPreviewFallback: true)
    }

    func addAttachmentToExpressiveMediaLibrary(
        _ attachment: ChatAttachment
    ) async -> ExpressiveMediaLibraryKind? {
        guard let accountId = account?.accountId else { return nil }
        guard !attachment.attachmentId.hasPrefix("pending:") else {
            errorMessage = "Wait for this media to finish sending before adding it to your library."
            return nil
        }
        guard let kind = ExpressiveMediaLibraryKind.supportedKind(
            name: attachment.name,
            mimeType: attachment.mimeType
        ) else {
            errorMessage = ExpressiveMediaLibraryError.unsupportedFile.localizedDescription
            return nil
        }
        guard let sourceURL = await prepareAttachmentForPresentation(attachment) else { return nil }
        do {
            _ = try await expressiveMediaLibrary.add(
                accountId: accountId,
                fileAt: sourceURL,
                attachment: attachment
            )
            scheduleExpressiveMediaLibrarySync()
            return kind
        } catch {
            errorMessage = userFacing(error, fallback: "Could not add this media to \(kind.libraryName).")
            return nil
        }
    }

    func expressiveMediaLibraryEntries(
        kind: ExpressiveMediaLibraryKind
    ) async -> [ExpressiveMediaLibraryEntry] {
        guard let accountId = account?.accountId else { return [] }
        return await expressiveMediaLibrary.entries(accountId: accountId, kind: kind)
    }

    func synchronizeExpressiveMediaLibrary() async {
        if let expressiveMediaSyncTask {
            await expressiveMediaSyncTask.value
            return
        }
        guard let token, let accountId = account?.accountId else { return }
        let taskID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performExpressiveMediaLibrarySync(token: token, accountId: accountId)
        }
        expressiveMediaSyncTask = task
        expressiveMediaSyncTaskID = taskID
        await task.value
        if expressiveMediaSyncTaskID == taskID {
            expressiveMediaSyncTask = nil
            expressiveMediaSyncTaskID = nil
        }
    }

    func addExpressiveMediaFiles(
        _ urls: [URL],
        kind: ExpressiveMediaLibraryKind
    ) async -> Bool {
        guard let accountId = account?.accountId else { return false }
        do {
            for url in urls {
                _ = try await expressiveMediaLibrary.add(
                    accountId: accountId,
                    fileAt: url,
                    expectedKind: kind
                )
            }
            scheduleExpressiveMediaLibrarySync()
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not add this media to \(kind.libraryName).")
            return false
        }
    }

    func addExpressiveMediaAttachment(
        _ attachment: PendingAttachment,
        kind: ExpressiveMediaLibraryKind
    ) async -> Bool {
        guard let accountId = account?.accountId else { return false }
        do {
            _ = try await expressiveMediaLibrary.add(
                accountId: accountId,
                attachment: attachment,
                expectedKind: kind
            )
            scheduleExpressiveMediaLibrarySync()
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not add this media to \(kind.libraryName).")
            return false
        }
    }

    func pendingAttachment(
        for entry: ExpressiveMediaLibraryEntry
    ) async -> PendingAttachment? {
        guard let accountId = account?.accountId else { return nil }
        do {
            return try await expressiveMediaLibrary.pendingAttachment(
                accountId: accountId,
                for: entry.item
            )
        } catch {
            errorMessage = userFacing(error, fallback: "Could not open \(entry.item.name).")
            return nil
        }
    }

    private func scheduleExpressiveMediaLibrarySync() {
        guard expressiveMediaSyncTask == nil else { return }
        Task { [weak self] in
            await self?.synchronizeExpressiveMediaLibrary()
        }
    }

    private func performExpressiveMediaLibrarySync(token: String, accountId: String) async {
        let remoteItems: [CloudExpressiveMediaItem]
        do {
            remoteItems = try await api.listExpressiveMedia(token: token)
        } catch {
            return
        }
        guard !Task.isCancelled, account?.accountId == accountId else { return }

        var cloudByAttachmentId = Dictionary(
            uniqueKeysWithValues: remoteItems.map { ($0.attachmentId, $0) }
        )
        let localItems = await expressiveMediaLibrary.items(accountId: accountId)
        for local in localItems {
            guard !Task.isCancelled, account?.accountId == accountId else { return }
            do {
                if let attachmentId = local.attachmentId,
                   let cloudItem = cloudByAttachmentId[attachmentId] {
                    try await expressiveMediaLibrary.markSynced(
                        accountId: accountId,
                        itemId: local.id,
                        cloudItem: cloudItem
                    )
                    continue
                }

                let attachmentId: String
                if let existingAttachmentId = local.attachmentId {
                    attachmentId = existingAttachmentId
                } else {
                    let attachment = try await expressiveMediaLibrary.pendingAttachment(
                        accountId: accountId,
                        for: local
                    )
                    let uploaded = try await api.uploadAttachment(token: token, attachment: attachment)
                    attachmentId = uploaded.attachmentId
                    try await expressiveMediaLibrary.markUploaded(
                        accountId: accountId,
                        itemId: local.id,
                        attachmentId: attachmentId
                    )
                }
                let cloudItem = try await api.saveExpressiveMedia(
                    token: token,
                    attachmentId: attachmentId,
                    kind: local.kind,
                    name: local.name
                )
                cloudByAttachmentId[cloudItem.attachmentId] = cloudItem
                try await expressiveMediaLibrary.markSynced(
                    accountId: accountId,
                    itemId: local.id,
                    cloudItem: cloudItem
                )
            } catch {
                if CloudTransportErrorPolicy.isCancellation(error) || Task.isCancelled { return }
            }
        }

        let synchronizedLocalItems = await expressiveMediaLibrary.items(accountId: accountId)
        let localAttachmentIds = Set(synchronizedLocalItems.compactMap(\.attachmentId))
        for cloudItem in cloudByAttachmentId.values where !localAttachmentIds.contains(cloudItem.attachmentId) {
            guard !Task.isCancelled, account?.accountId == accountId else { return }
            do {
                let data = try await api.downloadAttachmentContent(
                    token: token,
                    attachmentId: cloudItem.attachmentId
                )
                try await expressiveMediaLibrary.importCloudItem(
                    accountId: accountId,
                    cloudItem: cloudItem,
                    data: data
                )
            } catch {
                if CloudTransportErrorPolicy.isCancellation(error) || Task.isCancelled { return }
            }
        }
    }

    private func prepareAttachment(
        _ attachment: ChatAttachment,
        allowsPreviewFallback: Bool
    ) async -> URL? {
        if let cached = await attachmentFileStore.cachedURL(for: attachment.attachmentId) { return cached }
        guard let token else {
            if allowsPreviewFallback,
               let fallback = await storeInlinePreview(for: attachment) {
                return fallback
            }
            errorMessage = AttachmentTransferError.missingSession.localizedDescription
            return nil
        }
        do {
            let data = try await api.downloadAttachmentContent(token: token, attachmentId: attachment.attachmentId)
            let url = try await attachmentFileStore.store(data, attachment: attachment)
            cloudConnectionState = .connected
            return url
        } catch {
            recordCloudConnectionFailure(error)
            if allowsPreviewFallback,
               let fallback = await storeInlinePreview(for: attachment) {
                return fallback
            }
            errorMessage = userFacing(error, fallback: "Could not download \(attachment.name).")
            return nil
        }
    }

    private func storeInlinePreview(for attachment: ChatAttachment) async -> URL? {
        guard let data = AttachmentPreviewDataURL.decode(attachment.previewURL),
              data.count <= PendingAttachmentLoader.maximumAttachmentBytes else { return nil }
        return try? await attachmentFileStore.store(data, attachment: attachment)
    }

    func markConversationRead(_ conversation: ConversationSummary) async {
        await loadConversation(conversation)
        guard let current = conversations.first(where: { $0.id == conversation.id }) else {
            return
        }
        _ = await applyConversationReadLocally(current)
        do {
            try await persistConversationRead(current)
            persistedVisibleReadMessageBySessionID[current.sessionId] =
                latestIncomingMessageID(for: current)
            cloudConnectionState = .connected
        } catch {
            recordCloudConnectionFailure(error)
        }
    }

    func loadSessionActivity(_ conversation: ConversationSummary) async {
        guard let token else { return }
        do {
            sessionActivityByID[conversation.sessionId] = try await api.sessionActivity(
                token: token,
                sessionId: conversation.sessionId
            )
        } catch {
            errorMessage = userFacing(error, fallback: "Could not load session activity.")
        }
    }

    func lookupContact(kordiId: String) async -> CloudPublicProfile? {
        guard let token else { return nil }
        let normalized = kordiId.filter(\.isNumber)
        guard normalized.count == 9 else {
            errorMessage = "Enter a nine-digit Kordi ID."
            return nil
        }
        do {
            return try await api.lookupProfile(token: token, kordiId: normalized)
        } catch {
            errorMessage = userFacing(error, fallback: "Could not find that Kordi ID.")
            return nil
        }
    }

    func sendContactRequest(to profile: CloudPublicProfile, message: String?) async -> Bool {
        guard let token else { return false }
        do {
            let request = try await api.sendContactRequest(
                token: token,
                peerAccountId: profile.accountId,
                message: message?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            )
            contactRequests.removeAll { $0.requestId == request.requestId }
            if request.status == "pending" { contactRequests.insert(request, at: 0) }
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not send contact request.")
            return false
        }
    }

    func acceptContactRequest(_ request: CloudContactRequest) async {
        guard request.isIncoming, let token else { return }
        do {
            _ = try await api.acceptContactRequest(token: token, requestId: request.requestId)
            contactRequests.removeAll { $0.requestId == request.requestId }
            await refreshWorkspace()
        } catch {
            errorMessage = userFacing(error, fallback: "Could not accept contact request.")
        }
    }

    func rejectContactRequest(_ request: CloudContactRequest) async {
        guard request.isIncoming, let token else { return }
        do {
            try await api.rejectContactRequest(token: token, requestId: request.requestId)
            contactRequests.removeAll { $0.requestId == request.requestId }
        } catch {
            errorMessage = userFacing(error, fallback: "Could not decline contact request.")
        }
    }

    func renameConversation(_ conversation: ConversationSummary, to title: String) async -> Bool {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty, let token, let account else { return false }
        sessionTitleOverrides[conversation.sessionId] = cleanTitle
        UserDefaults.standard.set(sessionTitleOverrides, forKey: "kordi.session-title-overrides")
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index].displayName = cleanTitle
        }
        do {
            let kind: String = conversation.kind == .group
                ? "group"
                : (conversation.peerAccountId == account.accountId ? "ai" : "direct")
            let members = conversation.kind == .group
                ? conversation.groupParticipants.map(\.accountId)
                : [conversation.peerAccountId]
            let synced = try await api.updateSessionTitle(
                token: token,
                sessionId: conversation.sessionId,
                title: cleanTitle,
                peerAccountId: conversation.peerAccountId,
                conversationKind: kind,
                memberAccountIds: members
            )
            sessionTitleOverrides[conversation.sessionId] = synced.title
            UserDefaults.standard.set(sessionTitleOverrides, forKey: "kordi.session-title-overrides")
            await rebuildConversationCatalog()
            return true
        } catch {
            errorMessage = "Renamed on this iPhone, but title sync failed. Try again when connected."
            return false
        }
    }

    func renameGroupSpace(_ space: GroupSpaceSummary, to title: String) async -> Bool {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty, let token, let account else { return false }
        do {
            for conversation in space.sessions {
                let participants = groupParticipantsIncludingSelf(conversation, account: account)
                try await sendGroupControl(
                    kind: "group-title-update",
                    conversation: conversation,
                    participants: participants,
                    groupTitle: cleanTitle,
                    targetAccountIds: Set(participants.map(\.accountId)).subtracting([account.accountId]),
                    token: token,
                    account: account
                )
            }
            cloudConnectionState = .connected
            await rebuildConversationCatalog()
            return true
        } catch {
            recordCloudConnectionFailure(error)
            errorMessage = userFacing(error, fallback: "Could not rename this group.")
            return false
        }
    }

    func inviteContacts(_ selectedContacts: [CloudContact], to space: GroupSpaceSummary) async -> Bool {
        guard !selectedContacts.isEmpty, let account else { return false }
        let addedParticipants = selectedContacts.map { contact in
            CloudGroupParticipant(
                accountId: contact.accountId,
                displayName: contact.preferredName,
                avatarUrl: contact.avatarUrl,
                role: "person"
            )
        }
        if previewMode {
            try? await Task.sleep(for: .milliseconds(300))
            return true
        }
        guard let token else { return false }
        do {
            for conversation in space.sessions {
                let existing = groupParticipantsIncludingSelf(conversation, account: account)
                let existingIDs = Set(existing.map(\.accountId))
                let trulyAdded = addedParticipants.filter { !existingIDs.contains($0.accountId) }
                guard !trulyAdded.isEmpty else { continue }

                var byAccountID = Dictionary(uniqueKeysWithValues: existing.map { ($0.accountId, $0) })
                trulyAdded.forEach { byAccountID[$0.accountId] = $0 }
                let updated = byAccountID.values.sorted { $0.accountId < $1.accountId }
                let addedIDs = Set(trulyAdded.map(\.accountId))
                let existingRecipients = existingIDs.subtracting([account.accountId])

                if !existingRecipients.isEmpty {
                    try await sendGroupControl(
                        kind: "group-update",
                        conversation: conversation,
                        participants: updated,
                        groupTitle: space.displayName,
                        targetAccountIds: existingRecipients,
                        token: token,
                        account: account
                    )
                }
                try await sendGroupControl(
                    kind: "group-invite",
                    conversation: conversation,
                    participants: updated,
                    groupTitle: space.displayName,
                    targetAccountIds: addedIDs,
                    token: token,
                    account: account
                )
            }
            cloudConnectionState = .connected
            await rebuildConversationCatalog()
            return true
        } catch {
            recordCloudConnectionFailure(error)
            errorMessage = userFacing(error, fallback: "Could not invite people to this group.")
            return false
        }
    }

    func createGroup(with selectedContacts: [CloudContact], title: String?) async -> ConversationSummary? {
        guard let token, let account else { return nil }

        var contactsByAccountID: [String: CloudContact] = [:]
        for contact in selectedContacts where contact.accountId != account.accountId {
            contactsByAccountID[contact.accountId] = contact
        }
        let contacts = contactsByAccountID.values.sorted {
            $0.preferredName.localizedCaseInsensitiveCompare($1.preferredName) == .orderedAscending
        }
        guard contacts.count >= 2 else {
            errorMessage = "Select at least two contacts to start a group."
            return nil
        }

        let sessionID = "session:group:\(UUID().uuidString.lowercased())"
        let enteredTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let groupTitle = enteredTitle ?? contacts.map(\.preferredName).joined(separator: ", ")
        let participants = [
            CloudGroupParticipant(
                accountId: account.accountId,
                displayName: account.preferredName,
                avatarUrl: account.avatarUrl,
                role: "self"
            )
        ] + contacts.map { contact in
            CloudGroupParticipant(
                accountId: contact.accountId,
                displayName: contact.preferredName,
                avatarUrl: contact.avatarUrl,
                role: "person"
            )
        }
        let provisional = ConversationSummary(
            id: "group:\(sessionID)",
            kind: .group,
            peerAccountId: contacts[0].accountId,
            agentId: nil,
            ownerDisplayName: groupTitle,
            displayName: groupTitle,
            lastMessage: "Group conversation",
            lastActivityAt: Date(),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: sessionID,
            groupSpaceId: sessionID,
            groupParticipants: participants,
            messageCount: 0
        )

        do {
            try await sendGroupControl(
                kind: "group-invite",
                conversation: provisional,
                participants: participants,
                groupTitle: groupTitle,
                targetAccountIds: Set(contacts.map(\.accountId)),
                token: token,
                account: account
            )
            cloudConnectionState = .connected
            await rebuildConversationCatalog()
            return conversations.first(where: { $0.sessionId == sessionID }) ?? provisional
        } catch {
            recordCloudConnectionFailure(error)
            errorMessage = userFacing(error, fallback: "Could not start this group.")
            return nil
        }
    }

    func deleteConversation(_ conversation: ConversationSummary) async -> Bool {
        guard let token else { return false }
        do {
            try await api.deleteSession(token: token, sessionId: conversation.sessionId)
            deletedCloudSessionIds.insert(conversation.sessionId)
            sessionTitleOverrides.removeValue(forKey: conversation.sessionId)
            UserDefaults.standard.set(sessionTitleOverrides, forKey: "kordi.session-title-overrides")
            conversations.removeAll { $0.sessionId == conversation.sessionId }
            messagesByConversation.removeValue(forKey: conversation.id)
            sessionActivityByID.removeValue(forKey: conversation.sessionId)
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not delete this session.")
            return false
        }
    }

    func ownedAgent(for conversation: ConversationSummary) -> CloudAgent? {
        guard let agentId = conversation.agentId else { return nil }
        return ownedCloudAgents.first { $0.agentId == agentId }
    }

    func runtimeRouting(for conversation: ConversationSummary) -> CloudModelRouting {
        if let ownedAgent = ownedAgent(for: conversation) {
            return ownedAgent.modelRouting
        }
        if conversation.kind == .agent,
           let agentId = conversation.agentId,
           let sharedAgent = sharedCloudAgents.first(where: { $0.agentId == agentId }) {
            return sharedAgent.modelRouting
        }
        return sessionRuntimeRouteStore.route(
            accountId: account?.accountId,
            sessionId: conversation.sessionId
        ) ?? .empty
    }

    func canChangeRuntimeRouting(for conversation: ConversationSummary) -> Bool {
        conversation.kind != .agent
            || conversation.agentId == nil
            || ownedAgent(for: conversation) != nil
    }

    func runtimeRoutingIsSessionScoped(for conversation: ConversationSummary) -> Bool {
        conversation.kind != .agent || conversation.agentId == nil
    }

    func updateRuntimeRouting(
        for conversation: ConversationSummary,
        model: String,
        thinking: String
    ) async -> Bool {
        if ownedAgent(for: conversation) != nil {
            return await updateAgentRouting(for: conversation, model: model, thinking: thinking)
        }
        guard canChangeRuntimeRouting(for: conversation) else { return false }

        var routing = runtimeRouting(for: conversation)
        routing.defaultModel = model.nonEmpty
        routing.thinking = thinking.nonEmpty
        if let auth = providerAuthSnapshot,
           model.hasPrefix("\(auth.provider)/") {
            routing.defaultAuthProvider = auth.provider
            routing.defaultAuthChoice = auth.authChoice
        }
        sessionRuntimeRouteStore.save(
            routing,
            accountId: account?.accountId,
            sessionId: conversation.sessionId
        )
        return true
    }

    var ownedAgents: [CloudAgent] { ownedCloudAgents }

    func refreshFactory() async {
        guard let token, !isRefreshingFactory else { return }
        isRefreshingFactory = true
        defer { isRefreshingFactory = false }
        do {
            let refreshed = try await api.listAgents(token: token)
            guard self.token == token else { return }
            ownedCloudAgents = refreshed
            await rebuildConversationCatalog()
            cloudConnectionState = .connected
            errorMessage = nil
        } catch {
            cloudConnectionState = .unavailable
            errorMessage = userFacing(error, fallback: "Could not sync Factory with Kordi Cloud.")
        }
    }

    func ownedAgent(id: String) -> CloudAgent? {
        ownedCloudAgents.first { $0.agentId == id }
    }

    func createAgent(_ draft: CloudAgentDraft) async -> CloudAgent? {
        guard let token, draft.isValid else { return nil }
        do {
            let created = try await api.createAgent(token: token, draft: draft)
            ownedCloudAgents.removeAll { $0.agentId == created.agentId }
            ownedCloudAgents.insert(created, at: 0)
            await rebuildConversationCatalog()
            errorMessage = nil
            return created
        } catch {
            errorMessage = userFacing(error, fallback: "Could not create this agent.")
            return nil
        }
    }

    func updateAgent(id: String, draft: CloudAgentDraft) async -> CloudAgent? {
        guard let token, draft.isValid else { return nil }
        do {
            let updated = try await api.updateAgent(token: token, agentId: id, draft: draft)
            if let index = ownedCloudAgents.firstIndex(where: { $0.agentId == updated.agentId }) {
                ownedCloudAgents[index] = updated
            } else {
                ownedCloudAgents.insert(updated, at: 0)
            }
            await rebuildConversationCatalog()
            errorMessage = nil
            return updated
        } catch {
            errorMessage = userFacing(error, fallback: "Could not save this agent.")
            return nil
        }
    }

    func archiveAgent(id: String) async -> Bool {
        guard let token else { return false }
        do {
            _ = try await api.archiveAgent(token: token, agentId: id)
            ownedCloudAgents.removeAll { $0.agentId == id }
            await rebuildConversationCatalog()
            errorMessage = nil
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not delete this agent.")
            return false
        }
    }

    func updateAgentRouting(
        for conversation: ConversationSummary,
        model: String,
        thinking: String
    ) async -> Bool {
        guard let agent = ownedAgent(for: conversation) else { return false }
        return await updateAgentRouting(agent: agent, model: model, thinking: thinking)
    }

    func updateAgentRouting(agent: CloudAgent, model: String, thinking: String) async -> Bool {
        guard let token else { return false }
        do {
            var routing = agent.modelRouting
            routing.defaultModel = model.nonEmpty
            routing.thinking = thinking.nonEmpty
            if let auth = providerAuthSnapshot,
               model.hasPrefix("\(auth.provider)/") {
                routing.defaultAuthProvider = auth.provider
                routing.defaultAuthChoice = auth.authChoice
            }
            let updated = try await api.updateAgentRouting(
                token: token,
                agentId: agent.agentId,
                routing: routing
            )
            if let index = ownedCloudAgents.firstIndex(where: { $0.agentId == updated.agentId }) {
                ownedCloudAgents[index] = updated
            }
            return true
        } catch {
            errorMessage = userFacing(error, fallback: "Could not update this agent's model.")
            return false
        }
    }

    func agentStatusText(for conversation: ConversationSummary) -> String {
        let activity = conversations.first(where: { $0.id == conversation.id })?.agentActivity ?? .ready
        guard activity == .replying, let location = agentExecutionLocation[conversation.id] else {
            return activity.label
        }
        return location.activeLabel
    }

    private func uploadAttachments(
        _ attachments: [PendingAttachment],
        token: String
    ) async throws -> [CloudMessageAttachment] {
        guard !attachments.isEmpty else { return [] }
        return try await withThrowingTaskGroup(of: (Int, CloudMessageAttachment).self) { group in
            for (index, attachment) in attachments.enumerated() {
                group.addTask { [api] in
                    (index, try await api.uploadAttachment(token: token, attachment: attachment))
                }
            }
            var uploaded: [(Int, CloudMessageAttachment)] = []
            for try await item in group { uploaded.append(item) }
            return uploaded.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    private func startAgentRun(
        conversation: ConversationSummary,
        requestMessageId: String,
        ownerAccountId: String,
        prompt: String,
        token: String,
        account: CloudAccount,
        runtimeRoute: CloudModelRouting?
    ) async {
        pendingAgentRequestIds[conversation.id] = requestMessageId
        setAgentActivity(.replying, conversationId: conversation.id)
        do {
            _ = try await api.claimAgentRun(
                token: token,
                requestMessageId: requestMessageId,
                sessionId: conversation.sessionId,
                ownerAccountId: ownerAccountId,
                requesterAccountId: account.accountId,
                prompt: prompt,
                runtimeRoute: runtimeRoute
            )
            agentExecutionLocation[conversation.id] = .cloud
            await pollForAgentReply(conversation, requestMessageId: requestMessageId)
        } catch let error as CloudAPIError where error.code == "owner_online" {
            let macLabel = ownerAccountId == account.accountId
                ? "your Mac"
                : "\(conversation.ownerDisplayName ?? "the owner")’s Mac"
            agentExecutionLocation[conversation.id] = .mac(label: macLabel)
            await pollForAgentReply(conversation, requestMessageId: requestMessageId)
        } catch {
            recordCloudConnectionFailure(error)
            setAgentActivity(.failed, conversationId: conversation.id)
            pendingAgentRequestIds[conversation.id] = nil
            errorMessage = userFacing(error, fallback: "The agent could not start. Try again.")
        }
    }

    private func promptText(_ text: String, removing target: ComposerMentionTarget?) -> String {
        guard let target else { return text.nonEmpty ?? "Please review the attached files." }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let mention = target.mentionText
        guard trimmed.lowercased().hasPrefix(mention.lowercased()) else {
            return trimmed.nonEmpty ?? "Please review the attached files."
        }
        let index = trimmed.index(trimmed.startIndex, offsetBy: min(mention.count, trimmed.count))
        return String(trimmed[index...]).trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? "Please review the attached files."
    }

    private func requestedRuntimeRoute(for conversation: ConversationSummary) -> CloudModelRouting? {
        guard canChangeRuntimeRouting(for: conversation) else { return nil }
        let route = runtimeRouting(for: conversation)
        guard route.defaultModel?.nonEmpty != nil || route.thinking?.nonEmpty != nil else { return nil }
        return route
    }

    private func attachmentSummary(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }

    private func clearPendingSendMetadata(_ messageId: String) {
        pendingAttachmentDraftsByMessageId[messageId] = nil
        pendingReplyByMessageId[messageId] = nil
        pendingMessageActionByMessageId[messageId] = nil
        pendingMentionByMessageId[messageId] = nil
        pendingAgentContextByMessageId[messageId] = nil
    }

    private func pollForAgentReply(_ conversation: ConversationSummary, requestMessageId: String) async {
        guard !previewMode else { return }
        for _ in 0..<30 {
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled { return }
            await loadConversation(conversation)
            if messages(for: conversation).contains(where: { $0.author == .agent && $0.requestMessageId == requestMessageId }) {
                completeAgentRequest(conversationId: conversation.id)
                return
            }
            if let token,
               let run = try? await api.lookupAgentRun(token: token, requestMessageId: requestMessageId),
               run.status == "failed" || run.status == "cancelled" {
                setAgentActivity(.failed, conversationId: conversation.id)
                pendingAgentRequestIds[conversation.id] = nil
                return
            }
        }
        // Cloud and Mac runs may legitimately exceed this foreground polling
        // window. Cursor sync keeps the request in Replying until a linked
        // response or an explicit terminal run state arrives.
    }

    private struct MessageHistoryLoadResult {
        let messagesByPeer: [String: [CloudMessageDTO]]
        let complete: Bool
    }

    private struct PeerHistoryPage {
        let peer: String
        let messages: [CloudMessageDTO]?
    }

    private func loadMessageHistories(
        token: String,
        peerAccountIds: Set<String>
    ) async -> MessageHistoryLoadResult {
        var discoveredPeerIds = Set(peerAccountIds.filter { !$0.isEmpty })
        var result: [String: [CloudMessageDTO]] = [:]
        var complete = true

        // Group envelopes can introduce participants who are not yet contacts.
        // Follow those edges until the account graph stops expanding.
        for _ in 0..<4 {
            let missing = discoveredPeerIds.filter { result[$0] == nil }
            if missing.isEmpty { break }
            let pages = await withTaskGroup(of: PeerHistoryPage.self) { group in
                for peer in missing {
                    group.addTask { [api] in
                        PeerHistoryPage(
                            peer: peer,
                            messages: try? await api.listMessages(token: token, peerAccountId: peer, limit: 500)
                        )
                    }
                }
                var values: [PeerHistoryPage] = []
                for await page in group { values.append(page) }
                return values
            }
            for page in pages {
                guard let fetched = page.messages else {
                    complete = false
                    result[page.peer] = cloudMessagesByPeer[page.peer, default: []]
                    continue
                }
                result[page.peer] = fetched
                for message in fetched {
                    guard let envelope = CloudGroupMessageCodec.parse(message.body) else { continue }
                    discoveredPeerIds.formUnion(envelope.participants.map(\.accountId).filter { !$0.isEmpty })
                }
            }
        }
        if discoveredPeerIds.contains(where: { result[$0] == nil }) { complete = false }
        return MessageHistoryLoadResult(messagesByPeer: result, complete: complete)
    }

    private func loadWireMessages(
        for conversation: ConversationSummary,
        token: String
    ) async throws -> [CloudMessageDTO] {
        let fetched = try await api.listConversationMessages(
            token: token,
            sessionId: conversation.sessionId
        )
        for message in fetched { mergeCloudMessage(message, peerHint: nil) }
        if conversation.kind == .group {
            fullyHydratedCanonicalGroupSessionIds.insert(conversation.sessionId)
        }
        return fetched
    }

    private struct CanonicalConversationHistoryPage {
        let sessionId: String
        let messages: [CloudMessageDTO]?
    }

    /// Group timelines contain durable membership/title controls beside real
    /// messages.  Loading every canonical page lets iOS count and present the
    /// same semantic session history as macOS instead of treating controls as
    /// user messages or stopping after an arbitrary raw-message limit.
    private func loadCanonicalGroupHistories(
        token: String,
        sessionIds: [String]
    ) async -> Bool {
        let uniqueSessionIds = Array(
            Set(sessionIds.filter { !$0.isEmpty })
                .subtracting(fullyHydratedCanonicalGroupSessionIds)
        ).sorted()
        guard !uniqueSessionIds.isEmpty else { return true }
        var complete = true
        let batchSize = 4
        for start in stride(from: 0, to: uniqueSessionIds.count, by: batchSize) {
            if Task.isCancelled { return false }
            let end = min(start + batchSize, uniqueSessionIds.count)
            let batch = uniqueSessionIds[start..<end]
            let pages = await withTaskGroup(of: CanonicalConversationHistoryPage.self) { group in
                for sessionId in batch {
                    group.addTask { [api] in
                        do {
                            return CanonicalConversationHistoryPage(
                                sessionId: sessionId,
                                messages: try await api.listConversationMessages(
                                    token: token,
                                    sessionId: sessionId
                                )
                            )
                        } catch {
                            return CanonicalConversationHistoryPage(
                                sessionId: sessionId,
                                messages: nil
                            )
                        }
                    }
                }
                var result: [CanonicalConversationHistoryPage] = []
                for await page in group { result.append(page) }
                return result
            }
            for page in pages {
                guard let messages = page.messages else {
                    complete = false
                    continue
                }
                for message in messages { mergeCloudMessage(message, peerHint: nil) }
                fullyHydratedCanonicalGroupSessionIds.insert(page.sessionId)
            }
        }
        return complete
    }

    private func sendGroupMessage(
        text: String,
        localMessageId: String,
        conversation: ConversationSummary,
        token: String,
        account: CloudAccount,
        attachments: [CloudMessageAttachment],
        messageAction: MessageActionMetadata?,
        mentionTarget: ComposerMentionTarget?
    ) async throws -> [CloudMessageDTO] {
        let participants = hydratedGroupParticipants(conversation, account: account)
        let recipients = Set(participants.map(\.accountId).filter { !$0.isEmpty && $0 != account.accountId })
        guard !recipients.isEmpty else {
            throw CloudAPIError(code: "group_has_no_recipients", message: "This group has no other participants.", statusCode: 0)
        }
        let actor = participants.first(where: { $0.accountId == account.accountId })!
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message",
            groupId: conversation.sessionId,
            groupSpaceId: conversation.groupSpaceId ?? conversation.sessionId,
            groupTitle: nil,
            createdByAccountId: account.accountId,
            actor: actor,
            participants: participants,
            message: CloudGroupMessagePayload(
                id: localMessageId,
                senderAccountId: account.accountId,
                text: text,
                createdAtMs: Date().timeIntervalSince1970 * 1_000,
                senderKind: "human",
                senderDisplayName: account.preferredName,
                deliveryState: "complete",
                replyToMessageId: messageAction?.replyToMessageId,
                requestId: nil,
                attachments: attachments,
                messageAction: messageAction,
                targetCloudAgentId: mentionTarget?.kind == .agent ? mentionTarget?.agentId : nil,
                targetCloudAgentName: mentionTarget?.kind == .agent ? mentionTarget?.displayName : nil,
                targetCloudAgentOwnerAccountId: mentionTarget?.kind == .agent ? mentionTarget?.accountId : nil,
                targetCloudAgentOwnerName: mentionTarget?.kind == .agent ? mentionTarget?.ownerName : nil,
                agentRuntimeRoute: requestedRuntimeRoute(for: conversation)
            )
        )
        let body = try CloudGroupMessageCodec.encode(envelope)
        let sent = try await api.sendMessage(
            token: token,
            peerAccountId: recipients.sorted()[0],
            body: body,
            sessionId: conversation.sessionId,
            clientMessageId: localMessageId,
            attachments: attachments,
            conversationKind: "group",
            memberAccountIds: participants.map(\.accountId)
        )
        return [sent]
    }

    private func groupParticipantsIncludingSelf(
        _ conversation: ConversationSummary,
        account: CloudAccount
    ) -> [CloudGroupParticipant] {
        hydratedGroupParticipants(conversation, account: account)
    }

    private func hydratedGroupParticipants(
        _ conversation: ConversationSummary,
        account: CloudAccount
    ) -> [CloudGroupParticipant] {
        var byAccountID = Dictionary(uniqueKeysWithValues: conversation.groupParticipants.map { ($0.accountId, $0) })
        for contact in contacts {
            guard let participant = byAccountID[contact.accountId] else { continue }
            byAccountID[contact.accountId] = CloudGroupParticipant(
                accountId: participant.accountId,
                displayName: contact.preferredName,
                avatarUrl: contact.avatarUrl?.nonEmpty ?? participant.avatarUrl,
                role: participant.role
            )
        }
        byAccountID[account.accountId] = CloudGroupParticipant(
            accountId: account.accountId,
            displayName: account.preferredName,
            avatarUrl: account.avatarUrl?.nonEmpty ?? byAccountID[account.accountId]?.avatarUrl,
            role: byAccountID[account.accountId]?.role.nonEmpty ?? "self"
        )
        return byAccountID.values.sorted { $0.accountId < $1.accountId }
    }

    private func sendGroupControl(
        kind: String,
        conversation: ConversationSummary,
        participants: [CloudGroupParticipant],
        groupTitle: String?,
        targetAccountIds: Set<String>,
        token: String,
        account: CloudAccount
    ) async throws {
        guard let actor = participants.first(where: { $0.accountId == account.accountId }) else { return }
        let envelope = CloudGroupControlEnvelope(
            kind: kind,
            groupId: conversation.sessionId,
            groupSpaceId: conversation.groupSpaceId ?? conversation.sessionId,
            groupTitle: groupTitle,
            createdByAccountId: account.accountId,
            actor: actor,
            participants: participants,
            message: nil
        )
        let body = try CloudGroupMessageCodec.encode(envelope)
        guard let recipient = targetAccountIds
            .filter({ !$0.isEmpty && $0 != account.accountId })
            .sorted()
            .first else { return }
        let sent = try await api.sendMessage(
            token: token,
            peerAccountId: recipient,
            body: body,
            sessionId: conversation.sessionId,
            clientMessageId: "\(kind):\(UUID().uuidString.lowercased())",
            conversationKind: "group",
            memberAccountIds: participants.map(\.accountId),
            sharedTitle: groupTitle
        )
        mergeMessages([sent], for: recipient)
    }

    private func mapMessage(_ message: CloudMessageDTO, conversation: ConversationSummary, ownAccountId: String) -> ChatMessage {
        let isAgentResponse = CloudMessageCodec.isAgentResponse(message.body)
        let responseRequestId = isAgentResponse ? CloudMessageCodec.agentResponseRequestId(message.body) : nil
        let author: MessageAuthor = isAgentResponse ? .agent : (message.fromAccountId == ownAccountId ? .me : .person)
        let state = CloudMessageStateProjector.deliveryState(for: message, ownAccountId: ownAccountId)
        return ChatMessage(
            id: message.messageId,
            conversationId: conversation.id,
            author: author,
            authorName: author == .me ? "You" : conversation.displayName,
            text: CloudMessageCodec.displayText(message.body),
            createdAt: parseCloudDate(message.createdAt),
            deliveryState: state,
            errorMessage: nil,
            requestMessageId: responseRequestId,
            attachments: message.attachments.map(\.chatAttachment),
            replyToMessageId: CloudMessageCodec.directEnvelope(message.body)?.messageAction?.replyToMessageId
                ?? responseRequestId,
            messageAction: CloudMessageCodec.directEnvelope(message.body)?.messageAction,
            messageKind: message.messageKind
        )
    }

    nonisolated private static func mapGroupMessages(
        _ messages: [CloudMessageDTO],
        conversation: ConversationSummary,
        ownAccountId: String
    ) -> [ChatMessage] {
        var rowsByMessageId: [String: [(CloudMessageDTO, CloudGroupMessagePayload)]] = [:]
        let participantNames = Dictionary(uniqueKeysWithValues: conversation.groupParticipants.map { ($0.accountId, $0.displayName) })
        for wire in messages {
            guard let envelope = CloudGroupMessageCodec.parse(wire.body),
                  envelope.kind == "group-message",
                  envelope.groupId == conversation.sessionId,
                  let payload = envelope.message else { continue }
            rowsByMessageId[payload.id, default: []].append((wire, payload))
        }
        let chatMessages = rowsByMessageId.compactMap { messageId, rows -> ChatMessage? in
            guard let (wire, payload) = rows.max(by: { $0.1.createdAtMs < $1.1.createdAtMs }) else { return nil }
            let author: MessageAuthor = payload.senderKind == "agent"
                ? .agent
                : payload.senderAccountId == ownAccountId ? .me : .person
            let delivery = author == .me
                ? CloudMessageStateProjector.groupDeliverySummary(
                    messageId: messageId,
                    messages: messages,
                    ownAccountId: ownAccountId
                )
                : nil
            return ChatMessage(
                id: messageId,
                conversationId: conversation.id,
                author: author,
                authorName: author == .me
                    ? "You"
                    : payload.senderDisplayName?.nonEmpty ?? participantNames[payload.senderAccountId] ?? "Participant",
                text: payload.text,
                createdAt: Date(timeIntervalSince1970: payload.createdAtMs / 1_000),
                deliveryState: delivery?.state ?? CloudMessageStateProjector.deliveryState(for: wire, ownAccountId: ownAccountId),
                errorMessage: nil,
                requestMessageId: payload.requestId,
                readByCount: delivery?.readByAccountIds.count,
                readByAccountIds: delivery?.readByAccountIds ?? [],
                attachments: (payload.attachments ?? wire.attachments).map(\.chatAttachment),
                replyToMessageId: payload.replyToMessageId ?? payload.messageAction?.replyToMessageId,
                messageAction: payload.messageAction
            )
        }
        let callMessages = Dictionary(
            grouping: messages.filter {
                ChatCallActivity(messageKind: $0.messageKind) != nil
                    && CloudMessageStateProjector.sessionKeys(for: $0).contains(conversation.sessionId)
            },
            by: \.messageId
        ).compactMap { messageId, rows -> ChatMessage? in
            guard let wire = rows.max(by: { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }) else {
                return nil
            }
            let author: MessageAuthor = wire.fromAccountId == ownAccountId ? .me : .person
            return ChatMessage(
                id: messageId,
                conversationId: conversation.id,
                author: author,
                authorName: author == .me
                    ? "You"
                    : participantNames[wire.fromAccountId] ?? "Participant",
                text: wire.body,
                createdAt: parseCloudDate(wire.createdAt),
                deliveryState: CloudMessageStateProjector.deliveryState(for: wire, ownAccountId: ownAccountId),
                errorMessage: nil,
                requestMessageId: nil,
                messageKind: wire.messageKind
            )
        }
        return (chatMessages + callMessages)
            .sorted { $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id) }
    }

    /// Mobile is a passive Cloud client, never an execution-capable device.
    /// HTTP cursor polling intentionally avoids presence-bearing WebSockets so
    /// an iPhone cannot block Cloud fallback by being mistaken for the owner's Mac.
    private func startCloudSync(resetCursor: Bool) {
        guard let token else { return }
        let isForkLineageReplay = resetCursor
        cloudSyncTask?.cancel()
        if resetCursor {
            cloudSyncCursor = "0"
            if messageSyncState != .syncing { messageSyncState = .syncing }
        }
        cloudSyncTask = Task { [weak self] in
            guard let self else { return }
            var hasUnpersistedChanges = resetCursor
            var nextCursor = cloudSyncCursor
            var pendingEvents: [CloudSyncEvent] = []
            var chatPollsUntilContactRefresh = 0
            while !Task.isCancelled {
                do {
                    let response = try await api.sync(token: token, cursor: nextCursor)
                    if cloudConnectionState != .connected {
                        cloudConnectionState = .connected
                        if errorMessage == Self.cloudUnavailableMessage {
                            errorMessage = nil
                        }
                    }
                    if !response.events.isEmpty {
                        hasUnpersistedChanges = true
                        pendingEvents.append(contentsOf: response.events)
                    }
                    nextCursor = response.cursor
                    if response.hasMore { continue }

                    cloudSyncCursor = nextCursor
                    if !pendingEvents.isEmpty {
                        applyCloudSyncEvents(pendingEvents)
                        let hasDirectoryChanges = pendingEvents.contains {
                            $0.eventType != "message.upsert" && $0.eventType != "message.read"
                        }
                        if hasDirectoryChanges { await refreshWorkspace(showSyncActivity: false) }
                        // Conversation snapshots are independently canonical.
                        // Always project them even when a best-effort directory
                        // refresh failed or was already in progress.
                        await rebuildConversationCatalog()
                        await refreshLoadedConversationProjections()
                        pendingEvents.removeAll(keepingCapacity: true)
                    }
                    hasHydratedWireSnapshot = true
                    if isForkLineageReplay { hasHydratedForkLineage = true }
                    if messageSyncState != .upToDate { messageSyncState = .upToDate }
                    if hasUnpersistedChanges, let accountId = account?.accountId {
                        lastMessageSyncAt = Date()
                        await persistCloudSnapshot(accountId: accountId)
                        hasUnpersistedChanges = false
                    }
                } catch {
                    if Task.isCancelled { return }
                    // No page has been committed yet. Retry from the last
                    // persisted cursor so a background transition cannot skip
                    // a partially received batch.
                    nextCursor = cloudSyncCursor
                    pendingEvents.removeAll(keepingCapacity: true)
                    recordCloudConnectionFailure(error)
                    // The next foreground poll retries. User-triggered actions
                    // still surface their own actionable network errors.
                }

                if chatPollsUntilContactRefresh == 0 {
                    await refreshContactRequests()
                    chatPollsUntilContactRefresh = 2
                } else {
                    chatPollsUntilContactRefresh -= 1
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func refreshLoadedConversationProjections() async {
        guard let account else { return }
        let loadedConversationIds = Set(messagesByConversation.keys)
        let loadedConversations = conversations.filter { loadedConversationIds.contains($0.id) }
        let wireSnapshot = cloudMessagesByPeer
        let projections = await Task.detached(priority: .utility) {
            Dictionary(uniqueKeysWithValues: loadedConversations.map { conversation in
                let projected: [ChatMessage]
                if conversation.kind == .group {
                    let wireMessages = wireSnapshot.values.flatMap { $0 }.filter { wire in
                        CloudGroupMessageCodec.parse(wire.body)?.groupId == conversation.sessionId
                    }
                    projected = Self.mapGroupMessages(
                        wireMessages,
                        conversation: conversation,
                        ownAccountId: account.accountId
                    )
                } else {
                    let wireMessages = Self.directWireMessages(for: conversation, in: wireSnapshot)
                    projected = CloudDirectMessageProjector.project(
                        wireMessages,
                        conversation: conversation,
                        ownAccountId: account.accountId
                    )
                }
                return (conversation.id, projected)
            })
        }.value
        for (conversationId, projected) in projections {
            guard messagesByConversation[conversationId] != projected else { continue }
            messagesByConversation[conversationId] = projected
            cacheCurrentMessages(conversationId)
        }
    }

    nonisolated private static func directWireMessages(
        for conversation: ConversationSummary,
        in snapshot: [String: [CloudMessageDTO]]
    ) -> [CloudMessageDTO] {
        let candidates = conversation.representsKordiSupport
            && KordiSupportIdentity.isSystemAgentSession(conversation.sessionId)
            ? snapshot.values.flatMap { $0 }
            : snapshot[conversation.peerAccountId, default: []]
        var byID: [String: CloudMessageDTO] = [:]
        for message in candidates {
            guard let sessionId = message.sessionId?.nonEmpty else {
                if conversation.kind == .person { byID[message.messageId] = message }
                continue
            }
            if sessionId == conversation.sessionId { byID[message.messageId] = message }
        }
        return byID.values.sorted {
            $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.messageId < $1.messageId)
        }
    }

    private func rebuildConversationCatalog() async {
        guard let account else { return }
        let canonicalConversations = await api.cachedChatConversations()
        canonicalConversationIDBySessionID = canonicalConversations.reduce(into: [:]) { result, item in
            result[item.id] = item.id
            if let sessionID = item.legacySessionId?.nonEmpty {
                result[sessionID] = item.id
            }
        }
        let canonicalParticipantsBySessionId = await api.cachedChatParticipantsBySessionId()
        let canonicalForksBySessionId = await api.cachedChatSessionForksById()
        for (sessionId, fork) in canonicalForksBySessionId {
            sessionForksById[sessionId] = fork
        }
        let contactSnapshot = contacts
        let ownedAgentSnapshot = ownedCloudAgents
        let sharedAgentSnapshot = sharedCloudAgents
        let wireSnapshot = cloudMessagesByPeer
        let forkSnapshot = sessionForksById
        let hiddenSnapshot = hiddenCloudSessionIds
        let deletedSnapshot = deletedCloudSessionIds
        let rebuilt = await Task.detached(priority: .userInitiated) {
            CloudConversationCatalog.build(
                account: account,
                contacts: contactSnapshot,
                ownedAgents: ownedAgentSnapshot,
                sharedAgents: sharedAgentSnapshot,
                messagesByPeer: wireSnapshot,
                canonicalConversations: canonicalConversations,
                canonicalParticipantsBySessionId: canonicalParticipantsBySessionId,
                sessionForksById: forkSnapshot,
                hiddenSessionIds: hiddenSnapshot,
                deletedSessionIds: deletedSnapshot
            )
        }.value
        guard self.account?.accountId == account.accountId else { return }
        let titled = rebuilt.map { conversation in
            guard let override = sessionTitleOverrides[conversation.sessionId]?.nonEmpty else { return conversation }
            var copy = conversation
            copy.displayName = override
            return copy
        }
        titled.forEach(prepareConversationForPresentation)
        if titled != conversations {
            conversations = titled
            cache?.saveConversations(titled)
        }
        await reconcileVisibleConversationReadState()
    }

    private func reconcileVisibleConversationReadState() async {
        let readableConversationIDs = Set(
            conversationReadPresentations.values
                .filter(\.canMarkRead)
                .map(\.conversationID)
        )
        guard !readableConversationIDs.isEmpty else { return }

        let readableConversations = conversations.filter {
            readableConversationIDs.contains($0.id)
        }
        for conversation in readableConversations {
            guard let latestIncomingMessageID =
                await applyConversationReadLocally(conversation) else {
                continue
            }
            scheduleConversationReadPersistence(
                conversation,
                latestIncomingMessageID: latestIncomingMessageID
            )
        }
    }

    @discardableResult
    private func applyConversationReadLocally(
        _ conversation: ConversationSummary
    ) async -> String? {
        guard let latestIncomingMessageID = latestIncomingMessageID(for: conversation) else {
            return nil
        }
        markConversationOpened(conversation)
        guard let account else { return nil }

        let readAt = ISO8601DateFormatter().string(from: Date())
        let projected = CloudMessageStateProjector.markingIncomingRead(
            cloudMessagesByPeer,
            ownAccountId: account.accountId,
            scope: readScope(for: conversation),
            readAt: readAt
        )
        if projected != cloudMessagesByPeer {
            cloudMessagesByPeer = projected
            rebuildCloudMessageIndices()
            await refreshLoadedConversationProjections()
            await persistCloudSnapshot(accountId: account.accountId)
        }
        return latestIncomingMessageID
    }

    private func latestIncomingMessageID(
        for conversation: ConversationSummary
    ) -> String? {
        messagesByConversation[conversation.id]?
            .last(where: { $0.author != .me })?
            .id
    }

    private func readScope(for conversation: ConversationSummary) -> CloudReadScope {
        let supportUsesCanonicalSession = conversation.representsKordiSupport
            && KordiSupportIdentity.isSystemAgentSession(conversation.sessionId)
        return conversation.kind == .person && !supportUsesCanonicalSession
            ? .peer(conversation.peerAccountId)
            : .session(conversation.sessionId)
    }

    private func persistConversationRead(
        _ conversation: ConversationSummary
    ) async throws {
        guard let token, !previewMode else { return }
        let supportUsesCanonicalSession = conversation.representsKordiSupport
            && KordiSupportIdentity.isSystemAgentSession(conversation.sessionId)
        if conversation.kind == .person && !supportUsesCanonicalSession {
            try await api.markMessagesRead(
                token: token,
                peerAccountId: conversation.peerAccountId
            )
        } else {
            try await api.markSessionMessagesRead(
                token: token,
                sessionId: conversation.sessionId
            )
        }
    }

    private func scheduleConversationReadPersistence(
        _ conversation: ConversationSummary,
        latestIncomingMessageID: String
    ) {
        guard !previewMode,
              token != nil,
              persistedVisibleReadMessageBySessionID[conversation.sessionId]
                != latestIncomingMessageID,
              pendingVisibleReadMessageBySessionID[conversation.sessionId] == nil else {
            return
        }
        pendingVisibleReadMessageBySessionID[conversation.sessionId] =
            latestIncomingMessageID

        Task { [weak self] in
            guard let self else { return }
            do {
                try await persistConversationRead(conversation)
                if pendingVisibleReadMessageBySessionID[conversation.sessionId]
                    == latestIncomingMessageID {
                    pendingVisibleReadMessageBySessionID[conversation.sessionId] = nil
                    persistedVisibleReadMessageBySessionID[conversation.sessionId] =
                        latestIncomingMessageID
                }
                cloudConnectionState = .connected
                await reconcileVisibleConversationReadState()
            } catch {
                if pendingVisibleReadMessageBySessionID[conversation.sessionId]
                    == latestIncomingMessageID {
                    pendingVisibleReadMessageBySessionID[conversation.sessionId] = nil
                }
                recordCloudConnectionFailure(error)
            }
        }
    }

    private func mergeMessageHistories(_ histories: [String: [CloudMessageDTO]]) {
        for (peer, messages) in histories { mergeMessages(messages, for: peer) }
    }

    private func mergeMessages(_ messages: [CloudMessageDTO], for peer: String) {
        guard !peer.isEmpty, !messages.isEmpty else { return }
        var existing = cloudMessagesByPeer[peer, default: []]
        var indices = cloudMessageIndicesByPeer[peer]
            ?? Dictionary(uniqueKeysWithValues: existing.enumerated().map { ($0.element.messageId, $0.offset) })
        var appended = false
        var changed = false

        for message in messages {
            if let index = indices[message.messageId] {
                guard existing[index] != message else { continue }
                existing[index] = message
                changed = true
            } else {
                indices[message.messageId] = existing.count
                existing.append(message)
                appended = true
                changed = true
            }
        }
        guard changed else {
            cloudMessageIndicesByPeer[peer] = indices
            return
        }
        if appended {
            existing.sort {
                $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.messageId < $1.messageId)
            }
            indices = Dictionary(uniqueKeysWithValues: existing.enumerated().map { ($0.element.messageId, $0.offset) })
        }
        cloudMessagesByPeer[peer] = existing
        cloudMessageIndicesByPeer[peer] = indices
    }

    private func rebuildCloudMessageIndices() {
        cloudMessageIndicesByPeer = cloudMessagesByPeer.mapValues { messages in
            Dictionary(uniqueKeysWithValues: messages.enumerated().map { ($0.element.messageId, $0.offset) })
        }
    }

    private func mergeCloudMessage(_ message: CloudMessageDTO, peerHint: String?) {
        guard let accountId = account?.accountId else { return }
        let peer = peerHint?.nonEmpty
            ?? (message.fromAccountId == accountId ? message.toAccountId : message.fromAccountId).nonEmpty
        guard let peer else { return }
        mergeMessages([message], for: peer)
    }

    private func applyCloudSyncEvents(_ events: [CloudSyncEvent]) {
        guard let accountId = account?.accountId else { return }
        var upsertsByPeer: [String: [CloudMessageDTO]] = [:]
        var readUpdatesByPeer: [String: [String: String]] = [:]
        var deviceListChanged = false

        for event in events {
            if ["call.created", "call.updated"].contains(event.eventType),
               let call = event.payload?.call {
                applyCallSnapshot(call)
                continue
            }
            if event.eventType.hasPrefix("device.") {
                deviceListChanged = true
                if event.eventType == "device.added",
                   let deviceId = event.payload?.deviceId,
                   deviceId != currentDeviceId {
                    deviceReviewRequired = true
                }
                continue
            }
            if event.eventType == "session.title.updated",
               let sessionTitle = event.payload?.sessionTitle {
                applySyncedSessionTitles([sessionTitle])
                continue
            }
            if event.eventType == "session-forked",
               let payload = event.payload,
               let forkSessionId = payload.forkSessionId?.nonEmpty,
               let parentSessionId = payload.parentSessionId?.nonEmpty,
               let createdByAccountId = payload.createdByAccountId?.nonEmpty {
                sessionForksById[forkSessionId] = CloudSessionForkSummary(
                    forkSessionId: forkSessionId,
                    parentSessionId: parentSessionId,
                    parentMessageId: payload.parentMessageId?.nonEmpty,
                    createdByAccountId: createdByAccountId,
                    createdAt: payload.createdAt?.nonEmpty ?? event.occurredAt
                )
                continue
            }
            if event.eventType == "message.upsert", let message = event.payload?.message {
                for sessionId in CloudMessageStateProjector.sessionKeys(for: message) {
                    hiddenCloudSessionIds.remove(sessionId)
                    deletedCloudSessionIds.remove(sessionId)
                }
                let peer = event.peerAccountId?.nonEmpty
                    ?? (message.fromAccountId == accountId ? message.toAccountId : message.fromAccountId).nonEmpty
                if let peer { upsertsByPeer[peer, default: []].append(message) }
                continue
            }
            if ["session.hidden", "session.unhidden", "session.deleted"].contains(event.eventType),
               let sessionId = event.payload?.sessionId?.nonEmpty ?? event.peerAccountId?.nonEmpty {
                switch event.eventType {
                case "session.hidden":
                    if !deletedCloudSessionIds.contains(sessionId) { hiddenCloudSessionIds.insert(sessionId) }
                case "session.unhidden":
                    hiddenCloudSessionIds.remove(sessionId)
                case "session.deleted":
                    hiddenCloudSessionIds.remove(sessionId)
                    deletedCloudSessionIds.insert(sessionId)
                    cloudMessagesByPeer = cloudMessagesByPeer.mapValues { messages in
                        messages.filter { !CloudMessageStateProjector.sessionKeys(for: $0).contains(sessionId) }
                    }
                    rebuildCloudMessageIndices()
                default:
                    break
                }
                continue
            }
            guard event.eventType == "message.read",
                  let peer = event.peerAccountId?.nonEmpty,
                  let readAt = event.payload?.readAt?.nonEmpty,
                  let ids = event.payload?.messageIds,
                  !ids.isEmpty else { continue }
            for id in ids { readUpdatesByPeer[peer, default: [:]][id] = readAt }
        }

        if deviceListChanged {
            Task { await refreshDevices() }
        }

        // Merge and sort once per peer. Replaying a large account used to sort
        // the growing history once per event, which made the UI feel blocked.
        for (peer, messages) in upsertsByPeer { mergeMessages(messages, for: peer) }
        for (peer, updates) in readUpdatesByPeer {
            guard var messages = cloudMessagesByPeer[peer] else { continue }
            let indices = cloudMessageIndicesByPeer[peer, default: [:]]
            var changed = false
            for (messageId, readAt) in updates {
                guard let index = indices[messageId] else { continue }
                let message = messages[index]
                guard message.readAt != readAt else { continue }
                messages[index] = CloudMessageDTO(
                    messageId: message.messageId,
                    fromAccountId: message.fromAccountId,
                    toAccountId: message.toAccountId,
                    body: message.body,
                    createdAt: message.createdAt,
                    deliveredAt: message.deliveredAt ?? readAt,
                    readAt: readAt,
                    direction: message.direction,
                    sessionId: message.sessionId,
                    attachments: message.attachments,
                    messageKind: message.messageKind
                )
                changed = true
            }
            if changed { cloudMessagesByPeer[peer] = messages }
        }
    }

    private func applySyncedSessionTitles(_ titles: [CloudSyncedSessionTitle]) {
        var changed = false
        for title in titles {
            if let value = title.title.nonEmpty {
                guard sessionTitleOverrides[title.sessionId] != value else { continue }
                sessionTitleOverrides[title.sessionId] = value
                changed = true
            } else if sessionTitleOverrides.removeValue(forKey: title.sessionId) != nil {
                changed = true
            }
        }
        if changed {
            UserDefaults.standard.set(sessionTitleOverrides, forKey: "kordi.session-title-overrides")
        }
    }

    private func persistCloudSnapshot(accountId: String) async {
        await wireCache.save(
            accountId: accountId,
            cursor: cloudSyncCursor,
            messagesByPeer: cloudMessagesByPeer,
            sessionForksById: hasHydratedForkLineage ? sessionForksById : nil
        )
    }

    private func setAgentActivity(_ activity: AgentActivity, conversationId: String) {
        agentRunState[conversationId] = activity
        if let index = conversations.firstIndex(where: { $0.id == conversationId }) {
            conversations[index].agentActivity = activity
        }
    }

    private func completeAgentRequest(conversationId: String) {
        pendingAgentRequestIds[conversationId] = nil
        setAgentActivity(.ready, conversationId: conversationId)
    }

    private func setUnreadCount(_ count: Int, conversationId: String) {
        if let index = conversations.firstIndex(where: { $0.id == conversationId }),
           conversations[index].unreadCount != count {
            conversations[index].unreadCount = count
        }
    }

    private func beginConversationLoad(_ conversationID: String) {
        conversationLoadCounts[conversationID, default: 0] += 1
        loadingConversationIDs.insert(conversationID)
    }

    private func endConversationLoad(_ conversationID: String) {
        let remainingCount = max(0, conversationLoadCounts[conversationID, default: 1] - 1)
        if remainingCount == 0 {
            conversationLoadCounts[conversationID] = nil
            loadingConversationIDs.remove(conversationID)
        } else {
            conversationLoadCounts[conversationID] = remainingCount
        }
    }

    private func updateConversationPreview(_ conversationId: String, text: String, date: Date) {
        if let index = conversations.firstIndex(where: { $0.id == conversationId }) {
            conversations[index].lastMessage = text
            conversations[index].lastActivityAt = date
        }
    }

    private func replaceMessage(_ id: String, with replacement: ChatMessage) {
        guard var messages = messagesByConversation[replacement.conversationId],
              let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index] = replacement
        messagesByConversation[replacement.conversationId] = messages
        cacheCurrentMessages(replacement.conversationId)
    }

    private func markMessageFailed(_ id: String, error: String) {
        for key in messagesByConversation.keys {
            guard var messages = messagesByConversation[key], let index = messages.firstIndex(where: { $0.id == id }) else { continue }
            messages[index].deliveryState = .failed
            messages[index].errorMessage = error
            messagesByConversation[key] = messages
            cacheCurrentMessages(key)
            return
        }
    }

    private func setMessageDeliveryState(
        _ id: String,
        conversationId: String,
        state: MessageDeliveryState
    ) {
        guard var messages = messagesByConversation[conversationId],
              let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].deliveryState = state
        messagesByConversation[conversationId] = messages
        cacheCurrentMessages(conversationId)
    }

    private func removeMessage(_ id: String, conversationId: String) {
        messagesByConversation[conversationId]?.removeAll { $0.id == id }
        cacheCurrentMessages(conversationId)
    }

    private func cacheCurrentMessages(_ conversationId: String) {
        cache?.saveMessages(messagesByConversation[conversationId] ?? [], conversationId: conversationId)
    }

    private func appendPreviewCallActivity(
        _ event: ChatCallActivityEvent,
        call: CloudCall,
        conversation: ConversationSummary
    ) {
        let id = "preview-call-\(call.id)"
        let isVoice = call.kind == .voice
        let noun = isVoice ? "voice call" : call.kind == .meeting ? "video chat" : "video call"
        let text: String
        if event == .started {
            text = "You started a \(noun)."
        } else {
            let startedAt = call.answeredAt.map(parseCloudDate) ?? parseCloudDate(call.createdAt)
            let duration = ChatCallActivityTimeline.durationString(
                from: startedAt,
                to: Date()
            )
            text = "The \(noun) ended. Duration \(duration)."
        }
        let createdAt = event == .started ? parseCloudDate(call.createdAt) : Date()
        if let index = messagesByConversation[conversation.id]?.firstIndex(where: { $0.id == id }) {
            messagesByConversation[conversation.id]?[index].text = text
            messagesByConversation[conversation.id]?[index].messageKind = ChatCallActivity.messageKind(
                for: event,
                callId: call.id
            )
            if let conversationIndex = conversations.firstIndex(where: { $0.id == conversation.id }) {
                conversations[conversationIndex].lastMessage = text
                conversations[conversationIndex].lastActivityAt = createdAt
            }
            return
        }
        let message = ChatMessage(
            id: id,
            conversationId: conversation.id,
            author: .me,
            authorName: "You",
            text: text,
            createdAt: createdAt,
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatCallActivity.messageKind(for: event, callId: call.id)
        )
        messagesByConversation[conversation.id, default: []].append(message)
        messagesByConversation[conversation.id]?.sort {
            $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id)
        }
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index].lastMessage = text
            conversations[index].lastActivityAt = createdAt
        }
    }

    private func installPreviewData() {
        let fixture = PreviewData.make()
        var previewRouting = CloudModelRouting.empty
        previewRouting.defaultModel = "codex/gpt-5.6-sol"
        previewRouting.defaultAuthProvider = "codex"
        previewRouting.defaultAuthChoice = "oauth"
        previewRouting.thinking = "medium"
        account = fixture.account
        contacts = fixture.contacts
        conversations = fixture.conversations
        messagesByConversation = fixture.messagesByConversation
        ownedCloudAgents = [
            CloudAgent(
                agentId: "cloud_agent_research",
                ownerAccountId: fixture.account.accountId,
                accessScope: "owner",
                status: "ready",
                name: "Research Agent",
                role: "assistant",
                description: "Plans and reviews product work.",
                updatedAt: ISO8601DateFormatter().string(from: Date()),
                ownerDisplayName: fixture.account.preferredName,
                modelRouting: previewRouting
            )
        ]
        providerAuthSnapshot = CloudProviderAuthSnapshot(
            snapshotId: "provider_auth_e96dde",
            provider: "openai-codex",
            authChoice: "oauth",
            createdAt: ISO8601DateFormatter().string(from: Date()),
            revokedAt: nil
        )
        providerAuthSnapshots["openai"] = providerAuthSnapshot
        let now = Date()
        let timestamp = ISO8601DateFormatter()
        devices = [
            CloudDeviceAuthorization(
                deviceId: "device_preview_iphone",
                displayName: "iPhone 17e",
                platform: "ios",
                osVersion: "iOS 27.0",
                appVersion: "0.0.1-beta.12",
                createdAt: timestamp.string(from: now.addingTimeInterval(-2_592_000)),
                lastActiveAt: timestamp.string(from: now),
                authorizationState: "authorized",
                currentDevice: true,
                sessionExpiresAt: timestamp.string(from: now.addingTimeInterval(2_592_000)),
                approximateLocation: "Riyadh, Saudi Arabia",
                syncStatus: CloudDeviceSyncStatus(
                    protocolVersion: 2,
                    lastAppliedSequence: 1_248,
                    lastSuccessfulCatchUpAt: timestamp.string(from: now.addingTimeInterval(-12))
                )
            ),
            CloudDeviceAuthorization(
                deviceId: "device_preview_mac",
                displayName: "MacBook Pro",
                platform: "macos",
                osVersion: "macOS 26.0",
                appVersion: "0.0.1-beta.12",
                createdAt: timestamp.string(from: now.addingTimeInterval(-7_776_000)),
                lastActiveAt: timestamp.string(from: now.addingTimeInterval(-540)),
                authorizationState: "authorized",
                currentDevice: false,
                sessionExpiresAt: timestamp.string(from: now.addingTimeInterval(2_592_000)),
                approximateLocation: "Riyadh, Saudi Arabia",
                syncStatus: CloudDeviceSyncStatus(
                    protocolVersion: 2,
                    lastAppliedSequence: 1_248,
                    lastSuccessfulCatchUpAt: timestamp.string(from: now.addingTimeInterval(-545))
                )
            )
        ]
        currentDeviceId = "device_preview_iphone"
        token = "preview-token"
        phase = .signedIn
        cloudConnectionState = .connected
        messageSyncState = ProcessInfo.processInfo.arguments.contains("--preview-syncing")
            ? .syncing
            : .upToDate
        lastMessageSyncAt = Date()
    }

    private func completeAuthentication(_ response: CloudAuthResponse) async throws {
        try keychain.saveToken(response.session.token)
        await api.activateAccount(response.account.accountId)
        token = response.session.token
        currentDeviceId = response.session.deviceId
        account = response.account
        devices = []
        deviceOperationIds = [:]
        deviceErrorMessage = nil
        deviceReviewRequired = false
        if let snapshot = await wireCache.load(accountId: response.account.accountId) {
            cloudMessagesByPeer = snapshot.messagesByPeer
            sessionForksById = snapshot.sessionForksById ?? [:]
            rebuildCloudMessageIndices()
            cloudSyncCursor = snapshot.cursor
            lastMessageSyncAt = snapshot.savedAt
            hasHydratedWireSnapshot = snapshot.cursor != "0"
            hasHydratedForkLineage = snapshot.sessionForksById != nil
                && snapshot.forkLineageVersion == CloudWireSnapshot.currentForkLineageVersion
        }
        phase = .signedIn
        startCloudSync(resetCursor: CloudSyncRecoveryPolicy.requiresBootstrap(
            hasHydratedWireSnapshot: hasHydratedWireSnapshot,
            hasHydratedForkLineage: hasHydratedForkLineage
        ))
        scheduleExpressiveMediaLibrarySync()
        await refreshWorkspace()
    }

    private func userFacing(_ error: Error, fallback: String) -> String {
        if let error = error as? CloudAPIError {
            switch error.code {
            case "invalid_email": return "That email address looks malformed."
            case "weak_password": return "Password must be at least 8 characters."
            case "email_in_use": return "An account with that email already exists. Try logging in instead."
            case "invalid_credentials": return "Email or password is incorrect."
            case "rate_limited": return "Too many attempts. Wait a moment, then try again."
            case "invalid_session", "account_missing": return "Your session expired. Sign in again."
            case "network_error": return "Kordi Cloud is unavailable. Check your connection and try again."
            case "invalid_redirect": return "This Kordi build is not yet allowed to finish social sign-in."
            case "oauth_not_configured": return "This sign-in provider is temporarily unavailable."
            default: return error.message.nonEmpty ?? fallback
            }
        }
        return error.localizedDescription.nonEmpty ?? fallback
    }

    private func authenticationUserFacing(_ error: Error, fallback: String) -> String {
        guard let error = error as? CloudAPIError else {
            return fallback
        }
        switch error.code {
        case "invalid_session", "account_missing":
            return "Your session expired. Sign in again before changing authentication."
        case "network_error":
            return "Authentication could not be refreshed. Check your connection and try again; saved access is unchanged."
        default:
            return error.message.nonEmpty ?? fallback
        }
    }

    private func recordCloudConnectionFailure(_ error: Error) {
        guard let error = error as? CloudAPIError,
              error.code == "network_error" || error.statusCode >= 500 else { return }
        if cloudConnectionState != .unavailable { cloudConnectionState = .unavailable }
        if messageSyncState != .offline { messageSyncState = .offline }
    }
}
