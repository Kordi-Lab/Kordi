import Foundation
import CryptoKit

struct CloudAPIError: LocalizedError, Equatable {
    let code: String
    let message: String
    let statusCode: Int

    var errorDescription: String? { message }
}

enum CloudTransportErrorPolicy {
    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError
            || (error as? URLError)?.code == .cancelled
            || ((error as NSError).domain == NSURLErrorDomain
                && (error as NSError).code == NSURLErrorCancelled)
    }
}

actor CloudAPIClient {
    static let productionBaseURL = URL(string: "https://kordi.ai")!

    static let productionSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 90
        return URLSession(configuration: configuration)
    }()

    static var configuredBaseURL: URL {
        guard let configured = Bundle.main.object(forInfoDictionaryKey: "KordiCloudBaseURL") as? String,
              !configured.contains("$("),
              let url = URL(string: configured.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https" else {
            return productionBaseURL
        }
        return url
    }

    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var activeAccountId: String?
    private var chatV2ConversationsById: [String: CloudChatV2Conversation] = [:]
    private var chatV2ConversationsBySessionId: [String: CloudChatV2Conversation] = [:]
    private var chatV2MessagesById: [String: CloudChatV2Message] = [:]
    private var chatV2BootstrapTask: Task<CloudChatV2BootstrapResponse, Error>?
    private var lastChatV2Bootstrap: CloudChatV2BootstrapResponse?

    init(baseURL: URL = configuredBaseURL, session: URLSession = productionSession) {
        precondition(baseURL.scheme == "https", "Kordi Cloud requires HTTPS")
        self.baseURL = baseURL
        self.session = session
    }

    func login(email: String, password: String) async throws -> CloudAuthResponse {
        let response: CloudAuthResponse = try await send(
            path: "/v1/cloud/auth/login",
            method: "POST",
            body: LoginRequest(email: email, password: password),
            fallback: "Could not sign in."
        )
        activateAccount(response.account.accountId)
        return response
    }

    func signup(
        email: String,
        password: String,
        displayName: String?,
        avatarUrl: String
    ) async throws -> CloudAuthResponse {
        let response: CloudAuthResponse = try await send(
            path: "/v1/cloud/auth/signup",
            method: "POST",
            body: SignupRequest(
                email: email,
                password: password,
                displayName: displayName,
                avatarUrl: avatarUrl
            ),
            fallback: "Could not create account."
        )
        activateAccount(response.account.accountId)
        return response
    }

    func startOAuth(provider: CloudOAuthProvider, redirectAfter: URL) async throws -> URL {
        let response: CloudOAuthStartResponse = try await send(
            path: "/v1/cloud/auth/oauth/\(provider.rawValue)/start",
            method: "GET",
            query: [URLQueryItem(name: "redirectAfter", value: redirectAfter.absoluteString)],
            fallback: "Could not start \(provider.displayName) sign-in."
        )
        guard let authURL = URL(string: response.authUrl),
              authURL.scheme == "https" else {
            throw CloudAPIError(
                code: "invalid_oauth_response",
                message: "Kordi Cloud returned an invalid sign-in address.",
                statusCode: 0
            )
        }
        return authURL
    }

    func me(token: String) async throws -> CloudAccount {
        let account: CloudAccount = try await send(
            path: "/v1/cloud/auth/me",
            method: "GET",
            token: token,
            fallback: "Could not restore your session."
        )
        activateAccount(account.accountId)
        return account
    }

    func updateProfile(
        token: String,
        displayName: String,
        avatarUrl: String?
    ) async throws -> CloudAccount {
        try await send(
            path: "/v1/cloud/auth/me",
            method: "PATCH",
            token: token,
            body: UpdateProfileRequest(displayName: displayName, avatarUrl: avatarUrl),
            fallback: "Could not update your profile."
        )
    }

    func logout(token: String) async throws {
        defer {
            activeAccountId = nil
            resetChatV2Cache()
        }
        try await sendWithoutResponse(path: "/v1/cloud/auth/logout", method: "POST", token: token, fallback: "Could not sign out.")
    }

    private func activateAccount(_ accountId: String) {
        if activeAccountId != accountId {
            resetChatV2Cache()
        }
        activeAccountId = accountId
    }

    private func resetChatV2Cache() {
        chatV2ConversationsById = [:]
        chatV2ConversationsBySessionId = [:]
        chatV2MessagesById = [:]
        lastChatV2Bootstrap = nil
        chatV2BootstrapTask?.cancel()
        chatV2BootstrapTask = nil
    }

    func listContacts(token: String) async throws -> [CloudContact] {
        let response: ContactsResponse = try await send(
            path: "/v1/cloud/contacts",
            method: "GET",
            token: token,
            fallback: "Could not load contacts."
        )
        return response.contacts
    }

    func cachedChatV2ParticipantsBySessionId() -> [String: [CloudGroupParticipant]] {
        var result: [String: [CloudGroupParticipant]] = [:]
        for conversation in chatV2ConversationsById.values where conversation.kind == "group" {
            let participants = conversation.members
                .filter { $0.membershipState == "active" }
                .map { member in
                    CloudGroupParticipant(
                        accountId: member.accountId,
                        displayName: member.displayName?.nonEmpty ?? "Kordi user",
                        avatarUrl: member.avatarUrl?.nonEmpty,
                        role: member.role.nonEmpty
                    )
                }
            result[conversation.id] = participants
            if let sessionId = conversation.legacySessionId?.nonEmpty {
                result[sessionId] = participants
            }
        }
        return result
    }

    func cachedChatV2SessionForksById() -> [String: CloudSessionForkSummary] {
        var result: [String: CloudSessionForkSummary] = [:]
        for conversation in chatV2ConversationsById.values {
            guard let forkSessionId = conversation.legacySessionId?.nonEmpty,
                  let parentSessionId = conversation.forkedFromSessionId?.nonEmpty else { continue }
            result[forkSessionId] = CloudSessionForkSummary(
                forkSessionId: forkSessionId,
                parentSessionId: parentSessionId,
                parentMessageId: conversation.forkedFromMessageId?.nonEmpty,
                createdByAccountId: conversation.createdByAccountId,
                createdAt: conversation.createdAt
            )
        }
        return result
    }

    func cachedChatV2Conversations() -> [CloudChatV2Conversation] {
        Array(chatV2ConversationsById.values)
    }

    /// Makes the canonical conversation directory available to the app model
    /// together with the newest item from every session.  The directory is
    /// authoritative even when the legacy peer-history projection is empty.
    func bootstrapChatV2LatestMessages(token: String) async throws -> [CloudMessageDTO] {
        let accountId = try requireActiveAccountId()
        let bootstrap = try await bootstrapChatV2(token: token)
        let conversationsById = Dictionary(
            uniqueKeysWithValues: bootstrap.conversations.map { ($0.id, $0) }
        )
        return bootstrap.latestMessages.compactMap { message in
            guard let conversation = conversationsById[message.conversationId] else { return nil }
            return legacyMessage(
                from: message,
                conversation: conversation,
                viewerAccountId: accountId
            )
        }
    }

    func listContactRequests(token: String) async throws -> [CloudContactRequest] {
        let response: ContactRequestsResponse = try await send(
            path: "/v1/cloud/contacts/requests",
            method: "GET",
            token: token,
            fallback: "Could not load contact requests."
        )
        return response.requests
    }

    func lookupProfile(token: String, kordiId: String) async throws -> CloudPublicProfile {
        try await send(
            path: "/v1/cloud/accounts/\(kordiId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? kordiId)/profile",
            method: "GET",
            token: token,
            fallback: "Could not find that Kordi ID."
        )
    }

    func sendContactRequest(token: String, peerAccountId: String, message: String?) async throws -> CloudContactRequest {
        let response: ContactRequestResponse = try await send(
            path: "/v1/cloud/contacts/requests",
            method: "POST",
            token: token,
            body: SendContactRequest(peerAccountId: peerAccountId, message: message),
            fallback: "Could not send contact request."
        )
        return response.request
    }

    func acceptContactRequest(token: String, requestId: String) async throws -> CloudContactRequest {
        let response: ContactRequestResponse = try await send(
            path: "/v1/cloud/contacts/requests/\(requestId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestId)/accept",
            method: "POST",
            token: token,
            fallback: "Could not accept contact request."
        )
        return response.request
    }

    func rejectContactRequest(token: String, requestId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/contacts/requests/\(requestId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestId)/reject",
            method: "POST",
            token: token,
            fallback: "Could not decline contact request."
        )
    }

    func listAgents(token: String) async throws -> [CloudAgent] {
        let response: AgentsResponse = try await send(
            path: "/v1/cloud/agents",
            method: "GET",
            token: token,
            fallback: "Could not load agents."
        )
        return response.agents
    }

    func listSharedAgents(token: String, ownerAccountIds: [String]) async throws -> [CloudAgent] {
        let owners = Array(Set(ownerAccountIds.filter { !$0.isEmpty })).sorted()
        guard !owners.isEmpty else { return [] }
        let response: AgentsResponse = try await send(
            path: "/v1/cloud/agents/shared",
            method: "GET",
            token: token,
            query: [URLQueryItem(name: "ownerAccountIds", value: owners.joined(separator: ","))],
            fallback: "Could not load shared agents."
        )
        return response.agents
    }

    func createAgent(token: String, draft: CloudAgentDraft) async throws -> CloudAgent {
        let response: AgentResponse = try await send(
            path: "/v1/cloud/agents",
            method: "POST",
            token: token,
            body: CloudAgentDefinitionRequest(draft: draft),
            fallback: "Could not create this agent."
        )
        return response.agent
    }

    func updateAgent(token: String, agentId: String, draft: CloudAgentDraft) async throws -> CloudAgent {
        let response: AgentResponse = try await send(
            path: "/v1/cloud/agents/\(agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId)",
            method: "PUT",
            token: token,
            body: CloudAgentDefinitionRequest(draft: draft),
            fallback: "Could not save this agent."
        )
        return response.agent
    }

    func archiveAgent(token: String, agentId: String) async throws -> CloudAgent {
        let response: AgentResponse = try await send(
            path: "/v1/cloud/agents/\(agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId)",
            method: "DELETE",
            token: token,
            fallback: "Could not delete this agent."
        )
        return response.agent
    }

    func listMessages(token: String, peerAccountId: String, limit: Int = 200) async throws -> [CloudMessageDTO] {
        let accountId = try requireActiveAccountId()
        _ = try await bootstrapChatV2(token: token)
        let sessionId = directSessionId(accountId: accountId, peerAccountId: peerAccountId)
        guard let conversation = chatV2ConversationsBySessionId[sessionId] else { return [] }
        return try await loadMessages(
            token: token,
            conversation: conversation,
            viewerAccountId: accountId,
            limit: limit
        )
    }

    func listConversationMessages(
        token: String,
        sessionId: String
    ) async throws -> [CloudMessageDTO] {
        let accountId = try requireActiveAccountId()
        _ = try await bootstrapChatV2(token: token)
        guard let conversation = chatV2ConversationsBySessionId[sessionId]
            ?? chatV2ConversationsById[sessionId] else {
            throw CloudAPIError(
                code: "chat_conversation_missing",
                message: "This conversation is not available in reliable chat sync.",
                statusCode: 404
            )
        }
        return try await loadMessages(
            token: token,
            conversation: conversation,
            viewerAccountId: accountId,
            limit: nil
        )
    }

    private func loadMessages(
        token: String,
        conversation: CloudChatV2Conversation,
        viewerAccountId: String,
        limit: Int?
    ) async throws -> [CloudMessageDTO] {
        var result: [CloudMessageDTO] = []
        var beforeSequence: Int64?
        var remaining = limit.map { max($0, 1) }
        repeat {
            let pageLimit = min(remaining ?? 200, 200)
            var query = [URLQueryItem(name: "limit", value: String(pageLimit))]
            if let beforeSequence {
                query.append(URLQueryItem(name: "before_sequence", value: String(beforeSequence)))
            }
            let response: ChatV2HistoryResponse = try await send(
                path: "/v2/chat/conversations/\(escapedPath(conversation.id))/messages",
                method: "GET",
                token: token,
                query: query,
                fallback: "Could not load reliable message history."
            )
            response.messages.forEach { chatV2MessagesById[$0.id] = $0 }
            result.append(contentsOf: response.messages.map {
                legacyMessage(from: $0, conversation: conversation, viewerAccountId: viewerAccountId)
            })
            if let currentRemaining = remaining {
                remaining = currentRemaining - response.messages.count
            }
            beforeSequence = response.nextBeforeSequence
            if !response.hasMore || response.messages.isEmpty || (remaining ?? 1) <= 0 { break }
        } while beforeSequence != nil
        return Dictionary(grouping: result, by: \.messageId)
            .compactMap { $0.value.max { left, right in left.createdAt < right.createdAt } }
            .sorted { left, right in
                left.createdAt < right.createdAt || (left.createdAt == right.createdAt && left.messageId < right.messageId)
            }
    }

    func cachedChatV2SessionTitles() -> [CloudSyncedSessionTitle] {
        chatV2ConversationsById.values.map { conversation in
            let title = conversation.preferences.personalTitle
                ?? (conversation.kind == "group" ? nil : conversation.sharedTitle)
                ?? ""
            return CloudSyncedSessionTitle(
                sessionId: conversation.legacySessionId ?? conversation.id,
                title: title
            )
        }
    }

    func listSessionVisibility(token: String) async throws -> CloudSessionVisibility {
        try await send(
            path: "/v1/cloud/sessions/visibility",
            method: "GET",
            token: token,
            fallback: "Could not load hidden conversations."
        )
    }

    func listSessionForks(token: String, sourceSessionId: String) async throws -> [CloudSessionForkSummary] {
        let escaped = sourceSessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sourceSessionId
        let response: SessionForksResponse = try await send(
            path: "/v1/cloud/sessions/\(escaped)/forks",
            method: "GET",
            token: token,
            fallback: "Could not load session forks."
        )
        return response.forks
    }

    func deleteSession(token: String, sessionId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)",
            method: "DELETE",
            token: token,
            fallback: "Could not delete this session."
        )
    }

    func sessionPin(token: String, sessionId: String) async throws -> CloudSessionPin {
        let escaped = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        let response: SessionPinResponse = try await send(
            path: "/v1/cloud/sessions/\(escaped)/pin",
            method: "GET",
            token: token,
            fallback: "Could not load the pinned message."
        )
        return response.pin
    }

    func updateSessionPin(
        token: String,
        sessionId: String,
        messageId: String?,
        scope: String
    ) async throws -> CloudSessionPin {
        let escaped = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        let response: SessionPinResponse = try await send(
            path: "/v1/cloud/sessions/\(escaped)/pin",
            method: "PUT",
            token: token,
            body: UpdateSessionPinRequest(messageId: messageId, scope: scope),
            fallback: messageId == nil ? "Could not unpin the message." : "Could not pin the message."
        )
        return response.pin
    }

    func sessionActivity(token: String, sessionId: String) async throws -> CloudSessionActivity {
        try await send(
            path: "/v1/cloud/session-activity",
            method: "GET",
            token: token,
            query: [URLQueryItem(name: "sessionId", value: sessionId)],
            fallback: "Could not load session activity."
        )
    }

    func currentProviderAuthSnapshot(
        token: String,
        provider: String? = nil,
        authChoice: String? = nil
    ) async throws -> CloudProviderAuthSnapshot? {
        var query: [URLQueryItem] = []
        if let provider = provider?.nonEmpty { query.append(URLQueryItem(name: "provider", value: provider)) }
        if let authChoice = authChoice?.nonEmpty { query.append(URLQueryItem(name: "authChoice", value: authChoice)) }
        let response: ProviderAuthSnapshotResponse = try await send(
            path: "/v1/cloud/agent-provider-auth/snapshots/current",
            method: "GET",
            token: token,
            query: query,
            fallback: "Could not load provider authentication."
        )
        return response.snapshot
    }

    func publishProviderAuthSnapshot(
        token: String,
        provider: String,
        authChoice: String,
        payload: [String: String]
    ) async throws -> CloudProviderAuthSnapshot {
        try await send(
            path: "/v1/cloud/agent-provider-auth/snapshots",
            method: "POST",
            token: token,
            body: PublishProviderAuthSnapshotRequest(
                provider: provider,
                authChoice: authChoice,
                payload: payload
            ),
            fallback: "Could not save provider authentication."
        )
    }

    func revokeProviderAuthSnapshot(token: String, snapshotId: String) async throws -> CloudProviderAuthSnapshot {
        try await send(
            path: "/v1/cloud/agent-provider-auth/snapshots/\(snapshotId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? snapshotId)",
            method: "DELETE",
            token: token,
            fallback: "Could not remove provider authentication."
        )
    }

    func updateAgentRouting(token: String, agentId: String, routing: CloudModelRouting) async throws -> CloudAgent {
        let response: AgentResponse = try await send(
            path: "/v1/cloud/agents/\(agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId)",
            method: "PUT",
            token: token,
            body: UpdateAgentRoutingRequest(modelRouting: routing),
            fallback: "Could not update this agent's model."
        )
        return response.agent
    }

    func sendMessage(
        token: String,
        peerAccountId: String,
        body: String,
        sessionId: String,
        clientMessageId: String,
        attachments: [CloudMessageAttachment] = [],
        conversationKind: String? = nil,
        memberAccountIds: [String]? = nil,
        sharedTitle: String? = nil
    ) async throws -> CloudMessageDTO {
        let accountId = try requireActiveAccountId()
        let groupEnvelope = CloudGroupMessageCodec.parse(body)
        let kind = conversationKind
            ?? (groupEnvelope == nil ? (peerAccountId == accountId ? "ai" : "direct") : "group")
        let members = memberAccountIds
            ?? groupEnvelope?.participants.map(\.accountId)
            ?? [peerAccountId]
        var conversation = try await ensureChatV2Conversation(
            token: token,
            sessionId: sessionId,
            kind: kind,
            memberAccountIds: members,
            sharedTitle: sharedTitle
        )
        let response: ChatV2MessageResponse = try await send(
            path: "/v2/chat/conversations/\(escapedPath(conversation.id))/messages",
            method: "POST",
            token: token,
            body: ChatV2SendMessageRequest(
                clientMessageId: operationUUID(clientMessageId),
                kind: "text",
                content: CloudChatV2Content(body: body, attachments: attachments),
                replyToMessageId: nil,
                attachmentIds: attachments.map(\.attachmentId)
            ),
            fallback: "Could not send the message."
        )
        chatV2MessagesById[response.message.id] = response.message
        conversation = conversation.withLatestMessageSequence(response.message.conversationSequence)
        remember(conversation)
        return legacyMessage(from: response.message, conversation: conversation, viewerAccountId: accountId)
    }

    func uploadAttachment(token: String, attachment: PendingAttachment) async throws -> CloudMessageAttachment {
        let initiated: AttachmentInitiateResponse = try await send(
            path: "/v1/cloud/attachments/initiate",
            method: "POST",
            token: token,
            fallback: "Could not start the attachment upload."
        )
        var request = try makeRequest(
            path: "/v1/cloud/attachments/\(initiated.attachmentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? initiated.attachmentId)/upload",
            method: "PUT",
            token: token,
            query: [],
            body: attachment.data
        )
        request.setValue(attachment.mimeType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 90
        do {
            let (data, response) = try await session.data(for: request)
            try validate(response: response, data: data, fallback: "Could not upload \(attachment.name).")
            let uploaded = try decoder.decode(AttachmentUploadResponse.self, from: data)
            return CloudMessageAttachment(
                attachmentId: uploaded.attachmentId,
                name: attachment.name,
                kind: attachment.kind.rawValue,
                mimeType: uploaded.contentType?.nonEmpty ?? attachment.mimeType,
                sizeBytes: uploaded.sizeBytes ?? attachment.sizeBytes,
                downloadUrl: nil,
                previewUrl: attachment.previewURL
            )
        } catch let error as CloudAPIError {
            throw error
        } catch {
            throw CloudAPIError(
                code: "network_error",
                message: "Could not upload \(attachment.name). Check your connection and try again.",
                statusCode: 0
            )
        }
    }

    func downloadAttachmentContent(token: String, attachmentId: String) async throws -> Data {
        let encodedId = attachmentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? attachmentId
        var request = try makeRequest(
            path: "/v1/cloud/attachments/\(encodedId)/content",
            method: "GET",
            token: token,
            query: [],
            body: nil
        )
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 90
        do {
            let (data, response) = try await session.data(for: request)
            try validate(response: response, data: data, fallback: "Could not download this attachment.")
            return data
        } catch let error as CloudAPIError {
            throw error
        } catch {
            throw CloudAPIError(
                code: "network_error",
                message: "Could not download this attachment. Check your connection and try again.",
                statusCode: 0
            )
        }
    }

    func markMessagesRead(token: String, peerAccountId: String) async throws {
        let accountId = try requireActiveAccountId()
        let sessionId = directSessionId(accountId: accountId, peerAccountId: peerAccountId)
        let conversation = try await ensureChatV2Conversation(
            token: token,
            sessionId: sessionId,
            kind: accountId == peerAccountId ? "ai" : "direct",
            memberAccountIds: [peerAccountId]
        )
        try await advanceChatV2Cursor(token: token, conversation: conversation, kind: "read")
    }

    func markSessionMessagesRead(token: String, sessionId: String) async throws {
        _ = try await bootstrapChatV2(token: token)
        guard let conversation = chatV2ConversationsBySessionId[sessionId] else {
            throw CloudAPIError(code: "chat_conversation_missing", message: "Reliable chat conversation is unavailable.", statusCode: 404)
        }
        try await advanceChatV2Cursor(token: token, conversation: conversation, kind: "read")
    }

    func claimAgentRun(
        token: String,
        requestMessageId: String,
        sessionId: String,
        ownerAccountId: String,
        requesterAccountId: String,
        prompt: String,
        runtimeRoute: CloudModelRouting?
    ) async throws -> CloudAgentRun {
        try await send(
            path: "/v1/cloud/agent-runs/claim",
            method: "POST",
            token: token,
            body: ClaimAgentRunRequest(
                requestMessageId: requestMessageId,
                sessionId: sessionId,
                ownerAccountId: ownerAccountId,
                requesterAccountId: requesterAccountId,
                prompt: prompt,
                runtimeRoute: runtimeRoute,
                idempotencyKey: "ios-agent:\(requestMessageId):\(ownerAccountId)"
            ),
            fallback: "Could not start the agent."
        )
    }

    func lookupAgentRun(token: String, requestMessageId: String) async throws -> CloudAgentRun? {
        let response: AgentRunLookupResponse = try await send(
            path: "/v1/cloud/agent-runs/request/\(requestMessageId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestMessageId)",
            method: "GET",
            token: token,
            fallback: "Could not refresh agent state."
        )
        return response.run
    }

    func updateSessionTitle(
        token: String,
        sessionId: String,
        title: String,
        peerAccountId: String,
        conversationKind: String,
        memberAccountIds: [String]
    ) async throws -> CloudSyncedSessionTitle {
        let desiredTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        var conversation = try await ensureChatV2Conversation(
            token: token,
            sessionId: sessionId,
            kind: conversationKind,
            memberAccountIds: memberAccountIds.isEmpty ? [peerAccountId] : memberAccountIds
        )
        for attempt in 0..<2 {
            do {
                let response: ChatV2PreferencesResponse = try await send(
                    path: "/v2/chat/conversations/\(escapedPath(conversation.id))/preferences",
                    method: "PUT",
                    token: token,
                    body: ChatV2UpdatePersonalTitleRequest(
                        clientOperationId: operationUUID(
                            "title:\(conversation.id):\(conversation.preferences.version):\(desiredTitle)"
                        ),
                        expectedPreferencesVersion: conversation.preferences.version,
                        personalTitle: desiredTitle.nonEmpty
                    ),
                    fallback: "Could not synchronize the session title."
                )
                conversation = conversation.withPreferences(response.preferences)
                remember(conversation)
                return CloudSyncedSessionTitle(
                    sessionId: conversation.legacySessionId ?? conversation.id,
                    title: response.preferences.personalTitle ?? conversation.sharedTitle ?? "New session"
                )
            } catch let error as CloudAPIError where error.statusCode == 409 && attempt == 0 {
                _ = try await bootstrapChatV2(token: token, force: true)
                guard let refreshed = chatV2ConversationsBySessionId[sessionId] else { throw error }
                conversation = refreshed
                if conversation.preferences.personalTitle == desiredTitle.nonEmpty {
                    return CloudSyncedSessionTitle(sessionId: sessionId, title: desiredTitle)
                }
            }
        }
        throw CloudAPIError(code: "title_sync_failed", message: "Could not synchronize the session title.", statusCode: 0)
    }

    private func requireActiveAccountId() throws -> String {
        guard let accountId = activeAccountId?.nonEmpty else {
            throw CloudAPIError(code: "account_missing", message: "Your Kordi account session is unavailable.", statusCode: 401)
        }
        return accountId
    }

    private func bootstrapChatV2(token: String, force: Bool = false) async throws -> CloudChatV2BootstrapResponse {
        if !force, let cached = lastChatV2Bootstrap { return cached }
        if let task = chatV2BootstrapTask { return try await task.value }
        let task = Task { [self] in
            let response: CloudChatV2BootstrapResponse = try await send(
                path: "/v2/chat/sync/bootstrap",
                method: "GET",
                token: token,
                fallback: "Could not bootstrap reliable chat state."
            )
            guard response.protocolVersion == 2 else {
                throw CloudAPIError(code: "unsupported_protocol", message: "This Kordi version cannot read the reliable chat stream.", statusCode: 0)
            }
            return response
        }
        chatV2BootstrapTask = task
        do {
            let response = try await task.value
            chatV2BootstrapTask = nil
            lastChatV2Bootstrap = response
            response.conversations.forEach(remember)
            response.latestMessages.forEach { chatV2MessagesById[$0.id] = $0 }
            return response
        } catch {
            chatV2BootstrapTask = nil
            throw error
        }
    }

    private func ensureChatV2Conversation(
        token: String,
        sessionId: String,
        kind: String,
        memberAccountIds: [String],
        sharedTitle: String? = nil
    ) async throws -> CloudChatV2Conversation {
        let accountId = try requireActiveAccountId()
        _ = try await bootstrapChatV2(token: token)
        let desiredMembers = Set(memberAccountIds.compactMap(\.nonEmpty)).union([accountId])
        if var cached = chatV2ConversationsBySessionId[sessionId] {
            if cached.kind == "group" {
                let activeMembers = Set(cached.members.filter { $0.membershipState == "active" }.map(\.accountId))
                if activeMembers != desiredMembers {
                    let response: ChatV2ConversationResponse = try await send(
                        path: "/v2/chat/conversations/\(escapedPath(cached.id))/members",
                        method: "PUT",
                        token: token,
                        body: ChatV2UpdateMembersRequest(
                            clientOperationId: operationUUID(
                                "members:\(cached.id):\(desiredMembers.sorted().joined(separator: ":"))"
                            ),
                            memberAccountIds: desiredMembers.filter { $0 != accountId }.sorted(),
                            replace: true
                        ),
                        fallback: "Could not synchronize group membership."
                    )
                    cached = response.conversation
                    remember(cached)
                }
            }
            return cached
        }
        let response: ChatV2ConversationResponse = try await send(
            path: "/v2/chat/conversations",
            method: "POST",
            token: token,
            body: ChatV2CreateConversationRequest(
                clientOperationId: operationUUID(
                    "conversation:\(kind):\(sessionId):\(desiredMembers.sorted().joined(separator: ":"))"
                ),
                kind: kind,
                sharedTitle: sharedTitle?.nonEmpty,
                clientSessionId: sessionId,
                memberAccountIds: desiredMembers.filter { $0 != accountId }.sorted()
            ),
            fallback: "Could not open the reliable chat conversation."
        )
        remember(response.conversation)
        return response.conversation
    }

    private func advanceChatV2Cursor(
        token: String,
        conversation: CloudChatV2Conversation,
        kind: String
    ) async throws {
        guard conversation.latestMessageSequence > 0 else { return }
        let response: ChatV2CursorResponse = try await send(
            path: "/v2/chat/conversations/\(escapedPath(conversation.id))/\(kind)",
            method: "PUT",
            token: token,
            body: ChatV2AdvanceCursorRequest(
                clientOperationId: operationUUID(
                    "cursor:\(kind):\(conversation.id):\(conversation.latestMessageSequence)"
                ),
                sequence: conversation.latestMessageSequence
            ),
            fallback: "Could not mark messages \(kind)."
        )
        remember(conversation.withCursor(response.cursor))
    }

    private func remember(_ conversation: CloudChatV2Conversation) {
        activateAccount(conversation.preferences.accountId)
        chatV2ConversationsById[conversation.id] = conversation
        chatV2ConversationsBySessionId[conversation.id] = conversation
        if let sessionId = conversation.legacySessionId?.nonEmpty {
            chatV2ConversationsBySessionId[sessionId] = conversation
        }
    }

    private func legacyMessage(
        from message: CloudChatV2Message,
        conversation: CloudChatV2Conversation,
        viewerAccountId: String
    ) -> CloudMessageDTO {
        let outgoing = message.senderAccountId == viewerAccountId
        let otherMembers = conversation.members.filter {
            $0.accountId != viewerAccountId && $0.membershipState == "active"
        }
        let peerAccountId = message.senderAccountId != viewerAccountId
            ? message.senderAccountId
            : otherMembers.first?.accountId ?? viewerAccountId
        let delivered = outgoing
            ? !otherMembers.isEmpty && otherMembers.allSatisfy {
                $0.lastDeliveredSequence >= message.conversationSequence
            }
            : true
        let read = outgoing
            ? !otherMembers.isEmpty && otherMembers.allSatisfy {
                $0.lastReadSequence >= message.conversationSequence
            }
            : conversation.members.contains {
                $0.accountId == viewerAccountId && $0.lastReadSequence >= message.conversationSequence
            }
        return CloudMessageDTO(
            messageId: message.id,
            fromAccountId: message.senderAccountId,
            toAccountId: outgoing ? peerAccountId : viewerAccountId,
            body: message.deletedAt == nil ? message.content.body : "",
            createdAt: message.createdAt,
            deliveredAt: delivered ? message.createdAt : nil,
            readAt: read ? message.createdAt : nil,
            direction: outgoing ? "outgoing" : "incoming",
            sessionId: conversation.legacySessionId ?? conversation.id,
            attachments: message.content.legacyAttachments
        )
    }

    private func bootstrapEvents(_ bootstrap: CloudChatV2BootstrapResponse) -> [CloudSyncEvent] {
        let conversationsById = Dictionary(uniqueKeysWithValues: bootstrap.conversations.map { ($0.id, $0) })
        let titleEvents = bootstrap.conversations.map { titleEvent(
            id: "bootstrap:conversation:\($0.id):\($0.version)",
            conversation: $0,
            occurredAt: $0.updatedAt
        ) }
        let messageEvents = bootstrap.latestMessages.compactMap { message -> CloudSyncEvent? in
            guard let conversation = conversationsById[message.conversationId] else { return nil }
            return messageEvent(
                id: "bootstrap:message:\(message.id):\(message.version)",
                message: message,
                conversation: conversation,
                occurredAt: message.createdAt
            )
        }
        return titleEvents + messageEvents
    }

    private func legacyEvents(from event: CloudChatV2Event) throws -> [CloudSyncEvent] {
        var conversation = event.payload.conversation
            ?? event.conversationId.flatMap { chatV2ConversationsById[$0] }
        if let conversation { remember(conversation) }
        let messageTypes: Set<String> = [
            "message.created", "message.updated", "message.deleted",
            "generation.updated", "generation.completed", "generation.failed"
        ]
        if messageTypes.contains(event.eventType),
           let message = event.payload.message,
           let conversation {
            chatV2MessagesById[message.id] = message
            return [messageEvent(id: event.eventId, message: message, conversation: conversation, occurredAt: event.occurredAt)]
        }
        if ["conversation.created", "conversation.updated", "membership.updated"].contains(event.eventType),
           let conversation {
            return [titleEvent(id: event.eventId, conversation: conversation, occurredAt: event.occurredAt)]
        }
        if event.eventType == "conversation.preferences.updated",
           let current = conversation,
           let preferences = event.payload.preferences {
            let updated = current.withPreferences(preferences)
            remember(updated)
            return [titleEvent(id: event.eventId, conversation: updated, occurredAt: event.occurredAt)]
        }
        if ["delivery_cursor.updated", "read_cursor.updated"].contains(event.eventType),
           let current = conversation,
           let cursor = event.payload.cursor {
            let updated = current.withCursor(cursor)
            remember(updated)
            conversation = updated
            return chatV2MessagesById.values
                .filter { $0.conversationId == updated.id }
                .map {
                    messageEvent(
                        id: "\(event.eventId):\($0.id)",
                        message: $0,
                        conversation: updated,
                        occurredAt: event.occurredAt
                    )
                }
        }
        if event.eventType == "membership.removed", let conversationId = event.conversationId {
            let sessionId = conversation?.legacySessionId ?? conversationId
            chatV2ConversationsById.removeValue(forKey: conversationId)
            chatV2ConversationsBySessionId.removeValue(forKey: sessionId)
            return [CloudSyncEvent(
                eventId: event.eventId,
                eventType: "session.deleted",
                peerAccountId: nil,
                messageId: nil,
                payload: CloudSyncEventPayload(
                    message: nil, messageIds: nil, readAt: nil, sessionId: sessionId,
                    forkSessionId: nil, parentSessionId: nil, parentMessageId: nil,
                    createdByAccountId: nil, createdAt: nil, sessionTitle: nil
                ),
                occurredAt: event.occurredAt
            )]
        }
        let knownNonChatEvents: Set<String> = [
            "agent.definition.upserted", "agent.definition.archived", "task.upsert",
            "artifact.upsert", "artifact.archived", "session.pin.updated", "session.hidden",
            "session.unhidden", "session.deleted", "session-forked"
        ]
        if knownNonChatEvents.contains(event.eventType) { return [] }
        if event.critical {
            throw CloudAPIError(code: "CLIENT_UPDATE_REQUIRED", message: "Update Kordi to continue reliable chat sync.", statusCode: 0)
        }
        return []
    }

    private func messageEvent(
        id: String,
        message: CloudChatV2Message,
        conversation: CloudChatV2Conversation,
        occurredAt: String
    ) -> CloudSyncEvent {
        let viewer = conversation.preferences.accountId
        let projected = legacyMessage(from: message, conversation: conversation, viewerAccountId: viewer)
        let peer = projected.fromAccountId == viewer ? projected.toAccountId : projected.fromAccountId
        return CloudSyncEvent(
            eventId: id,
            eventType: "message.upsert",
            peerAccountId: peer,
            messageId: message.id,
            payload: CloudSyncEventPayload(
                message: projected, messageIds: nil, readAt: nil, sessionId: nil,
                forkSessionId: nil, parentSessionId: nil, parentMessageId: nil,
                createdByAccountId: nil, createdAt: nil, sessionTitle: nil
            ),
            occurredAt: occurredAt
        )
    }

    private func titleEvent(
        id: String,
        conversation: CloudChatV2Conversation,
        occurredAt: String
    ) -> CloudSyncEvent {
        let title = conversation.preferences.personalTitle
            ?? (conversation.kind == "group" ? nil : conversation.sharedTitle)
            ?? ""
        return CloudSyncEvent(
            eventId: id,
            eventType: "session.title.updated",
            peerAccountId: nil,
            messageId: nil,
            payload: CloudSyncEventPayload(
                message: nil, messageIds: nil, readAt: nil, sessionId: nil,
                forkSessionId: nil, parentSessionId: nil, parentMessageId: nil,
                createdByAccountId: nil, createdAt: nil,
                sessionTitle: CloudSyncedSessionTitle(
                    sessionId: conversation.legacySessionId ?? conversation.id,
                    title: title
                )
            ),
            occurredAt: occurredAt
        )
    }

    private func directSessionId(accountId: String, peerAccountId: String) -> String {
        "session:direct-person:\([accountId, peerAccountId].sorted().joined(separator: ":"))"
    }

    private func escapedPath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func operationUUID(_ value: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if UUID(uuidString: normalized) != nil { return normalized.lowercased() }
        var bytes = Array(SHA256.hash(data: Data(normalized.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20))"
    }

    func sync(token: String, cursor: String) async throws -> CloudSyncResponse {
        if cursor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || cursor == "0" {
            let bootstrap = try await bootstrapChatV2(token: token, force: true)
            return CloudSyncResponse(
                cursor: bootstrap.nextCursor,
                hasMore: false,
                events: bootstrapEvents(bootstrap)
            )
        }
        let response: CloudChatV2SyncResponse
        do {
            response = try await send(
                path: "/v2/chat/sync",
                method: "GET",
                token: token,
                query: [URLQueryItem(name: "cursor", value: cursor)],
                fallback: "Could not sync reliable chat changes."
            )
        } catch let error as CloudAPIError where error.code == "SYNC_CURSOR_EXPIRED" {
            resetChatV2Cache()
            return try await sync(token: token, cursor: "0")
        }
        guard response.protocolVersion == 2 else {
            throw CloudAPIError(code: "unsupported_protocol", message: "This Kordi version cannot read the reliable chat stream.", statusCode: 0)
        }
        var events: [CloudSyncEvent] = []
        for event in response.events {
            events.append(contentsOf: try legacyEvents(from: event))
        }
        return CloudSyncResponse(cursor: response.nextCursor, hasMore: response.hasMore, events: events)
    }

    private func send<Response: Decodable>(
        path: String,
        method: String,
        token: String? = nil,
        query: [URLQueryItem] = [],
        fallback: String
    ) async throws -> Response {
        try await perform(path: path, method: method, token: token, query: query, body: nil, fallback: fallback)
    }

    private func send<Response: Decodable, Body: Encodable>(
        path: String,
        method: String,
        token: String? = nil,
        query: [URLQueryItem] = [],
        body: Body,
        fallback: String
    ) async throws -> Response {
        try await perform(path: path, method: method, token: token, query: query, body: try encoder.encode(body), fallback: fallback)
    }

    private func sendWithoutResponse(
        path: String,
        method: String,
        token: String? = nil,
        fallback: String
    ) async throws {
        try await sendWithoutResponse(path: path, method: method, token: token, bodyData: nil, fallback: fallback)
    }

    private func sendWithoutResponse<Body: Encodable>(
        path: String,
        method: String,
        token: String? = nil,
        body: Body,
        fallback: String
    ) async throws {
        try await sendWithoutResponse(path: path, method: method, token: token, bodyData: try encoder.encode(body), fallback: fallback)
    }

    private func sendWithoutResponse(
        path: String,
        method: String,
        token: String?,
        bodyData: Data?,
        fallback: String
    ) async throws {
        let request = try makeRequest(path: path, method: method, token: token, query: [], body: bodyData)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data, fallback: fallback)
    }

    private func perform<Response: Decodable>(
        path: String,
        method: String,
        token: String?,
        query: [URLQueryItem],
        body: Data?,
        fallback: String
    ) async throws -> Response {
        let request = try makeRequest(path: path, method: method, token: token, query: query, body: body)
        do {
            let (data, response) = try await session.data(for: request)
            try validate(response: response, data: data, fallback: fallback)
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw CloudAPIError(code: "invalid_response", message: "Kordi Cloud returned an unexpected response.", statusCode: 0)
            }
        } catch let error as CloudAPIError {
            throw error
        } catch {
            if CloudTransportErrorPolicy.isCancellation(error) {
                throw CancellationError()
            }
            throw CloudAPIError(code: "network_error", message: "Could not reach Kordi Cloud. Check your connection and try again.", statusCode: 0)
        }
    }

    private func makeRequest(
        path: String,
        method: String,
        token: String?,
        query: [URLQueryItem],
        body: Data?
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))), resolvingAgainstBaseURL: false) else {
            throw CloudAPIError(code: "invalid_url", message: "Kordi Cloud URL is invalid.", statusCode: 0)
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw CloudAPIError(code: "invalid_url", message: "Kordi Cloud URL is invalid.", statusCode: 0)
        }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func validate(response: URLResponse, data: Data, fallback: String) throws {
        guard let http = response as? HTTPURLResponse else {
            throw CloudAPIError(code: "network_error", message: fallback, statusCode: 0)
        }
        guard (200..<300).contains(http.statusCode) else {
            let server = try? decoder.decode(ServerError.self, from: data)
            throw CloudAPIError(
                code: server?.errorCode ?? "server_error",
                message: server?.message.nonEmpty ?? fallback,
                statusCode: http.statusCode
            )
        }
    }
}

private struct LoginRequest: Encodable { let email: String; let password: String }
private struct UpdateProfileRequest: Encodable {
    let displayName: String
    let avatarUrl: String?
}
private struct SignupRequest: Encodable {
    let email: String
    let password: String
    let displayName: String?
    let avatarUrl: String
}
private struct ContactsResponse: Decodable { let contacts: [CloudContact] }
private struct ContactRequestsResponse: Decodable { let requests: [CloudContactRequest] }
private struct ContactRequestResponse: Decodable { let request: CloudContactRequest }
private struct SendContactRequest: Encodable { let peerAccountId: String; let message: String? }
private struct AgentsResponse: Decodable { let agents: [CloudAgent] }
private struct AgentResponse: Decodable { let agent: CloudAgent }
private struct CloudAgentDefinitionRequest: Encodable {
    let accessScope: String
    let name: String
    let role: String
    let description: String
    let systemPrompt: String
    let sourceSummary: String
    let boundaries: [String]
    let resources: [CloudAgentResource]
    let skills: [CloudAgentSkill]
    let modelRouting: CloudModelRouting

    init(draft: CloudAgentDraft) {
        accessScope = draft.accessScope.rawValue
        name = draft.name
        role = draft.role
        description = draft.description
        systemPrompt = draft.systemPrompt
        sourceSummary = draft.sourceSummary
        boundaries = draft.boundaries.map(\.value)
        resources = draft.resources.map {
            CloudAgentResource(
                kind: $0.kind,
                value: $0.value,
                title: $0.title.nonEmpty,
                summary: $0.summary.nonEmpty
            )
        }
        skills = draft.skills.map {
            CloudAgentSkill(
                name: $0.name,
                description: $0.description,
                content: $0.content.nonEmpty
            )
        }
        var routing = draft.modelRouting
        routing.tools = draft.tools.map(\.name)
        routing.plugins = draft.plugins.map(\.name)
        modelRouting = routing
    }
}
private struct UpdateAgentRoutingRequest: Encodable { let modelRouting: CloudModelRouting }
private struct ProviderAuthSnapshotResponse: Decodable { let snapshot: CloudProviderAuthSnapshot? }
private struct PublishProviderAuthSnapshotRequest: Encodable {
    let provider: String
    let authChoice: String
    let payload: [String: String]
}
private struct AgentRunLookupResponse: Decodable { let run: CloudAgentRun? }
private struct SessionForksResponse: Decodable { let forks: [CloudSessionForkSummary] }
private struct SessionPinResponse: Decodable { let pin: CloudSessionPin }
private struct UpdateSessionPinRequest: Encodable { let messageId: String?; let scope: String }
private struct ServerError: Decodable {
    let errorCode: String?
    let message: String?

    private enum CodingKeys: String, CodingKey { case errorCode, code, message, error }
    private struct Nested: Decodable { let code: String?; let message: String? }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nested = try container.decodeIfPresent(Nested.self, forKey: .error)
        let topLevelErrorCode = try container.decodeIfPresent(String.self, forKey: .errorCode)
        let topLevelCode = try container.decodeIfPresent(String.self, forKey: .code)
        let topLevelMessage = try container.decodeIfPresent(String.self, forKey: .message)
        errorCode = nested?.code ?? topLevelErrorCode ?? topLevelCode
        message = nested?.message ?? topLevelMessage
    }
}

private struct ChatV2ConversationResponse: Decodable { let conversation: CloudChatV2Conversation }
private struct ChatV2MessageResponse: Decodable { let message: CloudChatV2Message }
private struct ChatV2PreferencesResponse: Decodable { let preferences: CloudChatV2Preferences }
private struct ChatV2CursorResponse: Decodable { let cursor: CloudChatV2Cursor }

private struct ChatV2HistoryResponse: Decodable {
    let messages: [CloudChatV2Message]
    let nextBeforeSequence: Int64?
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case messages
        case nextBeforeSequence = "next_before_sequence"
        case hasMore = "has_more"
    }
}

private struct ChatV2CreateConversationRequest: Encodable {
    let clientOperationId: String
    let kind: String
    let sharedTitle: String?
    let clientSessionId: String
    let memberAccountIds: [String]

    enum CodingKeys: String, CodingKey {
        case clientOperationId = "client_operation_id"
        case kind
        case sharedTitle = "shared_title"
        case clientSessionId = "client_session_id"
        case memberAccountIds = "member_account_ids"
    }
}

private struct ChatV2UpdateMembersRequest: Encodable {
    let clientOperationId: String
    let memberAccountIds: [String]
    let replace: Bool

    enum CodingKeys: String, CodingKey {
        case clientOperationId = "client_operation_id"
        case memberAccountIds = "member_account_ids"
        case replace
    }
}

private struct ChatV2SendMessageRequest: Encodable {
    let clientMessageId: String
    let kind: String
    let content: CloudChatV2Content
    let replyToMessageId: String?
    let attachmentIds: [String]

    enum CodingKeys: String, CodingKey {
        case clientMessageId = "client_message_id"
        case kind, content
        case replyToMessageId = "reply_to_message_id"
        case attachmentIds = "attachment_ids"
    }
}

private struct ChatV2AdvanceCursorRequest: Encodable {
    let clientOperationId: String
    let sequence: Int64

    enum CodingKeys: String, CodingKey {
        case clientOperationId = "client_operation_id"
        case sequence
    }
}

private struct ChatV2UpdatePersonalTitleRequest: Encodable {
    let clientOperationId: String
    let expectedPreferencesVersion: Int
    let personalTitle: String?

    enum CodingKeys: String, CodingKey {
        case clientOperationId = "client_operation_id"
        case expectedPreferencesVersion = "expected_preferences_version"
        case personalTitle = "personal_title"
    }
}

private struct AttachmentInitiateResponse: Decodable {
    let attachmentId: String
}

private struct AttachmentUploadResponse: Decodable {
    let attachmentId: String
    let sizeBytes: Int64?
    let contentType: String?
}

private struct ClaimAgentRunRequest: Encodable {
    let requestMessageId: String
    let sessionId: String
    let ownerAccountId: String
    let requesterAccountId: String
    let prompt: String
    let runtimeRoute: CloudModelRouting?
    let idempotencyKey: String
}

private extension CloudChatV2Conversation {
    func withLatestMessageSequence(_ sequence: Int64) -> Self {
        Self(
            id: id,
            kind: kind,
            sharedTitle: sharedTitle,
            version: version + (sequence > latestMessageSequence ? 1 : 0),
            createdByAccountId: createdByAccountId,
            legacySessionId: legacySessionId,
            forkedFromSessionId: forkedFromSessionId,
            forkedFromMessageId: forkedFromMessageId,
            latestMessageSequence: max(latestMessageSequence, sequence),
            createdAt: createdAt,
            updatedAt: updatedAt,
            members: members,
            preferences: preferences
        )
    }

    func withPreferences(_ value: CloudChatV2Preferences) -> Self {
        Self(
            id: id,
            kind: kind,
            sharedTitle: sharedTitle,
            version: version,
            createdByAccountId: createdByAccountId,
            legacySessionId: legacySessionId,
            forkedFromSessionId: forkedFromSessionId,
            forkedFromMessageId: forkedFromMessageId,
            latestMessageSequence: latestMessageSequence,
            createdAt: createdAt,
            updatedAt: updatedAt,
            members: members,
            preferences: value
        )
    }

    func withCursor(_ cursor: CloudChatV2Cursor) -> Self {
        Self(
            id: id,
            kind: kind,
            sharedTitle: sharedTitle,
            version: version,
            createdByAccountId: createdByAccountId,
            legacySessionId: legacySessionId,
            forkedFromSessionId: forkedFromSessionId,
            forkedFromMessageId: forkedFromMessageId,
            latestMessageSequence: latestMessageSequence,
            createdAt: createdAt,
            updatedAt: updatedAt,
            members: members.map { member in
                guard member.accountId == cursor.accountId else { return member }
                return CloudChatV2Member(
                    accountId: member.accountId,
                    displayName: member.displayName,
                    avatarUrl: member.avatarUrl,
                    role: member.role,
                    membershipState: member.membershipState,
                    version: member.version,
                    lastDeliveredSequence: cursor.lastDeliveredSequence,
                    lastReadSequence: cursor.lastReadSequence,
                    joinedAt: member.joinedAt,
                    leftAt: member.leftAt
                )
            },
            preferences: preferences
        )
    }
}
