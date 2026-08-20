import XCTest
@testable import Kordi

final class SessionRuntimeRouteStoreTests: XCTestCase {
    func testRoutesAreIsolatedByAccountAndSession() throws {
        let suiteName = "SessionRuntimeRouteStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = SessionRuntimeRouteStore(defaults: defaults)

        var route = CloudModelRouting.empty
        route.defaultModel = "openai-codex/gpt-5.6-sol"
        route.defaultAuthProvider = "openai-codex"
        route.defaultAuthChoice = "oauth"
        route.thinking = "high"

        store.save(route, accountId: "acct-me", sessionId: "session:contact:a")

        XCTAssertEqual(
            store.route(accountId: "acct-me", sessionId: "session:contact:a"),
            route
        )
        XCTAssertNil(store.route(accountId: "acct-me", sessionId: "session:contact:b"))
        XCTAssertNil(store.route(accountId: "acct-other", sessionId: "session:contact:a"))
    }

    @MainActor
    func testContactAndDefaultAgentUseSessionScopedRoutes() async throws {
        let suiteName = "SessionRuntimeRouteStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = AppModel(
            sessionRuntimeRouteStore: SessionRuntimeRouteStore(defaults: defaults),
            previewMode: true
        )
        let contact = try XCTUnwrap(model.conversations.first { $0.id == "person:acct_maya" })
        let defaultAgent = try XCTUnwrap(model.conversations.first {
            $0.agentId == CanonicalAvatarSystem.defaultAgentId && $0.kind == .agent
        })

        XCTAssertTrue(model.canChangeRuntimeRouting(for: contact))
        XCTAssertTrue(model.runtimeRoutingIsSessionScoped(for: contact))
        XCTAssertTrue(model.canChangeRuntimeRouting(for: defaultAgent))
        XCTAssertTrue(model.runtimeRoutingIsSessionScoped(for: defaultAgent))

        let saved = await model.updateRuntimeRouting(
            for: contact,
            provider: "anthropic",
            model: "claude-opus-4-8",
            thinking: "max"
        )
        XCTAssertTrue(saved)
        XCTAssertEqual(
            model.runtimeRouting(for: contact).defaultModel,
            "anthropic/claude-opus-4-8"
        )
        XCTAssertEqual(
            model.runtimeRouting(for: contact).defaultAuthProvider,
            "anthropic"
        )
        XCTAssertEqual(model.runtimeRouting(for: contact).thinking, "max")

        let thinkingSaved = await model.updateRuntimeRouting(
            for: contact,
            provider: "anthropic",
            model: "anthropic/claude-opus-4-8",
            thinking: "low"
        )
        XCTAssertTrue(thinkingSaved)
        XCTAssertEqual(model.runtimeRouting(for: contact).thinking, "low")
        XCTAssertNil(model.runtimeRouting(for: defaultAgent).defaultModel)
    }

    @MainActor
    func testSyncedSessionRouteOverridesOwnedAgentDefault() throws {
        let suiteName = "SessionRuntimeRouteStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = SessionRuntimeRouteStore(defaults: defaults)
        let model = AppModel(sessionRuntimeRouteStore: store, previewMode: true)
        let conversation = try XCTUnwrap(
            model.conversations.first { $0.agentId == "cloud_agent_research" }
        )

        var syncedRoute = CloudModelRouting.empty
        syncedRoute.defaultModel = "anthropic/claude-opus-4-1"
        syncedRoute.defaultAuthProvider = "anthropic"
        store.save(
            syncedRoute,
            accountId: model.account?.accountId,
            sessionId: conversation.sessionId
        )

        XCTAssertEqual(
            model.runtimeRouting(for: conversation).defaultModel,
            "anthropic/claude-opus-4-1"
        )
        XCTAssertEqual(
            model.runtimeRouting(for: conversation).defaultAuthProvider,
            "anthropic"
        )
    }

    @MainActor
    func testOwnedAgentModelSheetUpdatesOnlyTheCurrentSessionRoute() async throws {
        let suiteName = "SessionRuntimeRouteStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = AppModel(
            sessionRuntimeRouteStore: SessionRuntimeRouteStore(defaults: defaults),
            previewMode: true
        )
        let conversation = try XCTUnwrap(
            model.conversations.first { $0.agentId == "cloud_agent_research" }
        )
        let originalAgentRoute = try XCTUnwrap(
            model.ownedAgent(id: "cloud_agent_research")
        ).modelRouting

        XCTAssertTrue(model.runtimeRoutingIsSessionScoped(for: conversation))
        let updated = await model.updateRuntimeRouting(
            for: conversation,
            provider: "anthropic",
            model: "claude-opus-4-8",
            thinking: "high"
        )
        XCTAssertTrue(updated)

        let sessionRoute = model.runtimeRouting(for: conversation)
        XCTAssertEqual(sessionRoute.defaultModel, "anthropic/claude-opus-4-8")
        XCTAssertEqual(sessionRoute.defaultAuthProvider, "anthropic")
        XCTAssertEqual(sessionRoute.thinking, "high")
        XCTAssertEqual(
            model.ownedAgent(id: "cloud_agent_research")?.modelRouting,
            originalAgentRoute
        )
        XCTAssertEqual(
            model.messages(for: conversation).filter(\.isAgentModelChangeNotice).count,
            1
        )
        XCTAssertEqual(
            model.messages(for: conversation).last(where: \.isAgentModelChangeNotice)?.text,
            "Model: anthropic/claude-opus-4-8 · Thinking effort: High"
        )

        let thinkingUpdated = await model.updateRuntimeRouting(
            for: conversation,
            provider: "anthropic",
            model: "anthropic/claude-opus-4-8",
            thinking: "xhigh"
        )
        XCTAssertTrue(thinkingUpdated)
        XCTAssertEqual(
            model.messages(for: conversation).last(where: \.isAgentModelChangeNotice)?.text,
            "Model: anthropic/claude-opus-4-8 · Thinking effort: Extra High"
        )
    }

    @MainActor
    func testNewAgentSessionKeepsTheTemplateRouteWithANewStableIdentity() async throws {
        let suiteName = "SessionRuntimeRouteStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = AppModel(
            sessionRuntimeRouteStore: SessionRuntimeRouteStore(defaults: defaults),
            previewMode: true
        )
        let template = try XCTUnwrap(
            model.conversations.first {
                $0.agentId == CanonicalAvatarSystem.defaultAgentId && $0.kind == .agent
            }
        )
        let updated = await model.updateRuntimeRouting(
            for: template,
            provider: "openai",
            model: "gpt-5.6-sol",
            thinking: "max"
        )
        XCTAssertTrue(updated)

        let first = model.makeAgentSession(from: template)
        let second = model.makeAgentSession(from: template)

        XCTAssertNotEqual(first.sessionId, template.sessionId)
        XCTAssertNotEqual(first.sessionId, second.sessionId)
        XCTAssertEqual(
            model.runtimeRouting(for: first),
            model.runtimeRouting(for: template)
        )
        XCTAssertEqual(
            model.runtimeRouting(for: first).defaultModel,
            "openai/gpt-5.6-sol"
        )
        XCTAssertEqual(model.runtimeRouting(for: first).thinking, "max")
    }

    func testModelChangeUsesTheExistingConversationKindAndMembers() {
        let group = ConversationSummary(
            id: "group:route-test",
            kind: .group,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: "Route group",
            displayName: "Route group",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:group:route-test",
            groupParticipants: [
                CloudGroupParticipant(
                    accountId: "acct_me",
                    displayName: "Me",
                    avatarUrl: nil,
                    role: "admin"
                ),
                CloudGroupParticipant(
                    accountId: "acct_peer",
                    displayName: "Peer",
                    avatarUrl: nil,
                    role: "person"
                ),
                CloudGroupParticipant(
                    accountId: "acct_third",
                    displayName: "Third",
                    avatarUrl: nil,
                    role: "person"
                ),
            ]
        )

        XCTAssertEqual(group.cloudChatKind, "group")
        XCTAssertEqual(
            group.remotePeerAccountIds,
            ["acct_me", "acct_peer", "acct_third"]
        )

        let person = ConversationSummary(
            id: "person:route-test",
            kind: .person,
            peerAccountId: "acct_peer",
            agentId: nil,
            ownerDisplayName: "Peer",
            displayName: "Peer",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:direct-person:acct_me:acct_peer"
        )
        XCTAssertEqual(person.cloudChatKind, "direct")
        XCTAssertEqual(person.remotePeerAccountIds, ["acct_peer"])
    }
}
