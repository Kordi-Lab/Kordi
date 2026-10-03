import Foundation
import Testing
@testable import Kordi

private let me = "acct_me"
private let bea = "acct_bea"
private let cloudMessageId = "8B2C6F2E-1D4B-4C55-8F3A-2F6A1E9D7C10"

private func conversation(
    kind: ConversationKind,
    peer: String,
    displayName: String,
    sessionId: String,
    participants: [CloudGroupParticipant] = [],
    subsessionId: String? = nil
) -> ConversationSummary {
    ConversationSummary(
        id: "\(kind):\(sessionId)",
        kind: kind,
        peerAccountId: peer,
        agentId: nil,
        ownerDisplayName: nil,
        displayName: displayName,
        lastMessage: "",
        lastActivityAt: Date(timeIntervalSince1970: 1_790_000_000),
        unreadCount: 0,
        avatarSource: nil,
        agentActivity: nil,
        sessionId: sessionId,
        groupParticipants: participants,
        subsessionId: subsessionId
    )
}

private func message(
    id: String = "local-id",
    reactionTarget: String? = cloudMessageId,
    author: MessageAuthor = .person,
    authorName: String = "Bea",
    text: String = "Buy now",
    state: MessageDeliveryState = .delivered,
    kind: String? = nil,
    version: Int? = 1,
    sequence: Int64? = 3
) -> ChatMessage {
    ChatMessage(
        id: id,
        conversationId: "conversation",
        conversationSequence: sequence,
        author: author,
        authorName: authorName,
        text: text,
        createdAt: Date(timeIntervalSince1970: 1_790_000_000),
        cloudMessageVersion: version,
        deliveryState: state,
        errorMessage: nil,
        requestMessageId: nil,
        reactionTargetMessageId: reactionTarget,
        messageKind: kind
    )
}

struct ReportPayloadTests {
    private let direct = conversation(
        kind: .person, peer: bea, displayName: "Bea",
        sessionId: "session:direct-person:acct_bea:acct_me"
    )

    @Test func messageIdIsTheCloudIdElseTheMessageId() {
        #expect(ReportTarget.reportableMessageId(message()) == cloudMessageId.lowercased())
        let canonical = message(id: cloudMessageId, reactionTarget: nil)
        #expect(ReportTarget.reportableMessageId(canonical) == cloudMessageId.lowercased())
        // A local placeholder id is not something the server can find.
        #expect(ReportTarget.reportableMessageId(message(id: "local-id", reactionTarget: nil)) == nil)
    }

    @Test func unsentMessagesAreNotReportable() {
        #expect(ReportTarget.reportableMessageId(message(state: .sending)) == nil)
        let failedLocal = message(id: "local", reactionTarget: nil, author: .me, state: .failed, version: nil, sequence: nil)
        #expect(ReportTarget.reportableMessageId(failedLocal) == nil)
    }

    @Test func directMessageReportNamesThePeerAndOneMessage() throws {
        let target = try #require(ReportTarget.message(message(), in: direct, selfAccountId: me))
        #expect(target.isMessageReport)
        #expect(target.messageId == cloudMessageId.lowercased())
        #expect(target.sessionId == direct.sessionId)
        #expect(target.accountId == bea)
        #expect(target.contactRequestId == nil)
        #expect(target.messagePreview == "Buy now")
        #expect(target.title == "Report messages from Bea")
    }

    @Test func ownMessagesNoticesAndServiceChatsAreNotReportable() {
        #expect(ReportTarget.message(message(author: .me), in: direct, selfAccountId: me) == nil)
        #expect(ReportTarget.message(message(kind: ChatMessage.groupMemberJoinMessageKind), in: direct, selfAccountId: me) == nil)
        let support = conversation(
            kind: .person, peer: KordiSupportIdentity.accountId, displayName: KordiSupportIdentity.displayName,
            sessionId: KordiSupportIdentity.sessionId(for: me)
        )
        #expect(ReportTarget.message(message(), in: support, selfAccountId: me) == nil)
        let ownAgent = conversation(kind: .agent, peer: me, displayName: "Helper", sessionId: "session:agent:mine")
        #expect(ReportTarget.message(message(author: .agent), in: ownAgent, selfAccountId: me) == nil)
        let thread = conversation(kind: .person, peer: bea, displayName: "Bea", sessionId: "thread", subsessionId: "sub")
        #expect(ReportTarget.message(message(), in: thread, selfAccountId: me) == nil)
    }

    @Test func groupSenderIsKnownOnlyWhenTheNameIsUnique() throws {
        let unique = conversation(
            kind: .group, peer: bea, displayName: "Team", sessionId: "session:group:team",
            participants: [
                CloudGroupParticipant(accountId: me, displayName: "Me", avatarUrl: nil, role: "owner"),
                CloudGroupParticipant(accountId: bea, displayName: "Bea", avatarUrl: nil, role: "member"),
            ]
        )
        let known = try #require(ReportTarget.message(message(), in: unique, selfAccountId: me))
        #expect(known.accountId == bea)
        #expect(known.name == "Bea")

        let ambiguous = conversation(
            kind: .group, peer: bea, displayName: "Team", sessionId: "session:group:team",
            participants: [
                CloudGroupParticipant(accountId: bea, displayName: "Bea", avatarUrl: nil, role: "member"),
                CloudGroupParticipant(accountId: "acct_bea_two", displayName: "bea", avatarUrl: nil, role: "member"),
            ]
        )
        let unknown = try #require(ReportTarget.message(message(), in: ambiguous, selfAccountId: me))
        #expect(unknown.accountId == nil)
        #expect(unknown.messageId == cloudMessageId.lowercased())

        // An agent's reply in a group still reports the message; the server
        // attributes it to the agent's owner.
        let agentReply = try #require(ReportTarget.message(message(author: .agent, authorName: "Helper"), in: unique, selfAccountId: me))
        #expect(agentReply.accountId == nil)
    }

    @Test func accountReportCarriesTheContactRequest() {
        let target = ReportTarget.account(accountId: bea, name: "Bea", contactRequestId: "req_123")
        #expect(!target.isMessageReport)
        #expect(target.title == "Report Bea")
        #expect(target.contactRequestId == "req_123")
        #expect(ReportTarget.account(accountId: bea, name: "  ").name == "Kordi user")
    }

    @Test func detailsAreTrimmedCappedAndDroppedWhenEmpty() {
        #expect(ReportTarget.normalizedDetails("   ") == nil)
        #expect(ReportTarget.normalizedDetails("  spam\0 links  ") == "spam links")
        let long = String(repeating: "a", count: 1_200)
        #expect(ReportTarget.normalizedDetails(long)?.count == CloudReportRequest.maxDetailsLength)
    }

    @Test func retriesKeepTheClientReportIdUntilTheReportChanges() {
        let first = ReportAttempt.next(after: nil, key: ReportAttempt.key(reason: .spam, details: " links "))
        let retry = ReportAttempt.next(after: first, key: ReportAttempt.key(reason: .spam, details: "links"))
        #expect(retry.clientReportId == first.clientReportId)
        let changed = ReportAttempt.next(after: retry, key: ReportAttempt.key(reason: .scam, details: "links"))
        #expect(changed.clientReportId != first.clientReportId)
        #expect(UUID(uuidString: changed.clientReportId) != nil)
    }
}
