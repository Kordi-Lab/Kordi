import XCTest
@testable import Kordi

final class GroupInviteTests: XCTestCase {
    private let token = "kordi_gi_" + String(repeating: "a", count: 40) + "B-_"
    private let origin = "https://kordi.ai"

    private func parse(_ value: String, hostScheme: String? = "kordi") throws -> GroupInviteLink? {
        GroupInviteLink.parse(try XCTUnwrap(URL(string: value)), hostScheme: hostScheme, publicOrigin: origin)
    }

    private func pending(_ id: String, expiresAt: String = "2026-11-12T10:00:00Z") -> GroupInvitePending {
        GroupInvitePending(
            id: id,
            invitationId: "inv_\(id)",
            groupName: "Launch",
            inviterName: "Maya",
            memberCount: 4,
            expiresAt: expiresAt
        )
    }

    // MARK: Links

    func testParsesCustomSchemeAndPublicLinks() throws {
        XCTAssertEqual(try parse("kordi://group-invite/\(token)"), GroupInviteLink(token: token))
        XCTAssertEqual(try parse("kordi-beta://group-invite/\(token)", hostScheme: "kordi-beta")?.token, token)
        XCTAssertEqual(try parse("https://kordi.ai/g/\(token)", hostScheme: nil)?.token, token)
        XCTAssertEqual(try parse("https://www.kordi.ai/g/\(token)", hostScheme: nil)?.token, token)
        XCTAssertEqual(try parse("https://KORDI.ai/g/\(token)/", hostScheme: nil)?.token, token)
    }

    func testRejectsOtherLinks() throws {
        for value in [
            "kordi://group-invite/kordi_gi_short",
            "kordi://group-invite/\(token)/extra",
            "kordi://group-invite/\(token)?next=x",
            "kordi://document/\(token)",
            "kordi://user:pass@group-invite/\(token)",
            "other://group-invite/\(token)",
            "http://kordi.ai/g/\(token)",
            "https://evil.example/g/\(token)",
            "https://kordi.ai.evil.example/g/\(token)",
            "https://kordi.ai:8443/g/\(token)",
            "https://kordi.ai/d/\(token)",
            "https://kordi.ai/g/kordi_ds_\(String(repeating: "a", count: 43))",
        ] {
            XCTAssertNil(try parse(value), value)
        }
        XCTAssertNil(try parse("kordi-beta://group-invite/\(token)", hostScheme: nil))
    }

    // MARK: Wire

    func testDecodesPendingInvitationsWithFallbacks() throws {
        let data = Data("""
        {"invitations":[
          {"id":"p1","invitationId":"i1","groupName":"Launch","inviterName":"Maya","memberCount":4,"expiresAt":"2026-11-12T10:00:00.250Z"},
          {"id":"p2","groupName":"","memberCount":-2}
        ]}
        """.utf8)
        struct List: Decodable { let invitations: [GroupInvitePending] }
        let list = try JSONDecoder().decode(List.self, from: data).invitations
        XCTAssertEqual(list[0], pending("p1", expiresAt: "2026-11-12T10:00:00.250Z").withInvitationId("i1"))
        XCTAssertNotNil(list[0].expiryDate)
        XCTAssertEqual(list[1].groupName, "Group")
        XCTAssertEqual(list[1].inviterName, "Someone")
        XCTAssertEqual(list[1].memberCount, 0)
        XCTAssertNil(list[1].expiryDate)
    }

    func testMemberCopy() {
        XCTAssertEqual(GroupInviteJoinSheet.memberText(1), "1 member")
        XCTAssertEqual(GroupInviteJoinSheet.memberText(4), "4 members")
    }

    // MARK: Flow

    func testSignedOutLinkWaitsForSignIn() {
        var flow = GroupInviteFlow()
        XCTAssertEqual(flow.receiveLink(token: token), .none)
        XCTAssertEqual(flow.queuedToken, token)
        XCTAssertEqual(flow.signedIn(now: Date()), .claim(token))
        XCTAssertNil(flow.queuedToken)
        XCTAssertEqual(flow.receiveLink(token: token), .claim(token))
    }

    func testSignOutKeepsAQueuedLink() {
        var flow = GroupInviteFlow(queuedToken: token)
        flow.signedOut()
        XCTAssertEqual(flow.queuedToken, token)
        XCTAssertEqual(flow.signedIn(now: Date()), .claim(token))
    }

    func testSignInFetchesPendingAndShowsTheNewest() {
        var flow = GroupInviteFlow()
        XCTAssertEqual(flow.signedIn(now: Date()), .fetchPending)
        flow.pendingLoaded([
            pending("old", expiresAt: "2026-11-10T10:00:00Z"),
            pending("new", expiresAt: "2026-11-12T10:00:00Z"),
            pending("middle", expiresAt: "2026-11-11T10:00:00Z"),
        ])
        XCTAssertEqual(flow.sheet, .invitation(pending("new", expiresAt: "2026-11-12T10:00:00Z")))

        // One sheet at a time: a later fetch does not replace it.
        flow.pendingLoaded([pending("other", expiresAt: "2026-12-01T10:00:00Z")])
        XCTAssertEqual(flow.sheet?.id, "invitation:new")
        flow.pendingLoaded([])
        XCTAssertEqual(flow.sheet?.id, "invitation:new")
    }

    func testForegroundFetchIsThrottledAndWaitsForTheSheet() {
        var flow = GroupInviteFlow()
        let start = Date()
        XCTAssertEqual(flow.foregrounded(now: start), .none, "signed out")
        _ = flow.signedIn(now: start)
        XCTAssertEqual(flow.foregrounded(now: start.addingTimeInterval(10)), .none)
        let later = start.addingTimeInterval(GroupInviteFlow.foregroundInterval + 1)
        XCTAssertEqual(flow.foregrounded(now: later), .fetchPending)
        XCTAssertEqual(flow.foregrounded(now: later.addingTimeInterval(1)), .none)

        flow.pendingLoaded([pending("p1")])
        XCTAssertEqual(flow.foregrounded(now: later.addingTimeInterval(600)), .none, "sheet on screen")
    }

    func testClaimShowsTheSheetAndAcceptOpensTheChat() {
        var flow = GroupInviteFlow()
        _ = flow.signedIn(now: Date())
        XCTAssertEqual(flow.claimed(.pending(pending("p1"))), .none)
        XCTAssertEqual(flow.sheet, .invitation(pending("p1")))

        XCTAssertEqual(flow.beginJoin(), "p1")
        XCTAssertTrue(flow.isJoining)
        XCTAssertNil(flow.beginJoin(), "no second accept while joining")
        XCTAssertNil(flow.dismiss(), "cannot dismiss while joining")
        XCTAssertEqual(flow.joined(conversationId: "conv_1"), .open(conversationId: "conv_1"))
        XCTAssertNil(flow.sheet)
        XCTAssertFalse(flow.isJoining)
    }

    func testNotNowDismissesTheInvitation() {
        var flow = GroupInviteFlow()
        _ = flow.signedIn(now: Date())
        _ = flow.claimed(.pending(pending("p1")))
        XCTAssertEqual(flow.dismiss(), "p1")
        XCTAssertNil(flow.sheet)
        XCTAssertNil(flow.dismiss())
    }

    func testClaimErrorsShowOneNotice() {
        var flow = GroupInviteFlow()
        _ = flow.signedIn(now: Date())
        flow.claimFailed(errorCode: "invitation_unavailable")
        XCTAssertEqual(flow.sheet, .notice(.expired))
        XCTAssertEqual(GroupInviteFlow.Notice.expired.title, "This link expired")
        XCTAssertNil(flow.dismiss(), "a notice has nothing to dismiss on the server")
        XCTAssertNil(flow.sheet)

        flow.claimFailed(errorCode: "group_full")
        XCTAssertEqual(flow.sheet, .notice(.groupFull))
        flow.claimFailed(errorCode: "too_many_pending")
        XCTAssertEqual(flow.sheet, .notice(.tooManyPending))
        flow.claimFailed(errorCode: "network_error")
        XCTAssertEqual(flow.sheet, .notice(.failed))
    }

    func testAlreadyMemberOpensTheChat() {
        var flow = GroupInviteFlow()
        _ = flow.signedIn(now: Date())
        flow.claimFailed(errorCode: "group_full")
        XCTAssertEqual(flow.claimed(.alreadyMember(conversationId: "conv_1")), .open(conversationId: "conv_1"))
        XCTAssertNil(flow.sheet)
    }

    func testJoinFailures() {
        var flow = GroupInviteFlow()
        _ = flow.signedIn(now: Date())
        _ = flow.claimed(.pending(pending("p1")))

        _ = flow.beginJoin()
        XCTAssertEqual(flow.joinFailed(errorCode: "network_error", message: "Could not join the group."), .none)
        XCTAssertEqual(flow.sheet?.id, "invitation:p1")
        XCTAssertEqual(flow.joinError, "Could not join the group.")

        _ = flow.beginJoin()
        XCTAssertNil(flow.joinError)
        XCTAssertEqual(flow.joinFailed(errorCode: "invitation_unavailable", message: ""), .none)
        XCTAssertEqual(flow.sheet, .notice(.expired))

        _ = flow.claimed(.pending(pending("p2")))
        _ = flow.beginJoin()
        XCTAssertEqual(flow.joinFailed(errorCode: "already_member", message: ""), .open(conversationId: nil))
        XCTAssertNil(flow.sheet)
    }

    func testSignOutClearsTheSheet() {
        var flow = GroupInviteFlow()
        _ = flow.signedIn(now: Date())
        _ = flow.claimed(.pending(pending("p1")))
        flow.signedOut()
        XCTAssertNil(flow.sheet)
        XCTAssertEqual(flow.claimed(.pending(pending("p2"))), .none)
        XCTAssertNil(flow.sheet, "a late claim answer is ignored after sign-out")
    }
}

private extension GroupInvitePending {
    func withInvitationId(_ invitationId: String) -> GroupInvitePending {
        GroupInvitePending(
            id: id,
            invitationId: invitationId,
            groupName: groupName,
            inviterName: inviterName,
            memberCount: memberCount,
            expiresAt: expiresAt
        )
    }
}
