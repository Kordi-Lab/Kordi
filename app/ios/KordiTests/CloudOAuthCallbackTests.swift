import XCTest
@testable import Kordi

final class CloudOAuthCallbackTests: XCTestCase {
    func testValidCloudResultDecodesFromNativeCallback() throws {
        let payload = Data(#"{"account":{"accountId":"acct_1","kordiId":"482731906","displayName":"Maya","primaryEmail":"maya@example.com","avatarUrl":null,"nodeId":null,"passwordSet":false},"session":{"token":"session_secret","expiresAt":"2026-09-08T00:00:00Z"}}"#.utf8)
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

final class SignupAvatarRendererTests: XCTestCase {
    func testGeneratedAvatarIsAcceptedWireShape() throws {
        let value = try XCTUnwrap(SignupAvatarRenderer.generatedDataURL(displayName: "Maya Chen", paletteIndex: 1))
        XCTAssertTrue(value.hasPrefix("data:image/png;base64,"))
        XCTAssertLessThan(value.utf8.count, 200_000 * 2)
        XCTAssertEqual(SignupAvatarRenderer.initials(for: "Maya Chen"), "MC")
    }
}
