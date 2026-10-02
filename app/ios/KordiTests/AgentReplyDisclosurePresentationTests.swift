import XCTest
@testable import Kordi

final class AgentReplyDisclosurePresentationTests: XCTestCase {
    func testCloudRunsNameTheModelAndWhoseAccountRanIt() {
        let disclosure = CloudAgentReplyDisclosure(
            key: "m1", agentName: "Scout", ownerName: "Olive", requesterName: "Riley",
            runtime: .kordiCloud, credentials: .owner, provider: "openai", providerLabel: "OpenAI", model: "gpt-5"
        )
        XCTAssertEqual(AgentReplyDisclosurePresentation.rows(for: disclosure), [
            "Agent: Scout",
            "Runs for: Olive",
            "Requested by: Riley",
            "Ran on: Kordi Cloud",
            "Model: gpt-5 (OpenAI)",
            "Model account: Olive's",
        ])

        var providerOnly = disclosure
        providerOnly.model = nil
        XCTAssertTrue(AgentReplyDisclosurePresentation.rows(for: providerOnly).contains("Model: OpenAI"))

        var unreported = disclosure
        unreported.model = nil
        unreported.provider = nil
        unreported.providerLabel = nil
        XCTAssertTrue(AgentReplyDisclosurePresentation.rows(for: unreported).contains("Model: Not reported"))
    }

    func testKordiServiceRunsSayKordi() {
        let disclosure = CloudAgentReplyDisclosure(
            key: "m1", agentName: "Kordi", ownerName: "Kordi Support",
            runtime: .kordiCloud, credentials: .kordi, provider: "anthropic", providerLabel: "Anthropic"
        )
        let rows = AgentReplyDisclosurePresentation.rows(for: disclosure)
        XCTAssertTrue(rows.contains("Runs for: Kordi"))
        XCTAssertTrue(rows.contains("Model account: Kordi's"))
        XCTAssertFalse(rows.contains { $0.hasPrefix("Requested by") })
    }

    func testMacRunsNeverClaimAModel() {
        let disclosure = CloudAgentReplyDisclosure(
            key: "m1", agentName: "Scout", ownerName: "Olive", requesterName: "Riley",
            runtime: .ownerDevice, credentials: nil, provider: "openai", model: "gpt-5"
        )
        XCTAssertEqual(AgentReplyDisclosurePresentation.rows(for: disclosure), [
            "Agent: Scout",
            "Runs for: Olive",
            "Requested by: Riley",
            "Ran on: Olive's Mac",
            "Model: Chosen on Olive's Mac. Kordi isn't told which one.",
        ])
    }

    func testMissingNamesFallBackToTheMessage() {
        let rows = AgentReplyDisclosurePresentation.rows(
            for: CloudAgentReplyDisclosure(key: "m1", runtime: .ownerDevice),
            fallbackAgentName: "Olive's Kordi",
            fallbackOwnerName: "Olive"
        )
        XCTAssertEqual(rows.prefix(2), ["Agent: Olive's Kordi", "Runs for: Olive"])
        XCTAssertEqual(AgentReplyDisclosurePresentation.rows(for: CloudAgentReplyDisclosure(key: "m1")).prefix(2), [
            "Agent: Agent", "Runs for: the owner",
        ])
    }

    func testPiPAndStateCopy() {
        XCTAssertEqual(
            AgentReplyDisclosurePresentation.pipText(providerLabel: "OpenAI"),
            "PiP is Kordi's built-in plan helper. It runs on OpenAI through Kordi's account."
        )
        XCTAssertEqual(
            AgentReplyDisclosurePresentation.pipText(providerLabel: " "),
            "PiP is Kordi's built-in plan helper. It runs through Kordi's account."
        )
        XCTAssertEqual(
            AgentReplyDisclosurePresentation.pipRows(providerLabel: "OpenAI"),
            [
                "Agent: PiP",
                "Runs for: Kordi",
                "PiP is Kordi's built-in plan helper. It runs on OpenAI through Kordi's account.",
            ]
        )
        XCTAssertFalse(
            AgentReplyDisclosurePresentation.pipRows(providerLabel: nil).contains { $0.hasPrefix("Requested by") }
        )
        XCTAssertEqual(AgentReplyDisclosurePresentation.title, "About this reply")
        XCTAssertEqual(AgentReplyDisclosurePresentation.heading, "Written by AI")
        XCTAssertEqual(AgentReplyDisclosurePresentation.loading, "Checking…")
        XCTAssertEqual(AgentReplyDisclosurePresentation.missing, "Details aren't available for this reply.")
        XCTAssertEqual(AgentReplyDisclosurePresentation.failed, "Couldn't load details. Try again.")
        XCTAssertTrue(AgentReplyDisclosurePresentation.footnote.contains("The AI label comes from the sender's Kordi app"))
    }

    private func agentReply(owner: String? = "acct_owner", requestId: String? = "request-1") -> ChatMessage {
        ChatMessage(
            id: "reply-1", conversationId: "group:g1", author: .agent, authorName: "Scout",
            senderOwnerName: "Olive", text: "Done", createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .delivered, errorMessage: nil, requestMessageId: requestId,
            reactionTargetMessageId: "wire-reply-1", agentOwnerAccountId: owner
        )
    }

    func testRequestUsesTheVerifiedOwnerAndTheAnsweredRequest() throws {
        let request = try XCTUnwrap(AgentReplyDisclosurePresentation.request(for: agentReply(), sessionId: "session:group:g1"))
        XCTAssertEqual(request, CloudAgentReplyDisclosureRequest(key: "wire-reply-1", requestId: "request-1", ownerAccountId: "acct_owner"))
        XCTAssertNil(AgentReplyDisclosurePresentation.request(for: agentReply(owner: nil), sessionId: "session:group:g1"))
        XCTAssertNil(AgentReplyDisclosurePresentation.request(for: agentReply(requestId: nil), sessionId: "session:group:g1"))
        XCTAssertNil(AgentReplyDisclosurePresentation.request(for: agentReply(), sessionId: "session:agent:private"))
        let human = ChatMessage(id: "h", conversationId: "group:g1", author: .person, authorName: "Riley", text: "Hi",
                            createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        XCTAssertNil(AgentReplyDisclosurePresentation.request(for: human, sessionId: "session:group:g1"))
    }

    func testOnlyFinishedAgentRepliesAndPiPOfferDetails() {
        XCTAssertTrue(AgentReplyDisclosurePresentation.offersDisclosure(for: agentReply(), isPip: false))
        var sending = agentReply()
        sending.deliveryState = .sending
        XCTAssertFalse(AgentReplyDisclosurePresentation.offersDisclosure(for: sending, isPip: false))
        let person = ChatMessage(id: "p", conversationId: "group:g1", author: .person, authorName: "PiP", text: "Plan",
                                 createdAt: .distantPast, deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        XCTAssertFalse(AgentReplyDisclosurePresentation.offersDisclosure(for: person, isPip: false))
        XCTAssertTrue(AgentReplyDisclosurePresentation.offersDisclosure(for: person, isPip: true))
    }

    func testDisclosureListsDropEntriesWithoutKeysAndReadUnknownValuesAsNil() throws {
        let list = try JSONDecoder().decode(CloudAgentReplyDisclosureList.self, from: Data(#"""
        {"disclosures":[
          {"key":"m1","agentName":"Scout","runtime":"kordi_cloud","credentials":"owner","provider":"openai",
           "providerLabel":"OpenAI","model":"gpt-5","ownerAccountId":"acct_owner"},
          {"key":"m2","runtime":"satellite","credentials":"someone","model":7},
          {"agentName":"No key"}
        ]}
        """#.utf8))
        XCTAssertEqual(list.disclosures.map(\.key), ["m1", "m2"])
        XCTAssertEqual(list.disclosures[0].runtime, .kordiCloud)
        XCTAssertEqual(list.disclosures[0].credentials, .owner)
        XCTAssertNil(list.disclosures[1].runtime)
        XCTAssertNil(list.disclosures[1].credentials)
        XCTAssertNil(list.disclosures[1].model)
        XCTAssertEqual(
            try JSONDecoder().decode(CloudAgentReplyDisclosureList.self, from: Data(#"{"disclosures":{}}"#.utf8)).disclosures,
            []
        )
    }
}
