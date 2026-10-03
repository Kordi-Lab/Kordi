import Foundation
import Testing
@testable import Kordi

struct ParticipantMergeTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let groupSessionId = "session:group:merge"

    private func participant(_ accountId: String, _ name: String, role: String? = "person") -> CloudGroupParticipant {
        CloudGroupParticipant(accountId: accountId, displayName: name, avatarUrl: nil, role: role)
    }

    @Test func inactiveCanonicalMembersAreDroppedFromLegacyParticipants() {
        let merged = CloudConversationCatalog.mergedParticipants(
            legacy: [participant("acct_me", "Me"), participant("acct_bea", "Bea"), participant("acct_cal", "Cal"), participant("acct_dee", "Dee")],
            canonical: [participant("acct_me", "Me", role: "owner"), participant("acct_bea", "Bea", role: "member")],
            inactiveAccountIds: ["acct_cal"]
        )
        #expect(Set(merged.map(\.accountId)) == ["acct_me", "acct_bea", "acct_dee"])
        #expect(merged.first { $0.accountId == "acct_me" }?.role == "owner")
    }

    @Test func withoutCanonicalStateLegacyParticipantsStay() {
        let merged = CloudConversationCatalog.mergedParticipants(
            legacy: [participant("acct_me", "Me"), participant("acct_cal", "Cal")],
            canonical: []
        )
        #expect(Set(merged.map(\.accountId)) == ["acct_me", "acct_cal"])
    }

    @Test func catalogHidesAMemberWhoLeftEvenWhenOldEnvelopesListThem() throws {
        let account = PreviewData.make(now: now).account
        let peer = "acct_bea"
        let everyone = [
            participant(account.accountId, "Viewer", role: "owner"),
            participant(peer, "Bea"),
            participant("acct_cal", "Cal"),
        ]
        let body = try CloudGroupMessageCodec.encode(CloudGroupControlEnvelope(
            kind: "group-update", groupId: groupSessionId, groupSpaceId: groupSessionId,
            groupTitle: "Team", createdByAccountId: account.accountId, actor: everyone[0],
            participants: everyone, message: nil
        ))
        let wire = CloudMessageDTO(
            messageId: "envelope", fromAccountId: account.accountId, toAccountId: peer, body: body,
            createdAt: "2026-08-08T10:00:00Z", deliveredAt: nil, readAt: nil, direction: "outgoing",
            sessionId: groupSessionId, attachments: [], messageKind: nil, conversationSequence: 1
        )
        func groupParticipants(inactive: [String: Set<String>]) -> Set<String> {
            let catalog = CloudConversationCatalog.build(
                account: account, contacts: [], ownedAgents: [], sharedAgents: [],
                messagesByPeer: [peer: [wire]],
                canonicalParticipantsBySessionId: [
                    groupSessionId: [participant(account.accountId, "Viewer", role: "owner"), participant(peer, "Bea", role: "member")],
                ],
                canonicalInactiveMemberIdsBySessionId: inactive,
                now: now
            )
            return Set(catalog.first { $0.sessionId == groupSessionId }?.groupParticipants.map(\.accountId) ?? [])
        }
        // Positive control: before this filter, the leaver stayed listed and
        // every later group update tried to add them back.
        #expect(groupParticipants(inactive: [:]) == [account.accountId, peer, "acct_cal"])
        #expect(groupParticipants(inactive: [groupSessionId: ["acct_cal"]]) == [account.accountId, peer])
    }
}
