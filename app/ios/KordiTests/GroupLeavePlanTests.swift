import Foundation
import Testing
@testable import Kordi

struct GroupLeavePlanTests {
    private func participant(_ accountId: String, role: String?, joinedAt: String?) -> CloudGroupParticipant {
        CloudGroupParticipant(accountId: accountId, displayName: accountId, avatarUrl: nil, role: role, joinedAt: joinedAt)
    }

    private func member(_ accountId: String, role: String, state: String = "active", joinedAt: String) -> CloudChatMember {
        CloudChatMember(
            accountId: accountId, displayName: nil, avatarUrl: nil, defaultAgentId: nil,
            defaultAgentDisplayName: nil, defaultAgentAvatarUrl: nil, role: role, membershipState: state,
            version: 1, lastDeliveredSequence: 0, lastReadSequence: 0, joinedAt: joinedAt, leftAt: nil
        )
    }

    @Test func successorFollowsTheServerOrder() {
        let candidates = [
            participant("acct_me", role: "owner", joinedAt: "2026-10-01T00:00:00Z"),
            participant(KordiPipIdentity.accountId, role: "member", joinedAt: "2026-09-01T00:00:00Z"),
            participant("acct_early", role: "member", joinedAt: "2026-10-01T00:01:00Z"),
            participant("acct_admin", role: "admin", joinedAt: "2026-10-01T00:05:00Z"),
            participant("acct_late_admin", role: "admin", joinedAt: "2026-10-01T00:09:00Z"),
        ]
        #expect(GroupLeavePlan.successor(among: candidates, leaverAccountId: "acct_me")?.accountId == "acct_admin")

        let withoutAdmins = candidates.filter { $0.role != "admin" }
        #expect(GroupLeavePlan.successor(among: withoutAdmins, leaverAccountId: "acct_me")?.accountId == "acct_early")

        let coOwner = candidates + [participant("acct_owner", role: "owner", joinedAt: "2026-10-01T00:10:00Z")]
        #expect(GroupLeavePlan.successor(among: coOwner, leaverAccountId: "acct_me")?.accountId == "acct_owner")

        let alone = [candidates[0], candidates[1]]
        #expect(GroupLeavePlan.successor(among: alone, leaverAccountId: "acct_me") == nil)
    }

    @Test func serverMembersDecideOwnershipAndCandidates() {
        let participants = [
            participant("acct_me", role: "admin", joinedAt: nil),
            CloudGroupParticipant(accountId: "acct_bea", displayName: "Bea (contact)", avatarUrl: nil, role: "person"),
        ]
        let members = [
            member("acct_me", role: "owner", joinedAt: "2026-10-01T00:00:00Z"),
            member("acct_bea", role: "member", joinedAt: "2026-10-01T00:01:00Z"),
            member("acct_cal", role: "admin", state: "left", joinedAt: "2026-10-01T00:00:30Z"),
        ]
        #expect(GroupLeavePlan.leaverIsOwner(rootMembers: members, participants: participants, leaverAccountId: "acct_me"))
        #expect(!GroupLeavePlan.leaverIsOwner(rootMembers: nil, participants: participants, leaverAccountId: "acct_me"))

        let candidates = GroupLeavePlan.candidates(rootMembers: members, participants: participants)
        #expect(candidates.map(\.accountId) == ["acct_me", "acct_bea"])
        #expect(candidates.last?.displayName == "Bea (contact)")
        let successor = GroupLeavePlan.successor(among: candidates, leaverAccountId: "acct_me")
        #expect(successor?.accountId == "acct_bea")
    }

    @Test func leaveEnvelopeListsEveryoneButTheLeaverAndTheSuccessorAsAdmin() {
        let participants = [
            participant("acct_me", role: "owner", joinedAt: nil),
            participant("acct_bea", role: "person", joinedAt: nil),
            participant("acct_cal", role: "person", joinedAt: nil),
        ]
        let envelope = GroupLeavePlan.envelopeParticipants(
            participants, leaverAccountId: "acct_me", successorAccountId: "acct_bea"
        )
        #expect(envelope.map(\.accountId) == ["acct_bea", "acct_cal"])
        #expect(envelope.map(\.role) == ["admin", "person"])

        let memberLeave = GroupLeavePlan.envelopeParticipants(
            participants, leaverAccountId: "acct_cal", successorAccountId: nil
        )
        #expect(memberLeave.map(\.role) == ["owner", "person"])
    }

    @Test func serverLeaveRunsOnceOnTheMainConversation() {
        func conversation(_ id: String, session: String?, kind: String = "group") -> CloudChatConversation {
            CloudChatConversation(
                id: id, kind: kind, sharedTitle: nil, version: 1, createdByAccountId: "acct_me",
                legacySessionId: session, forkedFromSessionId: nil, forkedFromMessageId: nil,
                latestMessageSequence: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
                members: [], preferences: CloudChatPreferences(conversationId: id, accountId: "acct_me", personalTitle: nil, version: 1)
            )
        }
        let canonical = [
            conversation("root-id", session: "session:group:root"),
            conversation("channel-id", session: "session:group:channel"),
            conversation("dm-id", session: "session:direct-person:acct_bea:acct_me", kind: "direct"),
        ]
        #expect(GroupLeavePlan.leaveSessionIds(
            spaceRootId: "session:group:root",
            membershipSessionIds: ["session:group:channel", "session:group:root"],
            canonical: canonical
        ) == ["session:group:root"])
        // Without a known main conversation, each known channel is left.
        #expect(GroupLeavePlan.leaveSessionIds(
            spaceRootId: "cloud:acct_bea+acct_me",
            membershipSessionIds: ["session:group:channel", "session:group:unknown", "session:group:channel"],
            canonical: canonical
        ) == ["session:group:channel"])
    }

    @Test func onlyDeliveryFailuresStopALeave() {
        #expect(GroupLeavePlan.envelopeFailureStopsLeave(CloudAPIError(code: "network_error", message: "", statusCode: 0)))
        #expect(GroupLeavePlan.envelopeFailureStopsLeave(CloudAPIError(code: "server_error", message: "", statusCode: 503)))
        #expect(GroupLeavePlan.envelopeFailureStopsLeave(CancellationError()))
        #expect(!GroupLeavePlan.envelopeFailureStopsLeave(CloudAPIError(code: "CHAT_FORBIDDEN", message: "", statusCode: 403)))
        #expect(!GroupLeavePlan.envelopeFailureStopsLeave(CloudAPIError(code: "CHAT_RELATIONSHIP_REQUIRED", message: "", statusCode: 403)))

        #expect(GroupLeavePlan.isAlreadyGone(CloudAPIError(code: "CHAT_FORBIDDEN", message: "", statusCode: 403)))
        #expect(GroupLeavePlan.isAlreadyGone(CloudAPIError(code: "CHAT_ENTITY_NOT_FOUND", message: "", statusCode: 404)))
        #expect(!GroupLeavePlan.isAlreadyGone(CloudAPIError(code: "server_error", message: "", statusCode: 404)))
    }

    @Test func confirmationNamesTheNextOwner() {
        let member = GroupLeavePlan.confirmationMessage(isOwner: false, successorName: "Bea")
        #expect(!member.contains("owner"))
        #expect(member.hasPrefix("You'll stop getting messages from this group and all of its channels"))
        #expect(GroupLeavePlan.confirmationMessage(isOwner: true, successorName: "Bea")
            .hasSuffix("You're the group owner, so Bea will become the owner."))
        #expect(GroupLeavePlan.confirmationMessage(isOwner: true, successorName: nil)
            .hasSuffix("so another member will become the owner."))
    }
}
