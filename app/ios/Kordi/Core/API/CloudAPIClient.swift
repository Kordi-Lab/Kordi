import Foundation

struct CloudAPIError: LocalizedError, Equatable {
    let code: String
    let message: String
    let statusCode: Int

    var errorDescription: String? { message }
}

actor CloudAPIClient {
    static let productionBaseURL = URL(string: "https://kordi.ai")!

    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: URL = productionBaseURL, session: URLSession = .shared) {
        precondition(baseURL.scheme == "https", "Kordi Cloud requires HTTPS")
        self.baseURL = baseURL
        self.session = session
    }

    func login(email: String, password: String) async throws -> CloudAuthResponse {
        try await send(
            path: "/v1/cloud/auth/login",
            method: "POST",
            body: LoginRequest(email: email, password: password),
            fallback: "Could not sign in."
        )
    }

    func signup(
        email: String,
        password: String,
        displayName: String?,
        avatarUrl: String
    ) async throws -> CloudAuthResponse {
        try await send(
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
        try await send(path: "/v1/cloud/auth/me", method: "GET", token: token, fallback: "Could not restore your session.")
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
        try await sendWithoutResponse(path: "/v1/cloud/auth/logout", method: "POST", token: token, fallback: "Could not sign out.")
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

    func listMessages(token: String, peerAccountId: String, limit: Int = 200) async throws -> [CloudMessageDTO] {
        let response: MessagesResponse = try await send(
            path: "/v1/cloud/messages",
            method: "GET",
            token: token,
            query: [
                URLQueryItem(name: "peerAccountId", value: peerAccountId),
                URLQueryItem(name: "limit", value: String(limit))
            ],
            fallback: "Could not load messages."
        )
        return response.messages
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
        attachments: [CloudMessageAttachment] = []
    ) async throws -> CloudMessageDTO {
        let response: MessageResponse = try await send(
            path: "/v1/cloud/messages",
            method: "POST",
            token: token,
            body: SendMessageRequest(
                peerAccountId: peerAccountId,
                body: body,
                sessionId: sessionId,
                clientCreatedAt: ISO8601DateFormatter().string(from: Date()),
                clientMessageId: clientMessageId,
                attachments: attachments.map {
                    SendMessageAttachmentRequest(
                        attachmentId: $0.attachmentId,
                        name: $0.name,
                        kind: $0.kind,
                        mimeType: $0.mimeType,
                        sizeBytes: $0.sizeBytes,
                        previewUrl: $0.previewUrl
                    )
                }
            ),
            fallback: "Could not send the message."
        )
        return response.message
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
        try await sendWithoutResponse(
            path: "/v1/cloud/messages/read",
            method: "POST",
            token: token,
            body: MarkReadRequest(peerAccountId: peerAccountId),
            fallback: "Could not update read state."
        )
    }

    func markSessionMessagesRead(token: String, sessionId: String) async throws {
        try await sendWithoutResponse(
            path: "/v1/cloud/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)/read",
            method: "POST",
            token: token,
            fallback: "Could not update this session's read state."
        )
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

    func sync(token: String, cursor: String) async throws -> CloudSyncResponse {
        try await send(
            path: "/v1/cloud/sync",
            method: "GET",
            token: token,
            query: [URLQueryItem(name: "cursor", value: cursor)],
            fallback: "Could not sync conversations."
        )
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
private struct UpdateAgentRoutingRequest: Encodable { let modelRouting: CloudModelRouting }
private struct ProviderAuthSnapshotResponse: Decodable { let snapshot: CloudProviderAuthSnapshot? }
private struct PublishProviderAuthSnapshotRequest: Encodable {
    let provider: String
    let authChoice: String
    let payload: [String: String]
}
private struct MessagesResponse: Decodable { let messages: [CloudMessageDTO] }
private struct MessageResponse: Decodable { let message: CloudMessageDTO }
private struct AgentRunLookupResponse: Decodable { let run: CloudAgentRun? }
private struct SessionForksResponse: Decodable { let forks: [CloudSessionForkSummary] }
private struct SessionPinResponse: Decodable { let pin: CloudSessionPin }
private struct UpdateSessionPinRequest: Encodable { let messageId: String?; let scope: String }
private struct MarkReadRequest: Encodable { let peerAccountId: String }
private struct ServerError: Decodable { let errorCode: String?; let message: String? }

private struct SendMessageRequest: Encodable {
    let peerAccountId: String
    let body: String
    let sessionId: String
    let clientCreatedAt: String
    let clientMessageId: String
    let attachments: [SendMessageAttachmentRequest]
}

private struct SendMessageAttachmentRequest: Encodable {
    let attachmentId: String
    let name: String
    let kind: String
    let mimeType: String?
    let sizeBytes: Int64?
    let previewUrl: String?
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
