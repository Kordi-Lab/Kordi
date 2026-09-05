import XCTest
import SwiftUI
@testable import Kordi

final class AgentSessionPresentationTests: XCTestCase {
    func testDefaultAgentUsesTheCrossDeviceAvatarIdentity() {
        let conversation = AgentSessionFactory.makeDefault(
            ownAccountId: "acct_me",
            randomId: "test",
            now: Date(timeIntervalSince1970: 1)
        )

        XCTAssertEqual(conversation.agentId, "cloud-agent:acct_me")
        XCTAssertNil(conversation.avatarSource)
        XCTAssertTrue(conversation.isLocalDraft)
    }

    func testOnlyAgentSessionsDisableQuotedReplies() {
        XCTAssertFalse(ConversationKind.agent.supportsQuotedReplies)
        XCTAssertTrue(ConversationKind.person.supportsQuotedReplies)
        XCTAssertTrue(ConversationKind.group.supportsQuotedReplies)
        XCTAssertTrue(ConversationKind.agent.supportsThreadedReplies)
        XCTAssertTrue(ConversationKind.person.supportsThreadedReplies)
        XCTAssertTrue(ConversationKind.group.supportsThreadedReplies)
    }

    func testDefaultAgentExecutionAliasesShareOneIdentityWithoutMergingCustomAgents() {
        let owner = "acct_me"
        XCTAssertEqual(CanonicalAvatarSystem.agentID("cloud-self:acct_me", ownerAccountID: owner), "cloud-agent:acct_me")
        XCTAssertEqual(CanonicalAvatarSystem.agentID("cloud-local-agent", ownerAccountID: owner), "cloud-agent:acct_me")
        XCTAssertEqual(CanonicalAvatarSystem.agentID("cloud_agent_research", ownerAccountID: owner), "cloud_agent_research")
        XCTAssertNotEqual(CanonicalAvatarSystem.agentID(nil, ownerAccountID: "acct_other"), CanonicalAvatarSystem.agentID(nil, ownerAccountID: owner))
    }

    func testThreadsPushOnCompactLayoutsAndUseAnInspectorOnWideLayouts() {
        XCTAssertEqual(
            ConversationThreadPresentationMode.resolve(horizontalSizeClass: .compact),
            .navigation
        )
        XCTAssertEqual(
            ConversationThreadPresentationMode.resolve(horizontalSizeClass: .regular),
            .inspector
        )
        XCTAssertEqual(
            ConversationThreadPresentationMode.resolve(horizontalSizeClass: nil),
            .inspector
        )
    }

    func testAgentChoicesIncludeOwnedAndSharedAgentsButNeverKordiSupport() {
        let first = conversation(
            id: "one",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Plan the launch",
            preview: "Start with TestFlight",
            date: Date(timeIntervalSince1970: 10)
        )
        let second = conversation(
            id: "two",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Review the design",
            preview: "The layout is ready",
            date: Date(timeIntervalSince1970: 20)
        )
        let shared = conversation(
            id: "shared",
            peerAccountId: "acct_maya",
            agentId: "agent_support",
            agentName: "Support Agent",
            title: "Support Agent",
            preview: "How can I help?",
            date: Date(timeIntervalSince1970: 30)
        )
        let support = conversation(
            id: "support",
            peerAccountId: KordiSupportIdentity.accountId,
            agentId: KordiSupportIdentity.agentId,
            agentName: KordiSupportIdentity.displayName,
            title: KordiSupportIdentity.displayName,
            preview: "Welcome",
            date: Date(timeIntervalSince1970: 40)
        )

        let sections = AgentSessionPresentationCatalog.build(
            conversations: [first, second, shared, support],
            ownAccountId: "acct_me"
        )

        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(Set(sections.map(\.displayName)), ["Research Agent", "Support Agent"])
        XCTAssertEqual(
            sections.first { $0.displayName == "Research Agent" }?.sessions.map(\.sessionId),
            [second.sessionId, first.sessionId]
        )
    }

    func testSearchMatchesSessionMessageWithoutDroppingItsAgentIdentity() {
        let launch = conversation(
            id: "launch",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Plan the launch",
            preview: "TestFlight checklist",
            date: Date(timeIntervalSince1970: 10)
        )
        let design = conversation(
            id: "design",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Review the layout",
            preview: "Spacing is ready",
            date: Date(timeIntervalSince1970: 20)
        )

        let sections = AgentSessionPresentationCatalog.build(
            conversations: [launch, design],
            ownAccountId: "acct_me",
            searchText: "TestFlight"
        )

        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].displayName, "Research Agent")
        XCTAssertEqual(sections[0].sessions.map(\.sessionId), [launch.sessionId])
    }

    func testAgentLaunchTemplateRemainsSelectableButDoesNotAppearAsASession() {
        let template = ConversationSummary(
            id: "agent-template:session:self-agent:default",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "My Kordi",
            lastMessage: "Your private cloud agent",
            lastActivityAt: Date(timeIntervalSince1970: 20),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:self-agent:default",
            agentDisplayName: "My Kordi"
        )

        let sections = AgentSessionPresentationCatalog.build(
            conversations: [template],
            ownAccountId: "acct_me"
        )
        let timeline = AgentSessionTimelineCatalog.build(conversations: [template])

        XCTAssertEqual(sections.map(\.displayName), ["My Kordi"])
        XCTAssertEqual(sections.first?.template.id, template.id)
        XCTAssertEqual(sections.first?.sessions, [])
        XCTAssertEqual(timeline, [])
    }

    func testNewSessionUsesFreshMacCompatibleRoutingAndPreservesAgentIdentity() {
        let template = conversation(
            id: "template",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Existing session",
            preview: "Previous message",
            date: Date(timeIntervalSince1970: 10)
        )

        let draft = AgentSessionFactory.make(
            from: template,
            ownAccountId: "acct_me",
            randomId: "fresh-session",
            now: Date(timeIntervalSince1970: 30)
        )

        XCTAssertEqual(draft.id, "agent-session:session:self-agent:fresh-session")
        XCTAssertEqual(draft.sessionId, "session:self-agent:fresh-session")
        XCTAssertEqual(draft.agentId, "agent_research")
        XCTAssertEqual(draft.agentDisplayName, "Research Agent")
        XCTAssertEqual(draft.displayName, "Research Agent")
        XCTAssertEqual(draft.lastMessage, "New session")
        XCTAssertEqual(draft.agentActivity, .ready)
        XCTAssertTrue(draft.isLocalDraft)
        XCTAssertFalse(template.isLocalDraft)
    }

    @MainActor
    func testDraftLoadsWithoutCloudButExistingEmptySessionStillRequiresHistory() async throws {
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), previewMode: false)
        let existing = conversation(
            id: "existing-empty",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Research Agent",
            preview: "",
            date: Date(timeIntervalSince1970: 1)
        )
        let draft = model.makeAgentSession(from: existing)

        // No login, cloud connection, or server conversation is needed to open a draft.
        let draftLoaded = await model.loadConversation(draft)
        await model.refreshActiveCall(in: draft)
        XCTAssertTrue(draftLoaded)
        XCTAssertTrue(model.messages(for: draft).isEmpty)
        XCTAssertTrue(model.loadingConversationIDs.isEmpty)
        XCTAssertTrue(model.conversations.isEmpty)
        XCTAssertNil(model.errorMessage)

        let existingLoaded = await model.loadConversation(existing)
        XCTAssertFalse(existingLoaded)

        // A synchronized summary replaces the local marker, even with an older navigation value.
        let synchronized = ConversationSummary(
            id: draft.id,
            kind: draft.kind,
            peerAccountId: draft.peerAccountId,
            agentId: draft.agentId,
            ownerDisplayName: draft.ownerDisplayName,
            displayName: "First request",
            lastMessage: "First request",
            lastActivityAt: draft.lastActivityAt,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: draft.sessionId
        )
        XCTAssertFalse(ConversationIdentityResolver.current(draft, in: [synchronized]).isLocalDraft)
    }

    func testTimelineFlattensAgentsByActivityAndKeepsForksUnderTheirParent() {
        let root = conversation(
            id: "root",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Root plan",
            preview: "Original thread",
            date: Date(timeIntervalSince1970: 30)
        )
        var fork = conversation(
            id: "fork",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Alternative plan",
            preview: "Fork reply",
            date: Date(timeIntervalSince1970: 40)
        )
        fork = replacingForkParent(fork, parentSessionId: root.sessionId)
        let shared = conversation(
            id: "shared",
            peerAccountId: "acct_maya",
            agentId: "agent_writer",
            agentName: "Writer",
            title: "Draft copy",
            preview: "Ready for review",
            date: Date(timeIntervalSince1970: 20)
        )

        let rows = AgentSessionTimelineCatalog.build(conversations: [shared, fork, root])

        XCTAssertEqual(rows.map(\.conversation.sessionId), [root.sessionId, fork.sessionId, shared.sessionId])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 0])
        XCTAssertEqual(rows.map(\.childCount), [1, 0, 0])
    }

    func testTimelineOrdersPinnedRootBeforeNewerUnpinnedRoot() {
        let pinned = conversation(
            id: "pinned",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Pinned work",
            preview: "Older",
            date: Date(timeIntervalSince1970: 10)
        )
        let newer = conversation(
            id: "newer",
            peerAccountId: "acct_me",
            agentId: "agent_writer",
            agentName: "Writer",
            title: "Newer work",
            preview: "Newer",
            date: Date(timeIntervalSince1970: 20)
        )

        let rows = AgentSessionTimelineCatalog.build(
            conversations: [newer, pinned],
            pinnedSessionIds: [pinned.sessionId]
        )

        XCTAssertEqual(rows.map(\.conversation.sessionId), [pinned.sessionId, newer.sessionId])
    }

    func testTimelineCollapsesAgentForksAndExcludesSupport() {
        let root = conversation(
            id: "root",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Root",
            preview: "Root",
            date: Date(timeIntervalSince1970: 30)
        )
        let child = replacingForkParent(
            conversation(
                id: "child",
                peerAccountId: "acct_me",
                agentId: "agent_research",
                agentName: "Research Agent",
                title: "Child",
                preview: "Child",
                date: Date(timeIntervalSince1970: 40)
            ),
            parentSessionId: root.sessionId
        )
        let support = conversation(
            id: "support",
            peerAccountId: KordiSupportIdentity.accountId,
            agentId: KordiSupportIdentity.agentId,
            agentName: KordiSupportIdentity.displayName,
            title: KordiSupportIdentity.displayName,
            preview: "Welcome",
            date: Date(timeIntervalSince1970: 60)
        )

        let rows = AgentSessionTimelineCatalog.build(
            conversations: [root, child, support],
            collapsedForkParentIds: [root.sessionId]
        )

        XCTAssertEqual(rows.map(\.conversation.sessionId), [root.sessionId])
    }

    func testTimelinePromotesAnOrphanedAgentForkAndKeepsItsChildren() {
        let missingRootId = "session:self-agent:missing-root"
        let firstFork = replacingForkParent(
            conversation(
                id: "first-orphaned-fork",
                peerAccountId: "acct_me",
                agentId: "agent_research",
                agentName: "Research Agent",
                title: "Available continuation",
                preview: "First retained reply",
                date: Date(timeIntervalSince1970: 30)
            ),
            parentSessionId: missingRootId
        )
        let secondFork = replacingForkParent(
            conversation(
                id: "second-orphaned-fork",
                peerAccountId: "acct_me",
                agentId: "agent_research",
                agentName: "Research Agent",
                title: "Nested continuation",
                preview: "Second retained reply",
                date: Date(timeIntervalSince1970: 40)
            ),
            parentSessionId: firstFork.sessionId
        )

        let rows = AgentSessionTimelineCatalog.build(
            conversations: [secondFork, firstFork]
        )

        XCTAssertEqual(
            rows.map(\.conversation.sessionId),
            [firstFork.sessionId, secondFork.sessionId]
        )
        XCTAssertEqual(rows.map(\.depth), [0, 1])
    }

    func testTimelineHidesPersistedEmptyCanonicalPlaceholder() {
        let placeholder = ConversationSummary(
            id: "agent-session:session:empty",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Alex",
            displayName: "My Kordi",
            lastMessage: "No messages yet",
            lastActivityAt: Date(timeIntervalSince1970: 10),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:empty",
            agentDisplayName: "My Kordi",
            messageCount: 0
        )
        let actual = conversation(
            id: "actual",
            peerAccountId: "acct_me",
            agentId: "agent_research",
            agentName: "Research Agent",
            title: "Current work",
            preview: "A real response",
            date: Date(timeIntervalSince1970: 20)
        )

        XCTAssertEqual(placeholder.agentId, "cloud-agent:acct_me")

        let rows = AgentSessionTimelineCatalog.build(conversations: [placeholder, actual])

        XCTAssertEqual(rows.map(\.conversation.sessionId), [actual.sessionId])
    }

    private func conversation(
        id: String,
        peerAccountId: String,
        agentId: String,
        agentName: String,
        title: String,
        preview: String,
        date: Date
    ) -> ConversationSummary {
        ConversationSummary(
            id: "agent-session:session:\(id)",
            kind: .agent,
            peerAccountId: peerAccountId,
            agentId: agentId,
            ownerDisplayName: peerAccountId == "acct_me" ? "Alex" : "Maya",
            displayName: title,
            lastMessage: preview,
            lastActivityAt: date,
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:\(id)",
            agentDisplayName: agentName
        )
    }

    private func replacingForkParent(
        _ conversation: ConversationSummary,
        parentSessionId: String
    ) -> ConversationSummary {
        ConversationSummary(
            id: conversation.id,
            kind: conversation.kind,
            peerAccountId: conversation.peerAccountId,
            agentId: conversation.agentId,
            ownerDisplayName: conversation.ownerDisplayName,
            displayName: conversation.displayName,
            lastMessage: conversation.lastMessage,
            lastActivityAt: conversation.lastActivityAt,
            unreadCount: conversation.unreadCount,
            avatarSource: conversation.avatarSource,
            agentActivity: conversation.agentActivity,
            sessionId: conversation.sessionId,
            agentDisplayName: conversation.agentDisplayName,
            forkedFromSessionId: parentSessionId
        )
    }
}
