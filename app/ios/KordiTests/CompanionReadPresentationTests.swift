import SwiftUI
import Testing
import UIKit
@testable import Kordi

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct CompanionReadPresentationTests {
    private func fixture() async throws -> (AppModel, LocalMessageStore, ConversationSummary) {
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try #require(model.account?.accountId)
        let agent = ConversationSummary(
            id: "agent-session:companion-read", kind: .agent, peerAccountId: accountID,
            agentId: "companion-agent", ownerDisplayName: "Tester", displayName: "Read test",
            lastMessage: "Synthetic agent reply", lastActivityAt: Date(), unreadCount: 1,
            avatarSource: nil, agentActivity: .ready, sessionId: "session:self-agent:companion-read"
        )
        #expect(await model.restoreConversationIfNeeded(agent))
        store.saveMessages([
            ChatMessage(id: "companion-reply", conversationId: agent.id, conversationSequence: 1,
                author: .agent, authorName: "Assistant", text: "Synthetic agent reply",
                createdAt: Date(), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        ], conversationId: agent.id, accountId: accountID, hasEarlier: false)
        model.hydrateCachedMessages(for: agent)
        return (model, store, agent)
    }

    @Test func actualAskAgentPanelClearsItsBadgeAndPersistsTheRead() async throws {
        let (model, store, agent) = try await fixture()
        let parent = try #require(model.conversations.first { $0.kind == .person && $0.unreadCount > 0 })
        let parentUnread = parent.unreadCount
        let before = MainTabUnreadCounts.build(conversations: model.conversations)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let host = UIHostingController(rootView: NavigationStack {
            CompanionChatPanel(selectedConversation: .constant(agent), sourceConversation: parent)
        }
        .environmentObject(model)
        .environmentObject(KordiCallCoordinator())
        .environmentObject(KordiNotificationCoordinator())
        .environment(\.scenePhase, .active))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
        }
        for _ in 0..<150 {
            host.view.layoutIfNeeded()
            if model.conversations.first(where: { $0.id == agent.id })?.unreadCount == 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let current = try #require(model.conversations.first { $0.id == agent.id })
        #expect(current.unreadCount == 0)
        #expect(current.lastReadSequence == 1)
        #expect(model.conversations.first { $0.id == parent.id }?.unreadCount == parentUnread)
        #expect(MainTabUnreadCounts.build(conversations: model.conversations).agents == before.agents - 1)
        #expect(await model.setConversationUnread(agent, unread: true))
        model.upsertPreviewMessage(ChatMessage(
            id: "visible-next-reply", conversationId: agent.id, conversationSequence: 2,
            author: .agent, authorName: "Assistant", text: "A new reply in the open panel",
            createdAt: Date(), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil))
        for _ in 0..<150 {
            host.view.layoutIfNeeded()
            if model.conversations.first(where: { $0.id == agent.id })?.lastReadSequence == 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(model.conversations.first { $0.id == agent.id }?.unreadCount == 0)
        #expect(MainTabUnreadCounts.build(conversations: model.conversations).agents == before.agents - 1)
        let accountID = try #require(model.account?.accountId)
        let cached = try #require(store.loadConversations(accountId: accountID).first { $0.id == agent.id })
        #expect(cached.unreadCount == 0)
        #expect(cached.lastReadSequence == 2)
    }

    @Test(arguments: [(false, true, true), (true, false, true), (true, true, false)])
    func unreadAgentRequiresVisibleForegroundLatestTranscript(
        presented: Bool, foreground: Bool, latest: Bool
    ) async throws {
        let (model, _, agent) = try await fixture()
        let id = UUID()
        model.updateConversationReadPresentation(id: id, conversationID: agent.id,
            isPresented: presented, isAppForeground: foreground, isAtLatest: latest)
        #expect(model.conversations.first { $0.id == agent.id }?.unreadCount == 1)
        model.updateConversationReadPresentation(id: id, conversationID: agent.id,
            isPresented: true, isAppForeground: true, isAtLatest: true)
        #expect(model.conversations.first { $0.id == agent.id }?.unreadCount == 0)
    }

    @Test func closingMainPresentationDoesNotRemoveCompanionReadPresentation() async throws {
        let (model, _, agent) = try await fixture()
        let parent = try #require(model.conversations.first { $0.kind == .person })
        let mainID = UUID(), companionID = UUID()
        model.updateConversationReadPresentation(id: mainID, conversationID: parent.id,
            isPresented: true, isAppForeground: true, isAtLatest: false)
        model.updateConversationReadPresentation(id: companionID, conversationID: agent.id,
            isPresented: true, isAppForeground: true, isAtLatest: true)
        model.updateConversationReadPresentation(id: mainID, conversationID: parent.id,
            isPresented: false, isAppForeground: true, isAtLatest: true)
        #expect(model.isConversationActivelyReadable(canonicalConversationID: agent.sessionId))
        #expect(!model.isConversationActivelyReadable(canonicalConversationID: parent.sessionId))
        model.updateConversationReadPresentation(id: companionID, conversationID: agent.id,
            isPresented: false, isAppForeground: true, isAtLatest: true)
        #expect(!model.isConversationActivelyReadable(canonicalConversationID: agent.sessionId))
    }

    @Test func aPreviouslyVisibleReplyCannotReadTheNextAgentReply() async throws {
        let (model, _, agent) = try await fixture()
        let id = UUID()
        model.updateConversationReadPresentation(id: id, conversationID: agent.id,
            isPresented: true, isAppForeground: true, isAtLatest: true,
            visibleMessageID: "companion-reply")
        model.upsertPreviewMessage(ChatMessage(
            id: "next-reply", conversationId: agent.id, conversationSequence: 2,
            author: .agent, authorName: "Assistant", text: "Another synthetic reply",
            createdAt: Date(), deliveryState: .delivered, errorMessage: nil, requestMessageId: nil))
        #expect(await model.setConversationUnread(agent, unread: true))
        model.updateConversationReadPresentation(id: id, conversationID: agent.id,
            isPresented: true, isAppForeground: true, isAtLatest: true,
            visibleMessageID: "companion-reply")
        #expect(model.conversations.first { $0.id == agent.id }?.unreadCount == 1)
        model.updateConversationReadPresentation(id: id, conversationID: agent.id,
            isPresented: true, isAppForeground: true, isAtLatest: true,
            visibleMessageID: "next-reply")
        let current = try #require(model.conversations.first { $0.id == agent.id })
        #expect(current.unreadCount == 0)
        #expect(current.lastReadSequence == 2)
        #expect(!model.markedUnreadSessionIds.contains(agent.sessionId))
    }

}
