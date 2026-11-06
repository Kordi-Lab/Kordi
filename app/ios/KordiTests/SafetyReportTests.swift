import XCTest
@testable import Kordi

final class SafetyReportTests: XCTestCase {
    private let messageUUID = "6F1C2D3E-4A5B-4C6D-8E7F-9A0B1C2D3E4F"

    func testReasonsMapUILabelsToAPIValues() {
        XCTAssertEqual(CloudReportReason.allCases.map(\.label), [
            "Spam", "Harassment or hate", "Sexual or violent content", "Something else",
        ])
        XCTAssertEqual(CloudReportReason.allCases.map(\.rawValue), ["spam", "harassment", "inappropriate", "other"])
    }

    func testAccountReportOmitsAbsentFields() throws {
        let target = ReportTarget.account(SafetyAccount(accountId: "acct_sample", name: "Sample Person"), contactRequestId: "req_1")
        let request = target.request(reason: .spam, details: "  \n", alsoBlock: true, clientReportId: "client-1")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        XCTAssertEqual(json?["clientReportId"] as? String, "client-1")
        XCTAssertEqual(json?["reason"] as? String, "spam")
        XCTAssertEqual(json?["reportedAccountId"] as? String, "acct_sample")
        XCTAssertEqual(json?["contactRequestId"] as? String, "req_1")
        XCTAssertEqual(json?["alsoBlock"] as? Bool, true)
        XCTAssertNil(json?["details"])
        XCTAssertNil(json?["messageIds"])
        XCTAssertNil(json?["conversationId"])
    }

    func testDetailsAreTrimmedAndCapped() {
        XCTAssertEqual(ReportTarget.normalizedDetails("  hello  "), "hello")
        XCTAssertEqual(ReportTarget.normalizedDetails(String(repeating: "a", count: 1_200))?.count, 1_000)
        XCTAssertNil(ReportTarget.normalizedDetails(" \n "))
    }

    func testRetryReusesTheClientReportId() {
        let key = ReportAttempt.key(reason: .harassment, details: "x", alsoBlock: false)
        let first = ReportAttempt.next(after: nil, key: key)
        XCTAssertEqual(ReportAttempt.next(after: first, key: key), first)
        let changed = ReportAttempt.next(after: first, key: ReportAttempt.key(reason: .spam, details: "x", alsoBlock: false))
        XCTAssertNotEqual(changed.clientReportId, first.clientReportId)
    }

    func testDirectMessageReportNamesThePeerAndOneMessage() throws {
        let target = try XCTUnwrap(ReportTarget.message(
            message(author: .person, authorName: "Sample Person"),
            in: conversation(kind: .person),
            selfAccountId: "acct_me",
            isPreviewMode: false
        ))
        XCTAssertEqual(target.title, "Report message")
        XCTAssertEqual(target.account?.accountId, "acct_peer")
        let request = target.request(reason: .other, details: "", alsoBlock: false, clientReportId: "c")
        XCTAssertEqual(request.messageIds, [messageUUID.lowercased()])
        XCTAssertNil(request.alsoBlock)
    }

    func testOwnMessagesAndNoticesCannotBeReported() {
        XCTAssertNil(ReportTarget.message(message(author: .me, authorName: "You"), in: conversation(kind: .person), selfAccountId: "acct_me", isPreviewMode: false))
        XCTAssertNil(ReportTarget.message(
            message(author: .person, authorName: "System", kind: KordiSystemIdentity.messageKind),
            in: conversation(kind: .group),
            selfAccountId: "acct_me",
            isPreviewMode: false
        ))
    }

    func testGroupAgentMessageReportsItsOwner() throws {
        let target = try XCTUnwrap(ReportTarget.message(
            message(author: .agent, authorName: "Helper", ownerName: "Sample Person"),
            in: conversation(kind: .group),
            selfAccountId: "acct_me",
            isPreviewMode: false
        ))
        XCTAssertEqual(target.account?.accountId, "acct_peer")
    }

    func testBlockListDecodes() throws {
        let json = #"{"block":{"accountId":"acct_peer","kordiId":"123456789","displayName":null,"avatarUrl":null,"blockedAt":"2026-11-05T10:00:00Z"},"removedContact":true}"#
        let result = try JSONDecoder().decode(CloudBlockResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.block.preferredName, "123456789")
        XCTAssertTrue(result.removedContact)
    }

    private func message(author: MessageAuthor, authorName: String, ownerName: String? = nil, kind: String? = nil) -> ChatMessage {
        ChatMessage(
            id: messageUUID,
            conversationId: "local",
            author: author,
            authorName: authorName,
            senderOwnerName: ownerName,
            text: "Hello",
            createdAt: Date(),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            reactionTargetMessageId: messageUUID,
            messageKind: kind
        )
    }

    private func conversation(kind: ConversationKind) -> ConversationSummary {
        ConversationSummary(
            id: "\(kind.rawValue):sample",
            kind: kind,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: nil,
            displayName: "Sample Person",
            lastMessage: "",
            lastActivityAt: Date(),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:sample",
            groupParticipants: [
                CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: nil),
                CloudGroupParticipant(accountId: "acct_peer", displayName: "Sample Person", avatarUrl: nil, role: nil),
            ]
        )
    }
}
