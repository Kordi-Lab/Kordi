import Foundation
import Testing
@testable import Kordi

@MainActor
struct MessageForwardingTests {
    private func chat(_ id: String, name: String = "General", kind: ConversationKind = .group,
                      parent: String? = nil, space: String? = nil, activity: TimeInterval = 1,
                      draft: Bool = false, subsession: String? = nil) -> ConversationSummary {
        ConversationSummary(id: id, kind: kind, peerAccountId: "acct_peer", agentId: kind == .agent ? "reviewer" : nil,
            ownerDisplayName: parent, displayName: name, lastMessage: "", lastActivityAt: Date(timeIntervalSince1970: activity),
            unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: id, agentDisplayName: kind == .agent ? "Reviewer" : nil,
            groupSpaceId: space, isLocalDraft: draft, subsessionId: subsession)
    }

    @Test func destinationsSearchGroupContextPublicIDsAndRecentActivity() throws {
        let product = chat("product-general", parent: "Product team", space: "product", activity: 20)
        let research = chat("research-general", parent: "Research circle", space: "research", activity: 10)
        let agent = chat("agent-review", name: "Review", kind: .agent, space: "product", activity: 15)
        let person = chat("person", name: "Maya Chen", kind: .person, activity: 5)
        let contact = CloudContact(accountId: "acct_peer", kordiId: "123456789", displayName: "Maya Chen",
                                   avatarUrl: nil, nodeId: nil, createdAt: "2026-01-01T00:00:00Z")
        let destinations = MessageForwardCatalog.build(conversations: [research, agent, product], contacts: [contact],
                                                       contactConversations: [person], ownAccountID: "acct_self")
        #expect(destinations.map(\.id) == [product.id, agent.id, research.id, person.id])
        #expect(MessageForwardCatalog.filter(destinations, query: "research general", kind: .all).map(\.id) == [research.id])
        #expect(MessageForwardCatalog.filter(destinations, query: "product", kind: .agents).map(\.id) == [agent.id])
        #expect(MessageForwardCatalog.filter(destinations, query: "123456789", kind: .people).map(\.id) == [person.id])
        #expect(MessageForwardCatalog.filter(destinations, query: "acct_peer", kind: .all).isEmpty)
        #expect(destinations.first?.path == "Product team › General")
        #expect(destinations.last?.context == "Direct message · @123456789")
    }

    @Test func excludesDraftsTemplatesSubsessionsAndDeduplicatesContactHistory() {
        let person = chat("person", name: "Maya", kind: .person)
        let input = [person, person, chat("draft", kind: .agent, draft: true),
                     chat("agent-template:review", kind: .agent), chat("child", kind: .agent, subsession: "child")]
        let result = MessageForwardCatalog.build(conversations: input, contacts: [], contactConversations: [person], ownAccountID: "acct_self")
        #expect(result.map(\.id) == [person.id])
    }

    @Test func retryResumesAtFailedMessageAndReusesOperationIdentity() async {
        let batch = MessageForwardBatch()
        var calls: [(Int, String)] = []
        let first = await batch.run(sourceIDs: ["one", "two", "three", "four"], destinationID: "group", accountID: "self", caption: "") { index, id in
            calls.append((index, id))
            return index != 1
        }
        #expect(!first)
        #expect(batch.completedCount == 1)
        #expect(batch.errorMessage != nil)
        let retry = await batch.run(sourceIDs: ["one", "two", "three", "four"], destinationID: "group", accountID: "self", caption: "") { index, id in
            calls.append((index, id))
            return true
        }
        #expect(retry)
        #expect(calls.map(\.0) == [0, 1, 1, 2, 3])
        #expect(calls[1].1 == calls[2].1)
        #expect(batch.completedCount == 4)
        #expect(batch.succeeded && !batch.isSending)
        #expect(batch.errorMessage == nil)
    }

    @Test func failedBatchCannotChangeDestinationAccountOrCaption() async {
        let batch = MessageForwardBatch()
        _ = await batch.run(sourceIDs: ["one"], destinationID: "original", accountID: "self", caption: "Comment") { _, _ in false }
        var calls = 0
        for (destination, account, caption) in [("other", "self", "Comment"), ("original", "other", "Comment"), ("original", "self", "Changed")] {
            #expect(await batch.run(sourceIDs: ["one"], destinationID: destination, accountID: account, caption: caption) { _, _ in calls += 1; return true } == false)
        }
        #expect(calls == 0)
    }

    @Test func overlappingSubmitDoesNotDuplicateDelivery() async {
        let batch = MessageForwardBatch()
        var sends = 0
        let result = await batch.run(sourceIDs: ["one"], destinationID: "group", accountID: "self", caption: "") { _, _ in
            sends += 1
            #expect(batch.isSending)
            #expect(batch.completedCount == 0)
            let duplicate = await batch.run(sourceIDs: ["one"], destinationID: "group", accountID: "self", caption: "") { _, _ in sends += 1; return true }
            #expect(!duplicate)
            return true
        }
        #expect(result)
        #expect(sends == 1)
    }

    @Test func realForwardPathPreservesOrderMetadataAndCompletedBatch() async throws {
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), previewMode: true)
        let source = try #require(model.conversations.first { $0.kind == .person })
        let destination = try #require(model.conversations.first { $0.kind == .group })
        let messages = (0..<4).map { index in
            ChatMessage(id: "source-\(index)", conversationId: source.id, author: .person, authorName: "Maya",
                        text: "Forward \(index)", createdAt: Date(), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        }
        let batch = MessageForwardBatch()
        #expect(await model.forward(messages, caption: "Ignored for batches", from: source, to: destination, batch: batch))
        #expect(await model.forward(messages, caption: "Ignored for batches", from: source, to: destination, batch: batch))
        let forwarded = model.messages(for: destination).filter { $0.id.hasPrefix("ios_forward_") }
        #expect(forwarded.map(\.text) == messages.map(\.text))
        #expect(forwarded.allSatisfy { $0.messageAction?.kind == "forward" && $0.deliveryState == .read })
        #expect(Set(forwarded.compactMap(\.clientMessageId)).count == 4)
        #expect(batch.completedCount == 4)
    }

    @Test func sendAcknowledgementIsExactAndStableOperationDoesNotAppendTwice() async throws {
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), previewMode: true)
        let destination = try #require(model.conversations.first { $0.kind == .person })
        var acknowledgements = 0
        await model.send("", to: destination, onDelivered: { acknowledgements += 1 })
        #expect(acknowledgements == 0)
        for _ in 0..<2 {
            await model.send("Stable operation", to: destination, forwardingOperationID: "same-operation", onDelivered: { acknowledgements += 1 })
        }
        #expect(acknowledgements == 2)
        #expect(model.messages(for: destination).filter { $0.id == "ios_forward_same-operation" }.count == 1)
    }
}
