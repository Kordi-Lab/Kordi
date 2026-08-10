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
        let defaultAgent = try XCTUnwrap(model.conversations.first { $0.agentId == nil && $0.kind == .agent })

        XCTAssertTrue(model.canChangeRuntimeRouting(for: contact))
        XCTAssertTrue(model.runtimeRoutingIsSessionScoped(for: contact))
        XCTAssertTrue(model.canChangeRuntimeRouting(for: defaultAgent))
        XCTAssertTrue(model.runtimeRoutingIsSessionScoped(for: defaultAgent))

        let saved = await model.updateRuntimeRouting(
            for: contact,
            model: "openai-codex/gpt-5.6-terra",
            thinking: "high"
        )
        XCTAssertTrue(saved)
        XCTAssertEqual(
            model.runtimeRouting(for: contact).defaultModel,
            "openai-codex/gpt-5.6-terra"
        )
        XCTAssertEqual(model.runtimeRouting(for: contact).thinking, "high")
        XCTAssertNil(model.runtimeRouting(for: defaultAgent).defaultModel)
    }
}
