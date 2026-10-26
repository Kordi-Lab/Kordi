import XCTest
@testable import Kordi

final class SystemAccountIdentityTests: XCTestCase {
    private let planJSON = #"""
    {"eventId":"plan","revision":3,"state":"polling","title":"Dinner","managerIds":["acct_me"],
     "participants":[
       {"participantId":"acct_me","displayName":"Shu Yang","organizer":true,"rsvp":"yes"},
       {"participantId":"acct_maya","displayName":"Maya","organizer":false,"rsvp":"pending"},
       {"participantId":"acct_kordi_system","displayName":"System","organizer":false,"rsvp":"pending"},
       {"participantId":"acct_kordi_pip","displayName":"System","organizer":false,"rsvp":"pending"}
     ]}
    """#

    func testDirectPlanCardNoticeFromOrganizerShowsAsSystem() throws {
        let conversation = makeDirect()
        var wire = makeWire(id: "plan", from: "acct_me", to: "acct_maya", kind: KordiSystemIdentity.messageKind)
        wire.planCard = try JSONDecoder().decode(PlanCard.self, from: Data(planJSON.utf8))
        let reply = makeWire(id: "mine", from: "acct_me", to: "acct_maya", kind: nil)

        let projected = CloudDirectMessageProjector.project([wire, reply], conversation: conversation, ownAccountId: "acct_me")
        let notice = try XCTUnwrap(projected.first { $0.id == "plan" })
        let own = try XCTUnwrap(projected.first { $0.id == "mine" })

        XCTAssertEqual(notice.author, .person)
        XCTAssertEqual(notice.authorName, KordiSystemIdentity.displayName)
        XCTAssertNotNil(notice.planCard)
        XCTAssertEqual(own.author, .me)
        let identity = MessageAuthorIdentity.resolve(notice, in: conversation, account: nil, mentionTargets: [])
        XCTAssertTrue(KordiSystemIdentity.matches(seed: identity.seed))
        XCTAssertFalse(KordiSystemAgentIdentity.matches(name: identity.name, seed: identity.seed))
    }

    func testDirectNoticeFromPeerShowsAsSystem() throws {
        let wire = makeWire(id: "plan", from: "acct_maya", to: "acct_me", kind: KordiSystemIdentity.messageKind)

        let projected = CloudDirectMessageProjector.project([wire], conversation: makeDirect(), ownAccountId: "acct_me")
        let notice = try XCTUnwrap(projected.first)

        XCTAssertEqual(notice.author, .person)
        XCTAssertEqual(notice.authorName, KordiSystemIdentity.displayName)
    }

    func testGroupNoticeSentByViewerIsNotOwnBubble() throws {
        let conversation = makeGroup()
        let notice = makeWire(
            id: "notice", from: "acct_me", to: "acct_maya", kind: KordiSystemIdentity.messageKind,
            sessionId: "session:group:mobile"
        )
        let own = makeWire(id: "own", from: "acct_me", to: "acct_maya", kind: nil, sessionId: "session:group:mobile")

        let projected = AppModel.mapGroupMessages(
            AppModel.groupWireMessages(for: conversation, in: [notice, own]),
            conversation: conversation,
            ownAccountId: "acct_me"
        )
        let message = try XCTUnwrap(projected.first { $0.id == "notice" })

        XCTAssertEqual(message.author, .person)
        XCTAssertEqual(message.authorName, KordiSystemIdentity.displayName)
        XCTAssertEqual(projected.first { $0.id == "own" }?.author, .me)
    }

    func testMessageFromSystemAccountIsNamedSystem() {
        XCTAssertEqual(KordiSystemIdentity.groupAuthorName(
            messageKind: nil, fromAccountId: KordiSystemIdentity.accountId,
            participantNames: [:], fallback: "Mobile builders"
        ), KordiSystemIdentity.displayName)
        XCTAssertEqual(KordiSystemIdentity.author(
            messageKind: nil, fromAccountId: KordiSystemIdentity.accountId, ownAccountId: "acct_me"
        ), .person)
    }

    func testSystemAccountIsNeverAPlanParticipantOrMember() throws {
        let card = try JSONDecoder().decode(PlanCard.self, from: Data(planJSON.utf8))

        XCTAssertEqual(card.participants.map(\.participantId), ["acct_me", "acct_maya"])
        XCTAssertTrue(KordiSystemIdentity.isServiceAccount(KordiSystemIdentity.accountId))
        XCTAssertTrue(KordiSystemIdentity.isServiceAccount(KordiSystemAgentIdentity.accountId))
        XCTAssertFalse(KordiSystemIdentity.isServiceAccount("acct_maya"))
        XCTAssertFalse(KordiSystemIdentity.isSystem(accountId: KordiSystemAgentIdentity.accountId))
    }

    private func makeDirect() -> ConversationSummary {
        ConversationSummary(
            id: "person:acct_maya", kind: .person, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Maya", displayName: "Maya", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:person:maya", groupParticipants: []
        )
    }

    private func makeGroup() -> ConversationSummary {
        ConversationSummary(
            id: "group:mobile", kind: .group, peerAccountId: "acct_maya", agentId: nil,
            ownerDisplayName: "Mobile builders", displayName: "Mobile builders", lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0, avatarSource: nil,
            agentActivity: nil, sessionId: "session:group:mobile", groupSpaceId: "session:group:mobile",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Shu Yang", avatarUrl: nil, role: "owner"),
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "member")
            ]
        )
    }

    private func makeWire(
        id: String, from: String, to: String, kind: String?, sessionId: String = "session:person:maya"
    ) -> CloudMessageDTO {
        CloudMessageDTO(
            messageId: id,
            fromAccountId: from,
            toAccountId: to,
            body: "Dinner plan",
            createdAt: "2026-10-21T10:00:00Z",
            deliveredAt: "2026-10-21T10:00:01Z",
            readAt: nil,
            direction: from == "acct_me" ? "outgoing" : "incoming",
            sessionId: sessionId,
            messageKind: kind
        )
    }
}
