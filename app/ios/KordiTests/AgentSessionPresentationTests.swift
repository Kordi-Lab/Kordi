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

        XCTAssertEqual(conversation.agentId, CanonicalAvatarSystem.defaultAgentId)
        XCTAssertNil(conversation.avatarSource)
    }

    func testOnlyAgentSessionsDisableQuotedReplies() {
        XCTAssertFalse(ConversationKind.agent.supportsQuotedReplies)
        XCTAssertTrue(ConversationKind.person.supportsQuotedReplies)
        XCTAssertTrue(ConversationKind.group.supportsQuotedReplies)
        XCTAssertTrue(ConversationKind.agent.supportsThreadedReplies)
        XCTAssertTrue(ConversationKind.person.supportsThreadedReplies)
        XCTAssertTrue(ConversationKind.group.supportsThreadedReplies)
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

    func testTimelineCollapsesForksAndExcludesSupportAndContactForks() {
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
        let contactFork = replacingForkParent(
            conversation(
                id: "contact-fork",
                peerAccountId: "acct_me",
                agentId: "agent_research",
                agentName: "Research Agent",
                title: "Private contact fork",
                preview: "Fork",
                date: Date(timeIntervalSince1970: 50)
            ),
            parentSessionId: "session:direct-person:acct_me:acct_maya"
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
            conversations: [root, child, contactFork, support],
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

        XCTAssertEqual(placeholder.agentId, CanonicalAvatarSystem.defaultAgentId)

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
