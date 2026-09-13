import Foundation
import Testing
@testable import Kordi

@MainActor
struct InitialAgentModelNoticeTests {
    private func check(_ action: (AppModel, ConversationSummary, CloudModelRouting) async throws -> Void) async throws {
        let name = "InitialAgentModelNoticeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let store = SessionRuntimeRouteStore(defaults: defaults)
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), sessionRuntimeRouteStore: store, previewMode: true)
        let template = try #require(model.conversations.first { $0.agentId == "cloud_agent_research" })
        let route = model.runtimeRouting(for: template)
        #expect(route.defaultModel != nil)
        let conversation = ConversationSummary(id: "agent-session:initial-notice-test", kind: .agent,
            peerAccountId: template.peerAccountId, agentId: template.agentId, ownerDisplayName: template.ownerDisplayName,
            displayName: "New session", lastMessage: "", lastActivityAt: .distantPast, unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "session:initial-notice-test")
        store.save(route, accountId: model.account?.accountId, sessionId: conversation.sessionId)
        #expect(await model.loadConversation(conversation))
        try await action(model, conversation, route)
    }

    @Test func firstRequestInheritsTheRouteWithoutAnnouncingAModelChange() async throws {
        try await check { model, conversation, route in
            await model.send("Hello", attachments: [], to: conversation)
            #expect(model.messages(for: conversation).filter(\.isAgentModelChangeNotice).isEmpty)
            #expect(model.messages(for: conversation).first?.text == "Hello")
            #expect(model.runtimeRouting(for: conversation) == route)
        }
    }

    @Test func choosingAModelBeforeAnyMessagesOnlyUpdatesTheRoute() async throws {
        try await check { model, conversation, _ in
            #expect(await model.updateRuntimeRouting(for: conversation, provider: "openai", model: "gpt-5.6-sol", thinking: "max"))
            #expect(model.messages(for: conversation).isEmpty)
            #expect(model.runtimeRouting(for: conversation).defaultModel == "openai/gpt-5.6-sol")
            #expect(model.runtimeRouting(for: conversation).thinking == "max")
        }
    }

    @Test func explicitModelChangeAfterAMessageStillProducesOneNotice() async throws {
        try await check { model, conversation, _ in
            await model.send("First request", attachments: [], to: conversation)
            #expect(await model.updateRuntimeRouting(for: conversation, provider: "openai", model: "gpt-5.6-sol", thinking: "max"))
            let messages = model.messages(for: conversation)
            #expect(messages.filter(\.isAgentModelChangeNotice).count == 1)
            #expect(messages.first?.text == "First request")
            #expect(messages.last?.isAgentModelChangeNotice == true)
        }
    }
    @Test func requestMetadataRestoresTheInitialRouteWithoutBeingAModelNotice() throws {
        var route = CloudModelRouting.empty
        route.defaultModel = "openai/gpt-5.6-sol"
        route.thinking = "medium"
        let body = try CloudMessageCodec.encodeDirect(text: "Hello", agentId: "cloud_agent_test", agentName: "Agent",
            ownerAccountId: "acct_test", ownerName: "Owner", agentRuntimeRoute: route)
        let request = CloudMessageDTO(messageId: "request", fromAccountId: "acct_test", toAccountId: "acct_test", body: body,
            createdAt: "2026-09-13T10:00:01Z", deliveredAt: nil, readAt: nil, direction: "outgoing", sessionId: "session:test")
        #expect(!CloudMessageCodec.isAgentModelChange(request))
        #expect(CloudMessageStateProjector.latestAgentModelChanges(in: ["acct_test": [request]], ownAccountId: "acct_test").map(\.messageId) == ["request"])
        #expect(CloudMessageStateProjector.latestAgentModelChanges(in: ["acct_test": [request]], ownAccountId: "acct_other").isEmpty)
        let change = CloudMessageDTO(messageId: "change", fromAccountId: "acct_test", toAccountId: "acct_test",
            body: "Switched model to anthropic/claude-opus-4-8", createdAt: "2026-09-13T10:00:00Z",
            deliveredAt: nil, readAt: nil, direction: "outgoing", sessionId: "session:test", messageKind: ChatMessage.agentModelChangeMessageKind)
        for messages in [[request, change], [change, request]] {
            #expect(CloudMessageStateProjector.latestAgentModelChanges(in: ["acct_test": messages], ownAccountId: "acct_test").map(\.messageId) == ["change"])
        }
    }

}
