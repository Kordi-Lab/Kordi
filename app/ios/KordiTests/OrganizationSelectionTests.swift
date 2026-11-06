import XCTest
@testable import Kordi

@MainActor
final class OrganizationSelectionTests: XCTestCase {
    private var suiteName = ""
    /// Whole seconds, so stored credentials compare equal after a round trip.
    private let now = Date(timeIntervalSince1970: Date().timeIntervalSince1970.rounded(.down))
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "organization-selection-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testOrganizationListDecodes() throws {
        let payload = Data(#"{"organizations":[{"organizationId":"org_personal","name":"Personal","kind":"personal","role":"owner","memberCount":1,"createdAt":"2026-11-04T00:00:00Z","memberOwnedContent":false,"membershipExpiresAt":null},{"organizationId":"org_team","name":"Example team","kind":"team","role":"member","memberCount":4,"createdAt":"2026-11-04T00:00:00Z","memberOwnedContent":true,"membershipExpiresAt":"2027-01-01T00:00:00Z"}]}"#.utf8)

        let organizations = try JSONDecoder().decode(CloudOrganizationsResponse.self, from: payload).organizations

        XCTAssertEqual(organizations.map(\.organizationId), ["org_personal", "org_team"])
        XCTAssertTrue(organizations[0].isPersonal)
        XCTAssertEqual(organizations[1].roleKind, .member)
        XCTAssertEqual(organizations[1].memberCount, 4)
        XCTAssertEqual(organizations[1].membershipExpiresAt, "2027-01-01T00:00:00Z")
    }

    func testOrganizationDecodesWithoutOptionalFields() throws {
        let payload = Data(#"{"organizationId":"org_team","name":"Example team","kind":"team","role":"admin"}"#.utf8)

        let organization = try JSONDecoder().decode(CloudOrganization.self, from: payload)

        XCTAssertFalse(organization.isPersonal)
        XCTAssertEqual(organization.roleKind, .admin)
        XCTAssertNil(organization.memberCount)
    }

    func testConversationSnapshotDecodesTeamOrganization() throws {
        let conversation = try JSONDecoder().decode(
            CloudChatConversation.self,
            from: snapshot(organization: #","organization":{"organization_id":"org_team","name":"Example team"}"#)
        )

        XCTAssertEqual(conversation.organization, CloudConversationOrganization(organizationId: "org_team", name: "Example team"))
        XCTAssertEqual(
            GroupOrganizationCatalog.name(groupSpaceId: "session:group:space", canonical: [conversation]),
            "Example team"
        )
    }

    func testConversationSnapshotWithoutOrganizationIsPersonal() throws {
        let conversation = try JSONDecoder().decode(CloudChatConversation.self, from: snapshot(organization: ""))

        XCTAssertNil(conversation.organization)
        XCTAssertNil(GroupOrganizationCatalog.name(groupSpaceId: "session:group:space", canonical: [conversation]))
    }

    func testCreateConversationRequestOmitsPersonalOrganization() throws {
        let personal = ChatCreateConversationRequest(
            clientOperationId: "op", kind: "group", sharedTitle: nil, clientSessionId: "session", memberAccountIds: []
        )
        let team = ChatCreateConversationRequest(
            clientOperationId: "op", kind: "group", sharedTitle: nil, clientSessionId: "session",
            memberAccountIds: [], organizationId: "org_team"
        )

        let personalBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(personal)) as? [String: Any])
        let teamBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(team)) as? [String: Any])

        XCTAssertNil(personalBody["organization_id"])
        XCTAssertEqual(teamBody["organization_id"] as? String, "org_team")
    }

    func testSelectionFallsBackToPersonalWhenStoredOrganizationIsMissing() {
        let organizations = [organization("org_team", kind: "team"), organization("org_personal", kind: "personal")]

        XCTAssertEqual(
            OrganizationSelectionStore.resolvedSelection(storedId: "org_gone", organizations: organizations),
            "org_personal"
        )
        XCTAssertEqual(
            OrganizationSelectionStore.resolvedSelection(storedId: nil, organizations: organizations),
            "org_personal"
        )
        XCTAssertEqual(
            OrganizationSelectionStore.resolvedSelection(storedId: "org_team", organizations: organizations),
            "org_team"
        )
        XCTAssertNil(OrganizationSelectionStore.resolvedSelection(storedId: "org_team", organizations: []))
    }

    func testStoreOrdersPersonalFirstAndKeepsSelectionPerAccount() async {
        let store = OrganizationSelectionStore(defaults: defaults)
        store.tokenSwitchOverride = { _, _ in true }
        let listed = [organization("org_team", kind: "team"), organization("org_personal", kind: "personal")]

        store.apply(listed, accountId: "acct_a")
        XCTAssertEqual(store.organizations.map(\.organizationId), ["org_personal", "org_team"])
        XCTAssertEqual(store.selectedOrganizationId, "org_personal")
        XCTAssertNil(store.teamOrganizationId)
        XCTAssertTrue(store.showsSwitcher)

        let switched = await store.choose("org_team")
        XCTAssertTrue(switched)
        XCTAssertEqual(store.teamOrganizationId, "org_team")
        XCTAssertEqual(defaults.string(forKey: OrganizationSelectionStore.storageKey(accountId: "acct_a")), "org_team")

        store.apply(listed, accountId: "acct_b")
        XCTAssertEqual(store.selectedOrganizationId, "org_personal")

        store.apply(listed, accountId: "acct_a")
        XCTAssertEqual(store.selectedOrganizationId, "org_team")
    }

    func testFailedTokenSwitchKeepsTheSelection() async {
        let store = OrganizationSelectionStore(defaults: defaults)
        var requested: [String] = []
        store.tokenSwitchOverride = { organizationId, _ in
            requested.append(organizationId)
            return false
        }
        store.apply([organization("org_personal", kind: "personal"), organization("org_team", kind: "team")], accountId: "acct_a")

        let switched = await store.choose("org_team")

        XCTAssertFalse(switched)
        XCTAssertEqual(requested, ["org_team"])
        XCTAssertEqual(store.selectedOrganizationId, "org_personal")
        XCTAssertNil(defaults.string(forKey: OrganizationSelectionStore.storageKey(accountId: "acct_a")))
    }

    func testStoreDropsStoredOrganizationTheAccountLeft() {
        let store = OrganizationSelectionStore(defaults: defaults)
        let key = OrganizationSelectionStore.storageKey(accountId: "acct_a")
        defaults.set("org_gone", forKey: key)

        store.apply([organization("org_personal", kind: "personal")], accountId: "acct_a")

        XCTAssertEqual(store.selectedOrganizationId, "org_personal")
        XCTAssertFalse(store.showsSwitcher)
        XCTAssertNil(defaults.string(forKey: key))
    }

    func testGroupStatusShowsTeamOrganizationOnly() {
        var conversation = ConversationSummary(
            id: "group:space", kind: .group, peerAccountId: "acct_peer", agentId: nil, ownerDisplayName: nil,
            displayName: "Planning", lastMessage: "", lastActivityAt: .distantPast, unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "space"
        )
        XCTAssertEqual(ConversationOrganizationLabel.groupStatus(for: conversation), "2 participants")

        conversation.organizationName = "Example team"
        XCTAssertEqual(ConversationOrganizationLabel.groupStatus(for: conversation), "Example team · 2 participants")

        let solo = ConversationSummary(
            id: "group:solo", kind: .group, peerAccountId: "acct_self", agentId: nil, ownerDisplayName: nil,
            displayName: "New group", lastMessage: "", lastActivityAt: .distantPast, unreadCount: 0,
            avatarSource: nil, agentActivity: nil, sessionId: "solo",
            groupParticipants: [CloudGroupParticipant(accountId: "acct_self", displayName: "Me", avatarUrl: nil, role: "self")]
        )
        XCTAssertEqual(ConversationOrganizationLabel.groupStatus(for: solo), "1 participant")
    }

    // MARK: Token switch

    func testSwitchSavesTheNewAccessTokenAndKeepsTheRefreshToken() async throws {
        let keychain = try seededKeychain(credential(signInId: "asi_1"))
        let store = sessionStore(keychain)
        let presented = PresentedTokens()

        let result = await store.switchOrganization(to: "org_team", from: start()) { token in
            await presented.append(token)
            return self.tokenResponse(signInId: "asi_1")
        }

        guard case .switched(let token, let expiresAt, let organizationId) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(token, "kordi_cs_team")
        XCTAssertNotNil(expiresAt)
        XCTAssertEqual(organizationId, "org_team")
        let presentedTokens = await presented.tokens
        XCTAssertEqual(presentedTokens, ["kordi_cs_old"])
        let stored = try XCTUnwrap(keychain.loadAppSignInCredential())
        XCTAssertEqual(stored.accessToken, "kordi_cs_team")
        XCTAssertEqual(stored.refreshToken, "kordi_rt_old")
        XCTAssertEqual(stored.signInId, "asi_1")
        XCTAssertEqual(stored.organizationId, "org_team")
        XCTAssertEqual(try keychain.loadToken(), "kordi_cs_team")
        let tokenOrganization = await store.tokenOrganization(for: "kordi_cs_team")
        XCTAssertEqual(tokenOrganization, "org_team")
    }

    func testRefreshKeepsTheSwitchedOrganization() async throws {
        let keychain = try seededKeychain(credential(expiresIn: 60, organizationId: "org_team"))
        let store = AppSignInSessionStore(keychain: keychain, transport: { request in
            let body = #"{"access_token":"kordi_cs_new","token_type":"Bearer","expires_in":3600,"refresh_token":"kordi_rt_new","device_id":"dev_1"}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, holdsBackgroundTime: false)

        guard case .refreshed(let next) = await store.refresh(ifExpiringWithin: 300) else { return XCTFail() }

        XCTAssertEqual(next.refreshToken, "kordi_rt_new")
        XCTAssertEqual(next.organizationId, "org_team")
        XCTAssertEqual(next.deviceId, "dev_1")
    }

    func testStaleSwitchNeverOverwritesANewerSignIn() async throws {
        let keychain = try seededKeychain(credential())
        let store = sessionStore(keychain)
        let newer = credential(access: "kordi_cs_newer", refresh: "kordi_rt_newer")

        let result = await store.switchOrganization(to: "org_team", from: start()) { _ in
            try keychain.saveAppSignInCredential(newer)
            try keychain.saveToken(newer.accessToken)
            return self.tokenResponse()
        }

        XCTAssertEqual(result, .superseded)
        XCTAssertEqual(try keychain.loadAppSignInCredential(), newer)
        XCTAssertEqual(try keychain.loadToken(), "kordi_cs_newer")
    }

    func testSwitchAfterSignOutSavesNothing() async throws {
        let keychain = try seededKeychain(credential())
        let store = sessionStore(keychain)

        let result = await store.switchOrganization(to: "org_team", from: start()) { _ in
            try keychain.deleteToken()
            return self.tokenResponse()
        }

        XCTAssertEqual(result, .superseded)
        XCTAssertNil(try keychain.loadAppSignInCredential())
        XCTAssertNil(try keychain.loadToken())
    }

    func testAnswerForAnotherAccountOrSignInIsRejected() async throws {
        let keychain = try seededKeychain(credential(signInId: "asi_1"))
        let store = sessionStore(keychain)

        let otherAccount = await store.switchOrganization(to: "org_team", from: start()) { _ in
            self.tokenResponse(accountId: "acct_b", signInId: "asi_1")
        }
        let otherSignIn = await store.switchOrganization(to: "org_team", from: start()) { _ in
            self.tokenResponse(signInId: "asi_2")
        }
        let otherOrganization = await store.switchOrganization(to: "org_team", from: start()) { _ in
            self.tokenResponse(organizationId: "org_other", signInId: "asi_1")
        }

        XCTAssertEqual(otherAccount, .failed)
        XCTAssertEqual(otherSignIn, .failed)
        XCTAssertEqual(otherOrganization, .failed)
        XCTAssertEqual(try keychain.loadAppSignInCredential(), credential(signInId: "asi_1"))
        XCTAssertEqual(try keychain.loadToken(), "kordi_cs_old")
    }

    func testSessionTokenSwitchRecordsTheOrganizationForThatTokenOnly() async throws {
        let keychain = try makeKeychain()
        try keychain.saveToken("kordi_cs_session")
        let store = sessionStore(keychain)

        let result = await store.switchOrganization(
            to: "org_team",
            from: OrganizationSwitchStart(accountId: "acct_a", accessToken: "kordi_cs_session")
        ) { token in
            CloudOrganizationTokenResponse(accessToken: token, accountId: "acct_a", organizationId: "org_team")
        }

        XCTAssertEqual(result, .switched(accessToken: "kordi_cs_session", expiresAt: nil, organizationId: "org_team"))
        let recorded = await store.tokenOrganization(for: "kordi_cs_session")
        let other = await store.tokenOrganization(for: "kordi_cs_other")
        XCTAssertEqual(recorded, "org_team")
        XCTAssertNil(other)
    }

    // MARK: Request header

    func testRequestsNameTheSelectedOrganizationOfTheActiveAccount() async throws {
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17083")!)
        await api.activateAccount("acct_a")
        await api.selectRequestOrganization(accountId: "acct_a", organizationId: "org_team")

        let scoped = try await api.makeRequest(path: "/v2/chat/sync/bootstrap", method: "GET", token: "kordi_cs_a", query: [], body: nil)
        let neutral = try await api.makeRequest(path: "/v1/cloud/organizations", method: "GET", token: "kordi_cs_a", query: [], body: nil)
        let anonymous = try await api.makeRequest(path: "/v2/chat/sync/bootstrap", method: "GET", token: nil, query: [], body: nil)
        await api.selectRequestOrganization(accountId: "acct_b", organizationId: "org_team")
        let otherAccount = try await api.makeRequest(path: "/v2/chat/sync/bootstrap", method: "GET", token: "kordi_cs_a", query: [], body: nil)

        XCTAssertEqual(scoped.value(forHTTPHeaderField: "Kordi-Organization"), "org_team")
        XCTAssertNil(neutral.value(forHTTPHeaderField: "Kordi-Organization"))
        XCTAssertNil(anonymous.value(forHTTPHeaderField: "Kordi-Organization"))
        XCTAssertNil(otherAccount.value(forHTTPHeaderField: "Kordi-Organization"))
    }

    func testOrganizationMismatchRetriesOnceWithTheRecoveredToken() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OrganizationMismatchStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        OrganizationMismatchStub.reset()
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17083")!, session: session)
        await api.activateAccount("acct_a")
        await api.selectRequestOrganization(accountId: "acct_a", organizationId: "org_personal")
        let reported = PresentedTokens()
        await api.setOrganizationMismatchHandler { organizationId, _ in
            await reported.append(organizationId ?? "")
            await api.selectRequestOrganization(accountId: "acct_a", organizationId: "org_team")
            return "kordi_cs_team"
        }

        try await api.sendWithoutResponse(path: "/v2/chat/sync/ack", method: "POST", token: "kordi_cs_old", fallback: "Failed.")

        let requests = OrganizationMismatchStub.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer kordi_cs_old", "Bearer kordi_cs_team"])
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Kordi-Organization") }, ["org_personal", "org_team"])
        let reportedOrganizations = await reported.tokens
        XCTAssertEqual(reportedOrganizations, ["org_team"])
    }

    private func makeKeychain() throws -> KeychainSessionStore {
        let suite = "kordi.tests.organization-switch.\(UUID().uuidString)"
        let keychain = KeychainSessionStore(service: suite, developmentDefaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        addTeardownBlock { try? keychain.deleteToken() }
        return keychain
    }

    private func seededKeychain(_ stored: AppSignInCredential) throws -> KeychainSessionStore {
        let keychain = try makeKeychain()
        try keychain.saveAppSignInCredential(stored)
        try keychain.saveToken(stored.accessToken)
        return keychain
    }

    private func sessionStore(_ keychain: KeychainSessionStore) -> AppSignInSessionStore {
        AppSignInSessionStore(keychain: keychain, transport: { _ in throw URLError(.notConnectedToInternet) }, holdsBackgroundTime: false)
    }

    private func start() -> OrganizationSwitchStart {
        OrganizationSwitchStart(accountId: "acct_a", accessToken: "kordi_cs_old")
    }

    private func credential(
        expiresIn: TimeInterval = 3_000,
        access: String = "kordi_cs_old",
        refresh: String = "kordi_rt_old",
        signInId: String? = nil,
        organizationId: String? = nil
    ) -> AppSignInCredential {
        AppSignInCredential(
            accountId: "acct_a",
            clientId: "kordi-ios-beta",
            tokenEndpoint: URL(string: "https://cloud.example.test/v1/cloud/auth/app/token")!,
            accessToken: access,
            refreshToken: refresh,
            expiresAt: now.addingTimeInterval(expiresIn),
            signInId: signInId,
            organizationId: organizationId
        )
    }

    nonisolated private func tokenResponse(
        accountId: String = "acct_a",
        organizationId: String = "org_team",
        signInId: String? = nil
    ) -> CloudOrganizationTokenResponse {
        CloudOrganizationTokenResponse(
            accessToken: "kordi_cs_team", expiresIn: 3_600, accountId: accountId,
            deviceId: "dev_1", signInId: signInId, organizationId: organizationId
        )
    }

    private func organization(_ id: String, kind: String) -> CloudOrganization {
        CloudOrganization(organizationId: id, name: id, kind: kind, role: "owner")
    }

    private func snapshot(organization: String) -> Data {
        Data(#"{"id":"conversation-group","kind":"group","shared_title":"Planning","version":1,"created_by_account_id":"acct_me","legacy_session_id":"session:group:space","group_space_id":"session:group:space","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":0,"created_at":"2026-11-04T00:00:00Z","updated_at":"2026-11-04T00:00:00Z","members":[],"preferences":{"conversation_id":"conversation-group","account_id":"acct_me","personal_title":null,"version":1}"#.utf8)
            + Data(organization.utf8) + Data("}".utf8)
    }
}

private actor PresentedTokens {
    private(set) var tokens: [String] = []
    func append(_ token: String) { tokens.append(token) }
}

/// Answers the first request with `409 organization_mismatch` and the next with success.
private final class OrganizationMismatchStub: URLProtocol {
    private static let lock = NSLock()
    private static var recorded: [URLRequest] = []

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    static func reset() {
        lock.lock()
        recorded = []
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.recorded.append(request)
        let count = Self.recorded.count
        Self.lock.unlock()
        let mismatch = count == 1
        let body = mismatch
            ? #"{"errorCode":"organization_mismatch","message":"Your organization changed. Refresh and try again.","organizationId":"org_team"}"#
            : "{}"
        let response = HTTPURLResponse(url: request.url!, statusCode: mismatch ? 409 : 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
