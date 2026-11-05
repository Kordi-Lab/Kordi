import XCTest
@testable import Kordi

@MainActor
final class OrganizationSelectionTests: XCTestCase {
    private var suiteName = ""
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

    func testStoreOrdersPersonalFirstAndKeepsSelectionPerAccount() {
        let store = OrganizationSelectionStore(defaults: defaults)
        let listed = [organization("org_team", kind: "team"), organization("org_personal", kind: "personal")]

        store.apply(listed, accountId: "acct_a")
        XCTAssertEqual(store.organizations.map(\.organizationId), ["org_personal", "org_team"])
        XCTAssertEqual(store.selectedOrganizationId, "org_personal")
        XCTAssertNil(store.teamOrganizationId)
        XCTAssertTrue(store.showsSwitcher)

        store.select("org_team")
        XCTAssertEqual(store.teamOrganizationId, "org_team")
        XCTAssertEqual(defaults.string(forKey: OrganizationSelectionStore.storageKey(accountId: "acct_a")), "org_team")

        store.apply(listed, accountId: "acct_b")
        XCTAssertEqual(store.selectedOrganizationId, "org_personal")

        store.apply(listed, accountId: "acct_a")
        XCTAssertEqual(store.selectedOrganizationId, "org_team")
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
    }

    private func organization(_ id: String, kind: String) -> CloudOrganization {
        CloudOrganization(organizationId: id, name: id, kind: kind, role: "owner")
    }

    private func snapshot(organization: String) -> Data {
        Data(#"{"id":"conversation-group","kind":"group","shared_title":"Planning","version":1,"created_by_account_id":"acct_me","legacy_session_id":"session:group:space","group_space_id":"session:group:space","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":0,"created_at":"2026-11-04T00:00:00Z","updated_at":"2026-11-04T00:00:00Z","members":[],"preferences":{"conversation_id":"conversation-group","account_id":"acct_me","personal_title":null,"version":1}"#.utf8)
            + Data(organization.utf8) + Data("}".utf8)
    }
}
