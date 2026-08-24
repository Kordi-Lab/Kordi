import XCTest
@testable import Kordi

final class CloudOAuthCallbackTests: XCTestCase {
    func testValidCloudResultDecodesFromNativeCallback() throws {
        let payload = Data(#"{"account":{"accountId":"acct_1","kordiId":"482731906","displayName":"Maya","primaryEmail":"maya@example.com","avatarUrl":"kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/acct_1?version=1","avatar":{"entityType":"human","entityId":"acct_1","source":"generated","style":"lorelei","seed":"acct_1","rendererVersion":"dicebear-rust-10.6.0-styles-10.5.0","uploadedAsset":null,"version":1,"updatedAt":"2026-08-19T00:00:00Z"},"nodeId":null,"passwordSet":false},"session":{"token":"session_secret","expiresAt":"2026-09-08T00:00:00Z"}}"#.utf8)
        let encoded = payload.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let callback = try XCTUnwrap(URL(
            string: "\(CloudOAuthCallbackParser.callbackURL.absoluteString)#kordi_cloud_oauth=\(encoded)"
        ))

        let result = try CloudOAuthCallbackParser.parse(callback)

        XCTAssertEqual(result.account.accountId, "acct_1")
        XCTAssertEqual(result.session.token, "session_secret")
    }

    func testCallbackRejectsWrongHostEvenWithValidLookingFragment() {
        let scheme = CloudOAuthCallbackParser.callbackURL.scheme!
        let callback = URL(string: "\(scheme)://attacker/callback#kordi_cloud_oauth=e30")!
        XCTAssertThrowsError(try CloudOAuthCallbackParser.parse(callback))
    }

    func testProviderErrorIsSurfaced() {
        let callback = URL(
            string: "\(CloudOAuthCallbackParser.callbackURL.absoluteString)#kordi_cloud_oauth_error=Access%20denied"
        )!
        XCTAssertThrowsError(try CloudOAuthCallbackParser.parse(callback)) { error in
            XCTAssertEqual(error as? CloudOAuthSessionError, .provider("Access denied"))
        }
    }

    func testProductCallbackRejectsBetaCallback() {
        let callback = URL(string: "kordi-beta://oauth/callback#kordi_cloud_oauth=e30")!
        let productCallback = URL(string: "kordi://oauth/callback")!

        XCTAssertThrowsError(
            try CloudOAuthCallbackParser.parse(callback, expectedCallbackURL: productCallback)
        )
    }
}

final class CloudAPIClientAccountActivationTests: XCTestCase {
    func testSignupSendsUploadedAvatarMutation() async throws {
        SignupAvatarURLProtocol.body = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SignupAvatarURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
        let uploadedAsset = "data:image/jpeg;base64,YXZhdGFy"

        _ = try await client.signup(
            email: "avatar@example.com",
            password: "password123",
            displayName: "Avatar",
            avatarSeed: "signup_seed",
            avatarMutation: .upload(uploadedAsset, expectedVersion: nil)
        )

        let body = try XCTUnwrap(SignupAvatarURLProtocol.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let mutation = try XCTUnwrap(json["avatarMutation"] as? [String: Any])
        XCTAssertEqual(mutation["action"] as? String, "upload")
        XCTAssertEqual(mutation["uploadedAsset"] as? String, uploadedAsset)
    }

    func testOAuthAccountActivationAllowsReliableChatBootstrap() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ChatBootstrapURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        do {
            _ = try await client.bootstrapChatLatestMessages(token: "oauth-session")
            XCTFail("Chat bootstrap should require the authenticated account context.")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "account_missing")
        }

        await client.activateAccount("acct_oauth")

        let messages = try await client.bootstrapChatLatestMessages(token: "oauth-session")
        XCTAssertTrue(messages.isEmpty)
    }

    func testConversationHistoryPageUsesOneBoundedCursorRequest() async throws {
        HistoryPageURLProtocol.historyRequest = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HistoryPageURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
        await client.activateAccount("acct_me")

        let page = try await client.conversationMessagePage(
            token: "oauth-session",
            sessionId: "session:agent:history",
            beforeSequence: 42,
            limit: 64
        )

        let request = try XCTUnwrap(HistoryPageURLProtocol.historyRequest)
        let query = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        XCTAssertEqual(query.queryItems?.first(where: { $0.name == "limit" })?.value, "64")
        XCTAssertEqual(query.queryItems?.first(where: { $0.name == "before_sequence" })?.value, "42")
        XCTAssertEqual(page.messages.map(\.messageId), ["message-41"])
        XCTAssertEqual(page.nextBeforeSequence, 41)
        XCTAssertTrue(page.hasMore)
    }

    func testGroupBootstrapProjectsTheActualReaderInsteadOfTheFirstPeer() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GroupReadBootstrapURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        let response = try await client.sync(token: "oauth-session", cursor: "0")
        let message = try XCTUnwrap(response.events.compactMap(\.payload?.message).first)

        XCTAssertEqual(message.toAccountId, "acct_first_peer")
        XCTAssertEqual(message.readByAccountIds, ["acct_actual_reader"])
        XCTAssertNotNil(message.readAt)
    }

    func testAgentDefinitionEventsTriggerDirectoryRefreshProjection() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentDefinitionSyncURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        let response = try await client.sync(token: "oauth-session", cursor: "41")

        XCTAssertEqual(response.cursor, "42")
        XCTAssertEqual(response.events.map(\.eventType), ["agent.definition.upserted"])
    }

    func testProviderAuthenticationEventsReachTheAppModelProjection() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderAuthenticationSyncURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        let response = try await client.sync(token: "oauth-session", cursor: "42")

        XCTAssertEqual(response.cursor, "43")
        XCTAssertEqual(response.events.map(\.eventType), ["provider-auth.updated"])
    }

    func testSessionPinEventsReachTheAppModelProjection() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionPinSyncURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        let response = try await client.sync(token: "oauth-session", cursor: "43")
        let event = try XCTUnwrap(response.events.first)

        XCTAssertEqual(response.cursor, "44")
        XCTAssertEqual(event.eventType, "session.pin.updated")
        XCTAssertEqual(event.payload?.sessionId, "session:group")
        XCTAssertEqual(event.payload?.messageId, "message-1")
        XCTAssertEqual(event.payload?.scope, "shared")
        XCTAssertEqual(event.payload?.updatedAt, "2026-08-17T12:00:01Z")
    }

    func testSessionPinPathEncodesTheSessionExactlyOnce() async throws {
        SessionPinMutationURLProtocol.request = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionPinMutationURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )

        _ = try await client.updateSessionPin(
            token: "oauth-session",
            sessionId: "session:direct-person:acct_a:acct_b",
            messageId: "message-1",
            scope: "private"
        )

        let url = try XCTUnwrap(SessionPinMutationURLProtocol.request?.url)
        let path = try XCTUnwrap(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
        )
        XCTAssertEqual(
            path,
            "/v1/cloud/sessions/session%3Adirect-person%3Aacct_a%3Aacct_b/pin"
        )
        XCTAssertFalse(path.contains("%253A"))
    }
}

final class CloudPresencePublisherTests: XCTestCase {
    @MainActor
    func testForegroundHeartbeatAndSignOutPublishPresenceLifecycle() async throws {
        let requestsReceived = expectation(description: "Presence online and heartbeat requests")
        requestsReceived.expectedFulfillmentCount = 2
        PresenceURLProtocol.reset(expectation: requestsReceived)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PresenceURLProtocol.self]
        let client = CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
        let publisher = CloudPresencePublisher(
            api: client,
            heartbeatInterval: .milliseconds(100)
        )

        publisher.start(token: "test-session")
        await fulfillment(of: [requestsReceived], timeout: 1)
        await publisher.stopAndPublishOffline(token: "test-session")

        XCTAssertEqual(
            PresenceURLProtocol.requests(),
            [
                PresenceRequest(path: "/v1/cloud/presence/online", method: "POST", authorization: "Bearer test-session"),
                PresenceRequest(path: "/v1/cloud/presence/heartbeat", method: "POST", authorization: "Bearer test-session"),
                PresenceRequest(path: "/v1/cloud/presence/offline", method: "POST", authorization: "Bearer test-session"),
            ]
        )
    }
}

private struct PresenceRequest: Equatable {
    let path: String
    let method: String
    let authorization: String?
}

private final class PresenceURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var recordedRequests: [PresenceRequest] = []
    private static var requestExpectation: XCTestExpectation?

    static func reset(expectation: XCTestExpectation) {
        lock.lock()
        recordedRequests = []
        requestExpectation = expectation
        lock.unlock()
    }

    static func requests() -> [PresenceRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recordedRequests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let presenceRequest = PresenceRequest(
            path: request.url?.path ?? "",
            method: request.httpMethod ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization")
        )
        Self.lock.lock()
        Self.recordedRequests.append(presenceRequest)
        let expectation = Self.requestExpectation
        if Self.recordedRequests.count == 2 {
            Self.requestExpectation = nil
        }
        Self.lock.unlock()
        expectation?.fulfill()

        let offline = presenceRequest.path.hasSuffix("/offline")
        let payload = Data(
            (offline
                ? #"{"accountId":"acct_me","status":"offline","lastSeenAt":"2026-08-23T12:00:00Z"}"#
                : #"{"accountId":"acct_me","status":"online","lastSeenAt":null}"#
            ).utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SignupAvatarURLProtocol: URLProtocol {
    static var body: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.body = request.httpBody ?? request.httpBodyStream.flatMap { stream in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            return data
        }
        let payload = Data(#"{"account":{"accountId":"acct_signup","kordiId":"482731906","displayName":"Avatar","primaryEmail":"avatar@example.com","avatarUrl":"data:image/jpeg;base64,YXZhdGFy","avatar":{"entityType":"human","entityId":"acct_signup","source":"uploaded","style":"lorelei","seed":"signup_seed","rendererVersion":"dicebear-rust-10.6.0-styles-10.5.0","uploadedAsset":"data:image/jpeg;base64,YXZhdGFy","version":2,"updatedAt":"2026-08-20T00:00:00Z"},"nodeId":null,"passwordSet":true},"session":{"token":"session_secret","expiresAt":"2026-09-08T00:00:00Z","deviceId":"device_signup"}}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 201,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ChatBootstrapURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload = Data(
            #"{"protocol_version":2,"conversations":[],"latest_messages":[],"next_cursor":"0","last_stream_seq":0,"server_time":"2026-08-15T00:00:00Z"}"#.utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class GroupReadBootstrapURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload = Data(#"{"protocol_version":2,"conversations":[{"id":"conversation-group-reader","kind":"group","shared_title":"Readers","version":1,"created_by_account_id":"acct_me","legacy_session_id":"session:group:reader","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":8,"created_at":"2026-08-23T10:00:00Z","updated_at":"2026-08-23T10:01:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":8,"last_read_sequence":8,"joined_at":"2026-08-23T10:00:00Z","left_at":null},{"account_id":"acct_first_peer","display_name":"First Peer","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":8,"last_read_sequence":0,"joined_at":"2026-08-23T10:00:00Z","left_at":null},{"account_id":"acct_actual_reader","display_name":"Actual Reader","avatar_url":null,"role":"member","membership_state":"active","version":1,"last_delivered_sequence":8,"last_read_sequence":8,"joined_at":"2026-08-23T10:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-group-reader","account_id":"acct_me","personal_title":null,"version":1}}],"latest_messages":[{"id":"message-8","client_message_id":"client-8","conversation_id":"conversation-group-reader","conversation_sequence":8,"sender_account_id":"acct_me","kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"Hello"}],"legacy_attachments":[]},"reply_to_message_id":null,"attachment_ids":[],"version":1,"generation_status":null,"provider_response_id":null,"created_at":"2026-08-23T10:01:00Z","edited_at":null,"deleted_at":null}],"next_cursor":"8","last_stream_seq":8,"server_time":"2026-08-23T10:02:00Z"}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class HistoryPageURLProtocol: URLProtocol {
    static var historyRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let isHistory = request.url?.path.hasSuffix("/messages") == true
        if isHistory { Self.historyRequest = request }
        let payload = isHistory
            ? Data(#"{"messages":[{"id":"message-41","client_message_id":"client-41","conversation_id":"conversation-history","conversation_sequence":41,"sender_account_id":"acct_me","kind":"message","content":{"schema":1,"blocks":[{"type":"text","text":"Saved history"}],"legacy_attachments":[]},"reply_to_message_id":null,"attachment_ids":[],"version":1,"generation_status":null,"provider_response_id":null,"created_at":"2026-08-21T00:00:00Z","edited_at":null,"deleted_at":null}],"next_before_sequence":41,"has_more":true}"#.utf8)
            : Data(#"{"protocol_version":2,"conversations":[{"id":"conversation-history","kind":"ai","shared_title":"History","version":1,"created_by_account_id":"acct_me","legacy_session_id":"session:agent:history","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":41,"created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:00:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":41,"last_read_sequence":41,"joined_at":"2026-08-21T00:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-history","account_id":"acct_me","personal_title":null,"version":1}}],"latest_messages":[],"next_cursor":"0","last_stream_seq":0,"server_time":"2026-08-21T00:00:00Z"}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class AgentDefinitionSyncURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload = Data(
            #"{"protocol_version":2,"events":[{"stream_seq":42,"event_id":"event_agent_route","protocol_version":2,"type":"agent.definition.upserted","critical":false,"conversation_id":null,"entity_id":"agent_1","entity_version":2,"occurred_at":"2026-08-16T12:00:00Z","payload":{}}],"next_cursor":"42","last_stream_seq":42,"has_more":false,"server_time":"2026-08-16T12:00:00Z"}"#.utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ProviderAuthenticationSyncURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload = Data(
            #"{"protocol_version":2,"events":[{"stream_seq":43,"event_id":"event_provider_auth","protocol_version":2,"type":"provider-auth.updated","critical":true,"conversation_id":null,"entity_id":null,"entity_version":null,"occurred_at":"2026-08-17T12:00:00Z","payload":{"action":"published","provider":"openai-codex","snapshotId":"snap_1"}}],"next_cursor":"43","last_stream_seq":43,"has_more":false,"server_time":"2026-08-17T12:00:00Z"}"#.utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SessionPinSyncURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload = Data(
            #"{"protocol_version":2,"events":[{"stream_seq":44,"event_id":"event_session_pin","protocol_version":2,"type":"session.pin.updated","critical":true,"conversation_id":"conversation-group","entity_id":null,"entity_version":null,"occurred_at":"2026-08-17T12:00:01Z","payload":{"sessionId":"session:group","messageId":"message-1","scope":"shared","updatedAt":"2026-08-17T12:00:01Z"}}],"next_cursor":"44","last_stream_seq":44,"has_more":false,"server_time":"2026-08-17T12:00:01Z"}"#.utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SessionPinMutationURLProtocol: URLProtocol {
    static var request: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.request = request
        let payload = Data(
            #"{"pin":{"sessionId":"session:direct-person:acct_a:acct_b","sharedMessageId":null,"privateMessageId":"message-1","effectiveMessageId":"message-1","updatedAt":"2026-08-24T12:00:00Z"}}"#.utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class SignupAvatarPreviewTests: XCTestCase {
    func testSignupPreviewUsesThePinnedLoreleiRenderer() throws {
        let preview = try XCTUnwrap(CanonicalAvatarSystem.previewURL(
            style: CanonicalAvatarSystem.humanStyle,
            seed: "signup_seed",
            baseURL: URL(string: "http://127.0.0.1:17081")!
        ))
        XCTAssertEqual(
            preview.absoluteString,
            "http://127.0.0.1:17081/v1/avatars/preview/lorelei/signup_seed.png"
        )
    }
}
