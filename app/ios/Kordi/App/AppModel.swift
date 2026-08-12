import Foundation
import SwiftUI

enum AppPhase: Equatable {
    case launching
    case signedOut
    case signedIn
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

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var phase: AppPhase = .launching
    @Published private(set) var account: CloudAccount?
    @Published private(set) var contacts: [CloudContact] = []
    @Published private(set) var contactRequests: [CloudContactRequest] = []
    @Published private(set) var conversations: [ConversationSummary] = []
    @Published private(set) var messagesByConversation: [String: [ChatMessage]] = [:]
    @Published private(set) var sessionActivityByID: [String: CloudSessionActivity] = [:]
    @Published private(set) var sessionPinsByID: [String: CloudSessionPin] = [:]
    @Published private(set) var providerAuthSnapshot: CloudProviderAuthSnapshot?
    @Published private(set) var providerAuthSnapshots: [String: CloudProviderAuthSnapshot] = [:]
    @Published private(set) var isRefreshingProviderAuthentication = false
    @Published private(set) var isRefreshingFactory = false
    @Published private(set) var providerAuthenticationErrorMessage: String?
    @Published private(set) var isRefreshing = false
    @Published private(set) var agentRunState: [String: AgentActivity] = [:]
    @Published private(set) var agentExecutionLocation: [String: AgentExecutionLocation] = [:]
    @Published private(set) var cloudConnectionState: CloudConnectionState = .connecting
    @Published private(set) var messageSyncState: MessageSyncState = .syncing
    @Published private(set) var lastMessageSyncAt: Date?
    @Published var errorMessage: String?

    private let api: CloudAPIClient
    private let oauth: CloudOAuthSession
    private let keychain: KeychainSessionStore
    private let cache: LocalMessageStore?
    private let wireCache: CloudWireCache
    private let sessionRuntimeRouteStore: SessionRuntimeRouteStore
    private let attachmentFileStore = AttachmentFileStore()
    private var token: String?
    private var cloudSyncTask: Task<Void, Never>?
    private var cloudSyncCursor = "0"
    private var hasHydratedWireSnapshot = false
    private var hasHydratedForkLineage = false
    private var cloudMessagesByPeer: [String: [CloudMessageDTO]] = [:]
    private var cloudMessageIndicesByPeer: [String: [String: Int]] = [:]
    private var sessionForksById: [String: CloudSessionForkSummary] = [:]
    @Published private var ownedCloudAgents: [CloudAgent] = []
    private var sharedCloudAgents: [CloudAgent] = []
    private var hiddenCloudSessionIds = Set<String>()
    private var deletedCloudSessionIds = Set<String>()
    private var pendingAgentRequestIds: [String: String] = [:]
    private var pendingAttachmentDraftsByMessageId: [String: [PendingAttachment]] = [:]
    private var pendingReplyByMessageId: [String: MessageActionSource] = [:]
    private var pendingMessageActionByMessageId: [String: MessageActionMetadata] = [:]
    private var pendingMentionByMessageId: [String: ComposerMentionTarget] = [:]
    private var sessionTitleOverrides: [String: String] = UserDefaults.standard.dictionary(forKey: "kordi.session-title-overrides") as? [String: String] ?? [:]
    private let previewMode: Bool

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
            || ProcessInfo.processInfo.arguments.contains("--preview-authentication")
            || ProcessInfo.processInfo.arguments.contains("--preview-authentication-detail")
            || ProcessInfo.processInfo.arguments.contains("--preview-new-chat")
            || ProcessInfo.processInfo.arguments.contains("--preview-add-contact")
            || ProcessInfo.processInfo.arguments.contains("--preview-contact-chat")
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
            phase = .signedIn
            await refreshWorkspace()
            startCloudSync(resetCursor: CloudSyncRecoveryPolicy.requiresBootstrap(
                hasHydratedWireSnapshot: hasHydratedWireSnapshot,
                hasHydratedForkLineage: hasHydratedForkLineage
            ))
        } catch {
            try? keychain.deleteToken()
            token = nil
            account = nil
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
        cloudSyncCursor = "0"
        hasHydratedWireSnapshot = false
        hasHydratedForkLineage = false
        cloudConnectionState = .connecting
        messageSyncState = .syncing
        token = nil
        account = nil
        contacts = []
        contactRequests = []
        conversations = []
        messagesByConversation = [:]
        sessionActivityByID = [:]
        sessionPinsByID = [:]
        providerAuthSnapshot = nil
        providerAuthSnapshots = [:]
        cloudMessagesByPeer = [:]
        cloudMessageIndicesByPeer = [:]
        sessionForksById = [:]
        ownedCloudAgents = []
        sharedCloudAgents = []
        hiddenCloudSessionIds = []
        deletedCloudSessionIds = []
        agentRunState = [:]
        agentExecutionLocation = [:]
        pendingAgentRequestIds = [:]
        pendingAttachmentDraftsByMessageId = [:]
        pendingReplyByMessageId = [:]
        pendingMessageActionByMessageId = [:]
        pendingMentionByMessageId = [:]
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
            let (contactList, requests, owned, visibility, authSnapshot) = try await (
                fetchedContacts, fetchedRequests, ownedAgents, fetchedVisibility, fetchedAuth
            )
            var shared = try await api.listSharedAgents(
                token: token,
                ownerAccountIds: contactList.map(\.accountId)
            )
            contacts = contactList.sorted { $0.preferredName.localizedCaseInsensitiveCompare($1.preferredName) == .orderedAscending }
            contactRequests = requests
            ownedCloudAgents = owned
            providerAuthSnapshot = authSnapshot
            if let authSnapshot {
                providerAuthSnapshots[ProviderAuthenticationDefinition.canonicalID(authSnapshot.provider)] = authSnapshot
            }
            sharedCloudAgents = shared
            hiddenCloudSessionIds = Set(visibility.hiddenSessionIds.compactMap(\.nonEmpty))
            deletedCloudSessionIds = Set(visibility.deletedSessionIds.compactMap(\.nonEmpty))
            let peerAccountIds = Set(
                [account.accountId]
                + contactList.map(\.accountId)
                + owned.map(\.ownerAccountId)
                + shared.map(\.ownerAccountId)
            )
            let history = await loadMessageHistories(token: token, peerAccountIds: peerAccountIds)
            applySyncedSessionTitles(await api.cachedChatSessionTitles())
            let groupParticipantIds = Set(history.messagesByPeer.values.flatMap { messages in
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
                ? (hasHydratedWireSnapshot ? .upToDate : .syncing)
                : .offline
            if history.complete && hasHydratedWireSnapshot { lastMessageSyncAt = Date() }
            await persistCloudSnapshot(accountId: account.accountId)
            errorMessage = nil
        } catch {
            recordCloudConnectionFailure(error)
            messageSyncState = .offline
            errorMessage = userFacing(error, fallback: "Could not refresh conversations.")
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

    func clearProviderAuthenticationError() {
        providerAuthenticationErrorMessage = nil
    }

    func appDidEnterBackground() {
        cloudSyncTask?.cancel()
        cloudSyncTask = nil
    }

    func loadConversation(_ conversation: ConversationSummary) async {
        guard let token, let account else { return }
        if messagesByConversation[conversation.id] == nil {
            let cached = cache?.loadMessages(conversationId: conversation.id) ?? []
            if !cached.isEmpty { messagesByConversation[conversation.id] = cached }
        }
        async let fetchedPin = try? api.sessionPin(token: token, sessionId: conversation.sessionId)
        do {
            let fetchedWireMessages = try await loadWireMessages(for: conversation, token: token, ownAccountId: account.accountId)
            let readScope: CloudReadScope = conversation.kind == .person
                ? .peer(conversation.peerAccountId)
                : .session(conversation.sessionId)
            let readAt = ISO8601DateFormatter().string(from: Date())
            let wireSnapshot = cloudMessagesByPeer
            let projection = await Task.detached(priority: .userInitiated) {
                let allProjected = CloudMessageStateProjector.markingIncomingRead(
                    wireSnapshot,
                    ownAccountId: account.accountId,
                    scope: readScope,
                    readAt: readAt
                )
                let visibleWire = CloudMessageStateProjector.markingIncomingRead(
                    ["visible": fetchedWireMessages],
                    ownAccountId: account.accountId,
                    scope: readScope,
                    readAt: readAt
                )["visible", default: fetchedWireMessages]
                let projectedMessages = conversation.kind == .group
                    ? Self.mapGroupMessages(
                        visibleWire,
                        conversation: conversation,
                        ownAccountId: account.accountId
                    )
                    : CloudDirectMessageProjector.project(
                        visibleWire.filter { message in
                            guard let sessionId = message.sessionId?.nonEmpty else {
                                return conversation.kind == .person
                            }
                            return sessionId == conversation.sessionId
                        },
                        conversation: conversation,
                        ownAccountId: account.accountId
                    )
                return (allProjected, projectedMessages)
            }.value
            cloudMessagesByPeer = projection.0
            rebuildCloudMessageIndices()
            let remote = projection.1
            if messagesByConversation[conversation.id] != remote {
                messagesByConversation[conversation.id] = remote
                cache?.saveMessages(remote, conversationId: conversation.id)
            }
            if let requestId = pendingAgentRequestIds[conversation.id],
               remote.contains(where: { $0.author == .agent && $0.requestMessageId == requestId }) {
                completeAgentRequest(conversationId: conversation.id)
            }
            do {
                if conversation.kind == .person {
                    try await api.markMessagesRead(token: token, peerAccountId: conversation.peerAccountId)
                } else {
                    try await api.markSessionMessagesRead(token: token, sessionId: conversation.sessionId)
                }
                cloudConnectionState = .connected
            } catch {
                recordCloudConnectionFailure(error)
            }
            await rebuildConversationCatalog()
            setUnreadCount(0, conversationId: conversation.id)
            if let pin = await fetchedPin {
                sessionPinsByID[conversation.sessionId] = pin
            }
        } catch {
            if let pin = await fetchedPin {
                sessionPinsByID[conversation.sessionId] = pin
            }
            recordCloudConnectionFailure(error)
            errorMessage = userFacing(error, fallback: "Could not load this conversation.")
        }
    }

    /// macOS treats an expanded participant space as the active group and
    /// clears unread state across its visible canonical sessions. Mirror that
    /// behavior locally first so badges react immediately, then persist the
    /// same session-scoped receipts to Cloud.
    func markGroupSpaceRead(_ space: GroupSpaceSummary) async {
        guard let token, let account else { return }
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
        to conversation: ConversationSummary
    ) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty), let token, let account else { return }
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
                        prompt: promptText(text, removing: mentionTarget),
                        token: token,
                        account: account,
                        runtimeRoute: requestedRuntimeRoute(for: conversation)
                    )
                }
                return
            }
            let wireBody: String
            let routedAgent = mentionTarget?.kind == .agent ? mentionTarget : nil
            if conversation.kind == .agent || routedAgent != nil || messageAction != nil {
                wireBody = try CloudMessageCodec.encodeDirect(
                    text: text,
                    agentId: routedAgent?.agentId ?? (conversation.kind == .agent ? conversation.agentId : nil),
                    agentName: routedAgent?.displayName ?? (conversation.kind == .agent ? conversation.agentDisplayName ?? conversation.displayName : nil),
                    ownerAccountId: routedAgent?.accountId ?? (conversation.kind == .agent ? conversation.peerAccountId : nil),
                    ownerName: routedAgent?.ownerName ?? (conversation.kind == .agent ? conversation.ownerDisplayName : nil),
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

            if conversation.kind == .agent || routedAgent != nil {
                await startAgentRun(
                    conversation: conversation,
                    requestMessageId: sent.messageId,
                    ownerAccountId: routedAgent?.accountId ?? conversation.peerAccountId,
                    prompt: promptText(text, removing: routedAgent),
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
        removeMessage(message.id, conversationId: conversation.id)
        clearPendingSendMetadata(message.id)
        await send(
            message.text,
            attachments: attachments,
            replyingTo: reply,
            mentioning: mention,
            messageAction: messageAction,
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
            return try await Task.detached(priority: .userInitiated) {
                try PendingAttachmentLoader.load(urls: urls)
            }.value
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
        if let cached = await attachmentFileStore.cachedURL(for: attachment.attachmentId) { return cached }
        guard let token else {
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
            errorMessage = userFacing(error, fallback: "Could not download \(attachment.name).")
            return nil
        }
    }

    func markConversationRead(_ conversation: ConversationSummary) async {
        await loadConversation(conversation)
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
        guard !selectedContacts.isEmpty, let token, let account else { return false }
        let addedParticipants = selectedContacts.map { contact in
            CloudGroupParticipant(
                accountId: contact.accountId,
                displayName: contact.preferredName,
                avatarUrl: contact.avatarUrl,
                role: "person"
            )
        }
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
        token: String,
        ownAccountId: String
    ) async throws -> [CloudMessageDTO] {
        if conversation.kind != .group {
            let fetched = try await api.listMessages(token: token, peerAccountId: conversation.peerAccountId, limit: 500)
            mergeMessages(fetched, for: conversation.peerAccountId)
            return cloudMessagesByPeer[conversation.peerAccountId, default: []]
        }
        let peers = Set(conversation.remotePeerAccountIds.filter { $0 != ownAccountId })
        try await withThrowingTaskGroup(of: (String, [CloudMessageDTO]).self) { group in
            for peer in peers {
                group.addTask { [api] in
                    (peer, try await api.listMessages(token: token, peerAccountId: peer, limit: 500))
                }
            }
            for try await (peer, batch) in group { mergeMessages(batch, for: peer) }
        }
        let wireSnapshot = cloudMessagesByPeer
        return await Task.detached(priority: .userInitiated) {
            wireSnapshot.values.flatMap { $0 }.filter { wire in
                guard let envelope = CloudGroupMessageCodec.parse(wire.body) else { return false }
                return envelope.groupId == conversation.sessionId
            }
        }.value
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
            messageAction: CloudMessageCodec.directEnvelope(message.body)?.messageAction
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
        return rowsByMessageId.compactMap { messageId, rows -> ChatMessage? in
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
            while !Task.isCancelled {
                do {
                    let response = try await api.sync(token: token, cursor: nextCursor)
                    if cloudConnectionState != .connected { cloudConnectionState = .connected }
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
                    if cloudConnectionState != .connected { cloudConnectionState = .connected }
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
                try? await Task.sleep(for: .seconds(5))
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
                    let wireMessages = wireSnapshot[conversation.peerAccountId, default: []]
                        .filter { message in
                            guard let sessionId = message.sessionId?.nonEmpty else {
                                return conversation.kind == .person
                            }
                            return sessionId == conversation.sessionId
                        }
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

    private func rebuildConversationCatalog() async {
        guard let account else { return }
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
        guard titled != conversations else { return }
        conversations = titled
        cache?.saveConversations(titled)
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

        for event in events {
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
                    attachments: message.attachments
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
        token = response.session.token
        account = response.account
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
        await refreshWorkspace()
        startCloudSync(resetCursor: CloudSyncRecoveryPolicy.requiresBootstrap(
            hasHydratedWireSnapshot: hasHydratedWireSnapshot,
            hasHydratedForkLineage: hasHydratedForkLineage
        ))
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
