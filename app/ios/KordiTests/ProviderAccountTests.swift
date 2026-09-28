import XCTest
@testable import Kordi

/// Saved provider accounts, the active account, Start chat, and the offline
/// login simulator used by preview data.
final class ProviderAccountTests: XCTestCase {

    @MainActor
    private func previewModel() throws -> AppModel {
        let suiteName = "ProviderLoginTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
        return AppModel(
            cache: try LocalMessageStore(inMemory: true),
            sessionRuntimeRouteStore: SessionRuntimeRouteStore(defaults: defaults),
            previewMode: true
        )
    }

    @MainActor
    func testNewAccountIsActiveOnlyWhenTheProviderHadNone() throws {
        let model = try previewModel()
        XCTAssertEqual(model.activeAccount(for: "openai")?.label, "Work")
        model.recordProviderLogin(ProviderLoginSnapshot(
            snapshotId: "s-new", provider: "openai-codex", authChoice: "ios-oauth:new", label: "Team"
        ))
        XCTAssertEqual(model.authenticationSnapshots(for: "openai").count, 3)
        XCTAssertEqual(model.activeAccount(for: "openai")?.label, "Work", "Adding an account keeps the active one")

        XCTAssertNil(model.activeAccount(for: "cerebras"))
        model.recordProviderLogin(ProviderLoginSnapshot(
            snapshotId: "s-key", provider: "cerebras", authChoice: "ios-api-key:one", label: "Lab"
        ))
        XCTAssertEqual(model.activeAccount(for: "cerebras")?.label, "Lab")
        model.recordProviderLogin(ProviderLoginSnapshot(
            snapshotId: "s-key-2", provider: "cerebras", authChoice: "ios-api-key:two", label: "Backup"
        ))
        XCTAssertEqual(model.activeAccount(for: "cerebras")?.label, "Lab")
        let backup = try XCTUnwrap(model.authenticationSnapshots(for: "cerebras").first { $0.label == "Backup" })
        model.makeAccountActive(backup)
        XCTAssertEqual(model.activeAccount(for: "cerebras")?.label, "Backup")
    }

    @MainActor
    func testStartChatRoutesANewSessionToTheActiveAccountAndPreferredModel() async throws {
        let model = try previewModel()
        let openAI = try XCTUnwrap(model.authenticationProviderDefinitions.first { $0.id == "openai" })
        let revision = model.startedAgentChatRevision
        let started = await model.startAgentChat(with: openAI)
        let chat = try XCTUnwrap(started)
        XCTAssertEqual(model.startedAgentChat, chat)
        XCTAssertEqual(model.startedAgentChatRevision, revision + 1)
        XCTAssertTrue(chat.isLocalDraft)
        let route = model.runtimeRouting(for: chat)
        XCTAssertEqual(route.defaultAuthChoice, "ios-codex:preview-work")
        let expectedModel = try XCTUnwrap(OMPProviderCatalog.pinned.first { $0.id == "openai-codex" }?.defaultModel)
        XCTAssertEqual(route.defaultModel, "openai-codex/\(expectedModel)")

        let groq = try XCTUnwrap(model.authenticationProviderDefinitions.first { $0.id == "groq" })
        let none = await model.startAgentChat(with: groq)
        XCTAssertNil(none, "Start chat needs a saved account")
    }

    /// Start chat on the completion screen routes to the account just added,
    /// while the provider keeps its earlier active account.
    @MainActor
    func testStartChatAfterAddingASecondAccountUsesTheNewAccount() async throws {
        let model = try previewModel()
        let openAI = try XCTUnwrap(model.authenticationProviderDefinitions.first { $0.id == "openai" })
        model.recordProviderLogin(ProviderLoginSnapshot(
            snapshotId: "s-team", provider: "openai-codex", authChoice: "cloud-login:team", label: "Team"
        ))
        XCTAssertEqual(model.activeAccount(for: "openai")?.label, "Work")
        let started = await model.startAgentChat(with: openAI, snapshotID: "s-team")
        let chat = try XCTUnwrap(started)
        XCTAssertEqual(model.runtimeRouting(for: chat).defaultAuthChoice, "cloud-login:team")
        XCTAssertEqual(model.activeAccount(for: "openai")?.label, "Work")
    }

    @MainActor
    func testCustomAPIKeySavesLocallyInPreviewAndBecomesActive() async throws {
        let model = try previewModel()
        let saved = await model.saveProviderAPIKey(
            provider: .custom, apiKey: "synthetic-key", label: "Lab endpoint",
            baseURLOverride: "https://api.example.com/v1", modelOverride: "deepseek-chat"
        )
        let snapshot = try XCTUnwrap(saved)
        XCTAssertEqual(snapshot.label, "Lab endpoint")
        XCTAssertEqual(snapshot.modelHint, "deepseek-chat")
        XCTAssertEqual(model.activeAccount(for: "custom")?.snapshotId, snapshot.snapshotId)
        XCTAssertEqual(model.preferredModel(for: snapshot, provider: .custom), "deepseek-chat")

        let started = await model.startAgentChat(with: .custom)
        let chat = try XCTUnwrap(started)
        let route = model.runtimeRouting(for: chat)
        XCTAssertEqual(route.defaultModel, "custom/deepseek-chat")
        XCTAssertEqual(route.defaultAuthChoice, snapshot.authChoice)
    }

    @MainActor
    func testCustomAPIModelIsRequiredEditableAndNeededToStartChat() async throws {
        let model = try previewModel()
        let missing = await model.saveProviderAPIKey(
            provider: .custom, apiKey: "synthetic-key", label: "No model",
            baseURLOverride: "https://api.example.com/v1", modelOverride: "  "
        )
        XCTAssertNil(missing)
        let tooLong = await model.saveProviderAPIKey(
            provider: .custom, apiKey: "synthetic-key", label: "Long",
            baseURLOverride: "https://api.example.com/v1", modelOverride: String(repeating: "m", count: 121)
        )
        XCTAssertNil(tooLong)
        XCTAssertTrue(model.authenticationSnapshots(for: "custom").isEmpty)

        let first = await model.saveProviderAPIKey(
            provider: .custom, apiKey: "synthetic-key", label: "Lab",
            baseURLOverride: "https://api.example.com/v1", modelOverride: "deepseek-chat"
        )
        let original = try XCTUnwrap(first)
        let edited = await model.saveProviderAPIKey(
            provider: .custom, apiKey: "synthetic-key", label: "Lab", replacing: original,
            baseURLOverride: "https://api.example.com/v1", modelOverride: "deepseek-reasoner"
        )
        let updated = try XCTUnwrap(edited)
        XCTAssertEqual(updated.authChoice, original.authChoice, "Editing re-publishes the same account")
        XCTAssertEqual(model.authenticationSnapshots(for: "custom").map(\.modelHint), ["deepseek-reasoner"])

        // An older custom account without a model cannot start a chat.
        model.recordProviderLogin(ProviderLoginSnapshot(
            snapshotId: "s-legacy", provider: "custom", authChoice: "ios-api-key:legacy", label: "Legacy"
        ))
        let legacy = try XCTUnwrap(model.authenticationSnapshots(for: "custom").first { $0.label == "Legacy" })
        XCTAssertNil(model.preferredModel(for: legacy, provider: .custom))
        model.makeAccountActive(legacy)
        let blocked = await model.startAgentChat(with: .custom)
        XCTAssertNil(blocked)
    }

    // MARK: Offline simulation

    @MainActor
    func testControllerCompletesAnAPIKeySessionWithTheOfflineSimulator() async throws {
        let catalog = [OMPProviderCatalogEntry(
            id: "cerebras",
            login: OMPProviderLoginPolicy(kind: "api-key", name: "Cerebras", instructions: "Copy your API key", placeholder: "csk-..."),
            models: ["m"]
        )]
        let definition = try XCTUnwrap(ProviderAuthenticationDefinition.merged(catalog: catalog, savedProviderIDs: []).first { $0.id == "cerebras" })
        let method = try XCTUnwrap(ProviderLoginMethod.methods(for: definition, catalog: catalog).first)
        let controller = ProviderLoginController()
        var saved: ProviderLoginSnapshot?
        controller.start(
            method,
            label: "Team",
            apiKey: "csk-synthetic",
            transport: PreviewProviderLoginSimulator(catalog: catalog),
            onCompleted: { saved = $0 }
        )
        let deadline = Date().addingTimeInterval(10)
        while controller.state.phase != .completed, Date() < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(controller.state.phase, .completed)
        XCTAssertEqual(saved?.label, "Team")
        XCTAssertEqual(saved?.provider, "cerebras")
        XCTAssertEqual(controller.savedLabel, "Team")
        XCTAssertNil(controller.activeMethodID)
    }

    @MainActor
    func testOfflineOAuthSimulationOpensThenAsksForTheCodeAndCanCancel() async throws {
        let catalog = [OMPProviderCatalogEntry(
            id: "anthropic",
            login: OMPProviderLoginPolicy(kind: "oauth-code", name: "Anthropic", instructions: "Complete login in your browser."),
            models: ["m"]
        )]
        let simulator = PreviewProviderLoginSimulator(catalog: catalog)
        let started = try await simulator.start(provider: "anthropic", label: "Work", mode: nil, method: nil)
        let id = try XCTUnwrap(started.sessionId)
        XCTAssertEqual(started.status, .running)
        guard case .openURL(_, _, let instructions) = started.step else { return XCTFail("Expected an open-url step") }
        XCTAssertEqual(instructions, "Complete login in your browser.")
        await simulator.signInPageOpened(sessionID: id)
        let paste = try await simulator.poll(sessionID: id, after: started.version)
        XCTAssertEqual(paste.status, .awaitingInput)
        XCTAssertEqual(paste.step, .pasteCode(instructions: nil))
        XCTAssertEqual(paste.auth?.instructions, "Complete login in your browser.")
        XCTAssertNotEqual(paste.version, started.version)
        do {
            try await simulator.submit(sessionID: id, value: "  ")
            XCTFail("Expected invalid input")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "invalid_login_input")
        }
        // Like the worker, the answered step stays while OMP checks the value.
        try await simulator.submit(sessionID: id, value: "synthetic-code")
        let checking = try await simulator.poll(sessionID: id, after: paste.version)
        XCTAssertEqual(checking.status, .running)
        XCTAssertEqual(checking.step, .pasteCode(instructions: nil))
        XCTAssertGreaterThan(checking.version ?? 0, paste.version ?? 0)
        try await simulator.cancel(sessionID: id)
        let cancelled = try await simulator.poll(sessionID: id, after: nil)
        XCTAssertEqual(cancelled.status, .cancelled)
    }

    /// A rejected key ends the session like the worker's `invalid_input`
    /// failure; the key field does not reopen.
    @MainActor
    func testOfflineSimulatorReportsARejectedKeyAsAFailedSignIn() async throws {
        let catalog = [OMPProviderCatalogEntry(
            id: "cerebras", login: OMPProviderLoginPolicy(kind: "api-key", name: "Cerebras"), models: ["m"]
        )]
        let method = try XCTUnwrap(ProviderLoginMethod.methods(for: catalog[0]).first)
        let controller = ProviderLoginController()
        controller.start(
            method, label: "Team", apiKey: "invalid-key",
            transport: PreviewProviderLoginSimulator(catalog: catalog), onCompleted: { _ in XCTFail("Nothing is saved") }
        )
        let deadline = Date().addingTimeInterval(10)
        while controller.state.phase != .failed, Date() < deadline {
            XCTAssertNil(controller.transcript.activeInput, "The key field stays closed while OMP checks it")
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(controller.state.phase, .failed)
        XCTAssertEqual(controller.state.failure, "OMP did not accept that value. Check it and start again.")
    }
}
