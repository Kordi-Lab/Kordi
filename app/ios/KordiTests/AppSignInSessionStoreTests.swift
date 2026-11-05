import XCTest
@testable import Kordi

/// Records requests and answers them in order.
private actor FakeTransport {
    struct Reply {
        var status: Int
        var body: String
        var delay: Duration = .zero
        var fails = false
    }

    private var replies: [Reply]
    private(set) var requests: [URLRequest] = []

    init(_ replies: [Reply]) { self.replies = replies }

    func handle(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let reply = replies.isEmpty ? Reply(status: 200, body: "{}") : replies.removeFirst()
        if reply.delay > .zero { try await Task.sleep(for: reply.delay) }
        if reply.fails { throw URLError(.notConnectedToInternet) }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
        return (Data(reply.body.utf8), response)
    }

    func paths() -> [String] { requests.map { $0.url?.path ?? "" } }

    func formField(_ name: String, at index: Int) -> String? {
        guard requests.indices.contains(index), let body = requests[index].httpBody,
              let text = String(data: body, encoding: .utf8) else { return nil }
        return URLComponents(string: "?\(text)")?.queryItems?.first { $0.name == name }?.value
    }
}

final class AppSignInSessionStoreTests: XCTestCase {
    private let endpoint = URL(string: "https://cloud.example.test/v1/cloud/auth/app/token")!
    private var keychain: KeychainSessionStore!

    override func setUp() {
        super.setUp()
        let suite = "kordi.tests.app-sign-in.\(UUID().uuidString)"
        keychain = KeychainSessionStore(service: suite, developmentDefaults: UserDefaults(suiteName: suite)!)
    }

    override func tearDown() {
        try? keychain.deleteToken()
        super.tearDown()
    }

    private func credential(expiresIn: TimeInterval = 60, access: String = "kordi_cs_old", refresh: String = "kordi_rt_old") -> AppSignInCredential {
        AppSignInCredential(
            accountId: "acct_1",
            clientId: "kordi-ios-beta",
            tokenEndpoint: endpoint,
            accessToken: access,
            refreshToken: refresh,
            expiresAt: Date().addingTimeInterval(expiresIn)
        )
    }

    private func tokens(_ suffix: String) -> String {
        #"{"access_token":"kordi_cs_\#(suffix)","token_type":"Bearer","expires_in":3600,"refresh_token":"kordi_rt_\#(suffix)"}"#
    }

    private func store(_ transport: FakeTransport) -> AppSignInSessionStore {
        AppSignInSessionStore(keychain: keychain, transport: { try await transport.handle($0) }, holdsBackgroundTime: false)
    }

    private func seed(_ stored: AppSignInCredential) throws {
        try keychain.saveAppSignInCredential(stored)
        try keychain.saveToken(stored.accessToken)
    }

    func testConcurrentRefreshesShareOneRequest() async throws {
        try seed(credential())
        let transport = FakeTransport([.init(status: 200, body: tokens("new"), delay: .milliseconds(200))])
        let store = store(transport)

        async let first = store.refresh(ifExpiringWithin: 300)
        async let second = store.refresh(ifExpiringWithin: 300)
        let results = await [first, second]

        let paths = await transport.paths()
        XCTAssertEqual(paths, ["/v1/cloud/auth/app/token"])
        for result in results {
            guard case .refreshed(let next) = result else { return XCTFail("\(result)") }
            XCTAssertEqual(next.refreshToken, "kordi_rt_new")
        }
        XCTAssertEqual(try keychain.loadToken(), "kordi_cs_new")
        XCTAssertEqual(try keychain.loadAppSignInCredential()?.refreshToken, "kordi_rt_new")
    }

    func testAFreshTokenIsNotRefreshed() async throws {
        try seed(credential(expiresIn: 3_000))
        let transport = FakeTransport([])
        guard case .current = await store(transport).refresh(ifExpiringWithin: 300) else { return XCTFail() }
        let paths = await transport.paths()
        XCTAssertTrue(paths.isEmpty)
    }

    func testSignOutDuringARefreshWinsAndRevokesTheNewTokens() async throws {
        try seed(credential())
        let transport = FakeTransport([.init(status: 200, body: tokens("new"), delay: .milliseconds(300))])
        let store = store(transport)

        async let refresh = store.refresh(ifExpiringWithin: 300)
        try await Task.sleep(for: .milliseconds(100))
        let taken = await store.take()
        let result = await refresh

        XCTAssertEqual(taken?.refreshToken, "kordi_rt_old")
        XCTAssertEqual(result, .notBrowserSession)
        XCTAssertNil(try keychain.loadAppSignInCredential())
        let paths = await transport.paths()
        XCTAssertEqual(paths, ["/v1/cloud/auth/app/token", "/v1/cloud/auth/app/revoke"])
        let revoked = await transport.formField("token", at: 1)
        XCTAssertEqual(revoked, "kordi_rt_new")
    }

    func testRefusedRefreshIsRejectedAndOtherFailuresAreUnavailable() async throws {
        let cases: [(FakeTransport.Reply, AppSignInSessionStore.RefreshResult)] = [
            (.init(status: 400, body: #"{"error":"invalid_grant"}"#), .rejected),
            (.init(status: 401, body: #"{"error":"invalid_client"}"#), .rejected),
            (.init(status: 400, body: #"{"error":"invalid_request"}"#), .unavailable),
            (.init(status: 429, body: #"{"error":"rate_limited"}"#), .unavailable),
            (.init(status: 503, body: "<html>"), .unavailable),
            (.init(status: 200, body: "{}"), .unavailable),
            (.init(status: 0, body: "", fails: true), .unavailable),
        ]
        for (reply, expected) in cases {
            try seed(credential())
            let result = await store(FakeTransport([reply])).refresh(ifExpiringWithin: 300)
            XCTAssertEqual(result, expected, "\(reply)")
            // Nothing is thrown away until the caller signs out.
            XCTAssertEqual(try keychain.loadAppSignInCredential()?.refreshToken, "kordi_rt_old")
        }
    }

    func testLaunchKeepsOnlyTheSignInOfTheStoredTokenOnThisServer() async throws {
        let origin = URL(string: "https://cloud.example.test")!

        try seed(credential())
        let matching = FakeTransport([])
        let kept = await store(matching).launchCredential(origin: origin)
        XCTAssertEqual(kept?.refreshToken, "kordi_rt_old")

        // A refresh saved the credential but not the session token: repair it.
        try seed(credential())
        try keychain.saveToken("kordi_cs_stale")
        let halfWritten = FakeTransport([])
        let repaired = await store(halfWritten).launchCredential(origin: origin)
        XCTAssertEqual(repaired?.accessToken, "kordi_cs_old")
        XCTAssertEqual(try keychain.loadToken(), "kordi_cs_old")
        let halfWrittenPaths = await halfWritten.paths()
        XCTAssertTrue(halfWrittenPaths.isEmpty)

        try seed(credential())
        let defaultPort = await store(FakeTransport([])).launchCredential(origin: URL(string: "https://cloud.example.test:443")!)
        XCTAssertNotNil(defaultPort, "an explicit default port is the same origin")

        try seed(credential())
        let otherServer = FakeTransport([])
        let foreign = await store(otherServer).launchCredential(origin: URL(string: "http://127.0.0.1:17081")!)
        XCTAssertNil(foreign)
        XCTAssertNil(try keychain.loadAppSignInCredential())
        let otherServerPaths = await otherServer.paths()
        XCTAssertTrue(otherServerPaths.isEmpty)
    }

    func testOriginsTreatAnExplicitDefaultPortAsNone() {
        let same = AppSignInSessionStore.sameOrigin
        XCTAssertTrue(same(URL(string: "https://kordi.ai:443/v1/cloud/auth/app/token")!, URL(string: "https://kordi.ai")!))
        XCTAssertTrue(same(URL(string: "http://127.0.0.1:17081/x")!, URL(string: "http://127.0.0.1:17081")!))
        XCTAssertFalse(same(URL(string: "https://kordi.ai:8443/x")!, URL(string: "https://kordi.ai")!))
        XCTAssertFalse(same(URL(string: "http://kordi.ai/x")!, URL(string: "https://kordi.ai")!))
    }

    func testDeletingTheSessionTokenRemovesTheSignInToo() throws {
        try seed(credential())
        try keychain.deleteToken()
        XCTAssertNil(try keychain.loadToken())
        XCTAssertNil(try keychain.loadAppSignInCredential())
    }

    func testSavingReplacesTheStoredCredential() throws {
        try keychain.saveAppSignInCredential(credential(refresh: "kordi_rt_1"))
        try keychain.saveAppSignInCredential(credential(refresh: "kordi_rt_2"))
        XCTAssertEqual(try keychain.loadAppSignInCredential()?.refreshToken, "kordi_rt_2")
    }

    func testOnlyAnEndedSessionDiscardsTheStoredSignInAtLaunch() {
        XCTAssertTrue(AppModel.sessionEnded(by: CloudAPIError(code: "invalid_session", message: "", statusCode: 401)))
        XCTAssertTrue(AppModel.sessionEnded(by: CloudAPIError(code: "account_missing", message: "", statusCode: 404)))
        XCTAssertTrue(AppModel.sessionEnded(by: CloudAPIError(code: "unauthorized", message: "", statusCode: 401)))
        XCTAssertFalse(AppModel.sessionEnded(by: CloudAPIError(code: "network_error", message: "", statusCode: 0)))
        XCTAssertFalse(AppModel.sessionEnded(by: CloudAPIError(code: "server_error", message: "", statusCode: 503)))
        XCTAssertFalse(AppModel.sessionEnded(by: URLError(.timedOut)))
    }
}

final class AppSignInExchangeTests: XCTestCase {
    private func client(_ transport: FakeTransport) -> AppSignInClient {
        AppSignInClient(
            baseURL: URL(string: "https://cloud.example.test")!,
            clientId: "kordi-ios-beta",
            redirectURI: "kordi-beta://auth/callback",
            transport: { try await transport.handle($0) }
        )
    }

    private let pkce = AppSignInPKCE(verifier: "verifier", challenge: "challenge", state: "state")

    func testExchangeReturnsTheAccountAndCredential() async throws {
        let body = #"{"access_token":"kordi_cs_a","expires_in":3600,"refresh_token":"kordi_rt_a","device_id":"dev_1","account":{"accountId":"acct_1","kordiId":"482731906","displayName":"Ada","primaryEmail":"ada@example.test","avatarUrl":"kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/acct_1?version=1","avatar":{"entityType":"human","entityId":"acct_1","source":"generated","style":"lorelei","seed":"acct_1","rendererVersion":"dicebear-rust-10.6.0-styles-10.5.0","uploadedAsset":null,"version":1,"updatedAt":"2026-08-19T00:00:00Z"},"nodeId":null,"passwordSet":false}}"#
        let transport = FakeTransport([.init(status: 200, body: body)])
        let now = Date(timeIntervalSince1970: 1_000)
        let grant = try await client(transport).exchange(code: " code-1 ", pkce: pkce, device: nil, now: now)

        XCTAssertEqual(grant.account.accountId, "acct_1")
        XCTAssertEqual(grant.deviceId, "dev_1")
        XCTAssertEqual(grant.credential.refreshToken, "kordi_rt_a")
        XCTAssertEqual(grant.credential.expiresAt, now.addingTimeInterval(3600))
        XCTAssertEqual(grant.authResponse.session.token, "kordi_cs_a")
        let code = await transport.formField("code", at: 0)
        let verifier = await transport.formField("code_verifier", at: 0)
        let redirect = await transport.formField("redirect_uri", at: 0)
        XCTAssertEqual(code, "code-1")
        XCTAssertEqual(verifier, "verifier")
        XCTAssertEqual(redirect, "kordi-beta://auth/callback")
    }

    func testExchangeErrorsMapToSignInMessages() async {
        let cases: [(FakeTransport.Reply, String)] = [
            (.init(status: 400, body: #"{"error":"invalid_grant"}"#), "sign_in_code_invalid"),
            (.init(status: 429, body: #"{"error":"rate_limited"}"#), "rate_limited"),
            (.init(status: 500, body: ""), "server_error"),
            (.init(status: 403, body: #"{"error":"access_denied","message":"Not admitted."}"#), "browser_sign_in_failed"),
            (.init(status: 200, body: #"{"access_token":"kordi_cs_a"}"#), "browser_sign_in_failed"),
            (.init(status: 0, body: "", fails: true), "network_error"),
        ]
        for (reply, code) in cases {
            do {
                _ = try await client(FakeTransport([reply])).exchange(code: "c", pkce: pkce, device: nil)
                XCTFail("\(reply)")
            } catch {
                XCTAssertEqual((error as? CloudAPIError)?.code, code, "\(reply)")
            }
        }
        XCTAssertEqual(
            AppSignInClient.exchangeError(status: 403, body: Data(#"{"message":"Not admitted."}"#.utf8)).message,
            "Not admitted."
        )
    }
}

final class CloudSessionIdentityTests: XCTestCase {
    func testRotatedTokensStayInTheSameSignIn() {
        var identity = CloudSessionIdentity()
        XCTAssertFalse(identity.contains("kordi_cs_1"))

        identity.follow("kordi_cs_1")
        identity.follow("kordi_cs_2")
        XCTAssertTrue(identity.contains("kordi_cs_1"), "work started before a refresh is still current")
        XCTAssertTrue(identity.contains("kordi_cs_2"))

        identity.follow(nil)
        XCTAssertFalse(identity.contains("kordi_cs_1"))
        XCTAssertFalse(identity.contains("kordi_cs_2"))
        XCTAssertFalse(identity.contains(nil))

        identity.follow("kordi_cs_3")
        XCTAssertFalse(identity.contains("kordi_cs_2"), "a new sign-in does not adopt an old one's work")
        XCTAssertTrue(identity.contains("kordi_cs_3"))
    }
}
