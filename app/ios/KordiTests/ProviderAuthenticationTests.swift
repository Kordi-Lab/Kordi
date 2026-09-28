import XCTest
import Testing
@testable import Kordi

final class ProviderAuthenticationTests: XCTestCase {
    func testProviderCatalogMatchesTheMacAuthenticationSurface() {
        let providers = ProviderAuthenticationDefinition.all
        XCTAssertEqual(Set(providers.map(\.id)).count, providers.count)
        XCTAssertEqual(
            providers.map(\.name),
            ["OpenAI", "Claude", "GitHub Copilot", "Google Gemini", "Groq", "OpenRouter", "xAI", "LM Studio", "Ollama"]
        )
    }

    func testOnlyCloudCompatibleProvidersAcceptKeysOnPhone() {
        let editable = ProviderAuthenticationDefinition.all
            .filter(\.acceptsAPIKeyOnPhone)
            .map(\.id)
        XCTAssertEqual(editable, ["openai", "anthropic", "google", "groq", "openrouter", "xai"])
        XCTAssertTrue(ProviderAuthenticationDefinition.all.filter(\.acceptsAPIKeyOnPhone).allSatisfy {
            $0.baseURL != nil && $0.defaultModel != nil
        })
    }

    func testDesktopAliasesShareTheCorrectPhoneProvider() {
        XCTAssertEqual(ProviderAuthenticationDefinition.canonicalID("openai-codex"), "openai")
        XCTAssertEqual(ProviderAuthenticationDefinition.canonicalID("codex"), "openai")
        XCTAssertEqual(ProviderAuthenticationDefinition.canonicalID("google-gemini"), "google")
        XCTAssertEqual(ProviderAuthenticationDefinition.canonicalID("groq"), "groq")
    }

    func testOnlyOwnedAgentMessagesRequireProviderAuthentication() {
        XCTAssertTrue(ProviderAuthenticationPolicy.requiresAuthentication(
            isAgentConversation: true,
            mentionedAgentOwnerAccountID: nil,
            ownAccountID: "account-owner"
        ))
        XCTAssertTrue(ProviderAuthenticationPolicy.requiresAuthentication(
            isAgentConversation: false,
            mentionedAgentOwnerAccountID: "account-owner",
            ownAccountID: "account-owner"
        ))
        XCTAssertFalse(ProviderAuthenticationPolicy.requiresAuthentication(
            isAgentConversation: false,
            mentionedAgentOwnerAccountID: "another-owner",
            ownAccountID: "account-owner"
        ))
        XCTAssertFalse(ProviderAuthenticationPolicy.requiresAuthentication(
            isAgentConversation: false,
            mentionedAgentOwnerAccountID: nil,
            ownAccountID: "account-owner"
        ))
    }

    func testAppearanceValuesRemainStableForUserDefaults() {
        XCTAssertEqual(AppAppearance.allCases.map(\.rawValue), ["system", "light", "dark"])
    }

    func testPinnedOMPCatalogDecodesEveryProvider() {
        let pinned = OMPProviderCatalog.pinned
        XCTAssertEqual(Set(pinned.map(\.id)).count, pinned.count)
        XCTAssertGreaterThanOrEqual(pinned.filter { !$0.models.isEmpty }.count, 60)
        let cerebras = pinned.first { $0.id == "cerebras" }
        XCTAssertEqual(cerebras?.auth?.kind, "api-key")
        XCTAssertFalse(cerebras?.models.isEmpty ?? true)
        XCTAssertEqual(pinned.first { $0.id == "openai-codex" }?.auth?.kind, "oauth-code")
    }

    func testOverlappingProviderUsesOMPIdentityAndAuthenticationPolicy() throws {
        let catalog = [
            OMPProviderCatalogEntry(
                id: "groq",
                name: "Groq",
                defaultModel: "omp-model-b",
                auth: OMPProviderAuthPolicy(
                    kind: "api-key",
                    name: "Groq via OMP",
                    acceptsApiKey: true,
                    instructions: "Copy a key from the example dashboard",
                    authUrl: "https://example.com/keys",
                    placeholder: "gsk-...",
                    envVars: ["GROQ_API_KEY"]
                ),
                models: ["omp-model-a", "omp-model-b"]
            ),
        ]
        let definitions = ProviderAuthenticationDefinition.merged(catalog: catalog, savedProviderIDs: [])
        XCTAssertEqual(definitions.filter { $0.id == "groq" }.count, 1)
        let groq = try XCTUnwrap(definitions.first { $0.id == "groq" })
        XCTAssertEqual(groq.name, "Groq via OMP")
        XCTAssertEqual(groq.models, ["omp-model-a", "omp-model-b"])
        XCTAssertEqual(groq.defaultModel, "omp-model-b")
        XCTAssertEqual(groq.authKind, "api-key")
        XCTAssertTrue(groq.acceptsAPIKeyOnPhone)
        XCTAssertEqual(groq.subtitle, "API key · 2 models")
        // Kordi keeps only presentation and its compatibility endpoint.
        XCTAssertEqual(groq.systemImage, "bolt.fill")
        XCTAssertEqual(groq.baseURL, "https://api.groq.com/openai/v1")

        let pinned = ProviderAuthenticationDefinition.merged(catalog: OMPProviderCatalog.pinned, savedProviderIDs: [])
        let pinnedOpenAI = try XCTUnwrap(pinned.first { $0.id == "openai" })
        let ompOpenAI = try XCTUnwrap(OMPProviderCatalog.pinned.first { $0.id == "openai" })
        XCTAssertEqual(pinnedOpenAI.models, ompOpenAI.models)
        XCTAssertEqual(pinnedOpenAI.defaultModel, ompOpenAI.defaultModel)
    }

    func testAnthropicOffersSignInAndAPIKeyWhileTokenVariablesDoNotEnableKeys() throws {
        let definitions = ProviderAuthenticationDefinition.merged(
            catalog: OMPProviderCatalog.pinned,
            savedProviderIDs: []
        )
        let anthropic = try XCTUnwrap(definitions.first { $0.id == "anthropic" })
        XCTAssertEqual(anthropic.authKind, "oauth-code")
        XCTAssertTrue(anthropic.acceptsAPIKeyOnPhone)
        XCTAssertTrue(anthropic.subtitle.hasPrefix("Subscription sign-in or API key ·"), anthropic.subtitle)
        XCTAssertEqual(anthropic.name, OMPProviderCatalog.pinned.first { $0.id == "anthropic" }?.auth?.name)

        let tokenOnly = OMPProviderAuthPolicy(
            kind: "custom",
            name: "Token provider",
            acceptsApiKey: false,
            envVars: ["EXAMPLE_ACCESS_TOKEN"]
        )
        XCTAssertFalse(ProviderAuthenticationDefinition.catalogAcceptsAPIKey(tokenOnly))
        let copilot = try XCTUnwrap(definitions.first { $0.id == "github-copilot" })
        XCTAssertFalse(copilot.acceptsAPIKeyOnPhone)
        XCTAssertEqual(copilot.runtime, .mac)
    }

    /// Subtitles name what iPhone offers: providers with an OMP sign-in no
    /// longer point to the Mac.
    func testSubtitlesFollowTheMethodsOfferedOnPhone() throws {
        let definitions = ProviderAuthenticationDefinition.merged(catalog: OMPProviderCatalog.pinned, savedProviderIDs: [])
        for id in ["kimi-code", "github-copilot"] {
            let subtitle = try XCTUnwrap(definitions.first { $0.id == id }).subtitle
            XCTAssertTrue(subtitle.hasPrefix("Subscription sign-in ·"), "\(id): \(subtitle)")
            XCTAssertFalse(subtitle.contains("Mac"), "\(id): \(subtitle)")
        }
        let gateway = try XCTUnwrap(definitions.first { $0.id == "cloudflare-ai-gateway" })
        XCTAssertTrue(gateway.subtitle.hasPrefix("Vendor token or API key ·"), gateway.subtitle)
    }

    @MainActor
    func testAliasSavedProfilesAttachToTheOMPFamilyEntry() throws {
        let catalog = [
            OMPProviderCatalogEntry(
                id: "openai",
                auth: OMPProviderAuthPolicy(kind: "api-key", name: "OpenAI", acceptsApiKey: true),
                models: ["api-model"]
            ),
            OMPProviderCatalogEntry(
                id: "openai-codex",
                auth: OMPProviderAuthPolicy(kind: "oauth-code", name: "ChatGPT", acceptsApiKey: false),
                models: ["subscription-model"]
            ),
        ]
        let family = ProviderAuthenticationDefinition.merged(catalog: catalog, savedProviderIDs: ["codex"])
            .filter { ProviderAuthenticationDefinition.canonicalID($0.id) == "openai" }
        XCTAssertEqual(family.map(\.id), ["openai"])
        XCTAssertEqual(ProviderLoginMethod.methods(for: try XCTUnwrap(family.first), catalog: catalog).first?.mode, "device")

        // With only the subscription entry, the definition keeps OMP's id.
        let codexOnly = ProviderAuthenticationDefinition.merged(
            catalog: [catalog[1]],
            savedProviderIDs: ["codex"]
        ).filter { ProviderAuthenticationDefinition.canonicalID($0.id) == "openai" }
        XCTAssertEqual(codexOnly.map(\.id), ["openai-codex"])
        XCTAssertEqual(codexOnly.first?.name, "ChatGPT")
        XCTAssertEqual(ProviderLoginMethod.methods(for: try XCTUnwrap(codexOnly.first), catalog: [catalog[1]]).first?.mode, "device")

        let model = try makePreviewModel()
        let openAI = try XCTUnwrap(model.authenticationProviderDefinitions.first { $0.id == "openai" })
        XCTAssertEqual(
            model.authenticationSnapshots(for: openAI.id).compactMap(\.label),
            ["Work", "Personal"]
        )
        XCTAssertTrue(model.authenticationSnapshots(for: openAI.id).allSatisfy { $0.provider == "openai-codex" })
    }

    func testKordiOnlyProvidersRemainAndCustomStaysLast() {
        let definitions = ProviderAuthenticationDefinition.merged(
            catalog: OMPProviderCatalog.pinned,
            savedProviderIDs: ["example-provider"]
        )
        let ids = definitions.map(\.id)
        XCTAssertTrue(ids.contains("lm-studio"))
        XCTAssertTrue(ids.contains("ollama"))
        XCTAssertTrue(ids.contains("ollama-cloud"))
        XCTAssertFalse(ids.contains("local"), "OMP providers without models are not shown")
        XCTAssertTrue(ids.contains("example-provider"), "Saved accounts stay visible when OMP lacks the provider")
        XCTAssertEqual(ids.last, "custom")
        XCTAssertEqual(ids.filter { $0 == "custom" }.count, 1)
        let named = definitions.dropLast().map(\.name)
        XCTAssertEqual(named, named.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending })
        XCTAssertGreaterThanOrEqual(definitions.count, 60)
    }

    @MainActor
    func testFetchedCatalogReplacesPinnedAndFailureKeepsItSilently() async throws {
        let model = try makePreviewModel()
        XCTAssertEqual(model.ompProviderCatalog, OMPProviderCatalog.pinned)
        XCTAssertFalse(model.hasLiveOMPProviderCatalog)

        await model.refreshOMPProviderCatalog { throw URLError(.notConnectedToInternet) }
        XCTAssertEqual(model.ompProviderCatalog, OMPProviderCatalog.pinned)
        XCTAssertNil(model.providerAuthenticationErrorMessage)
        XCTAssertFalse(model.hasLiveOMPProviderCatalog)

        let fetched = OMPProviderCatalog(providers: [
            OMPProviderCatalogEntry(id: "cerebras", models: ["live-model"]),
        ])
        await model.refreshOMPProviderCatalog { fetched }
        XCTAssertEqual(model.ompProviderCatalog.map(\.id), ["cerebras"])
        XCTAssertTrue(model.hasLiveOMPProviderCatalog)

        await model.refreshOMPProviderCatalog { throw URLError(.timedOut) }
        XCTAssertEqual(model.ompProviderCatalog.map(\.id), ["cerebras"])
        XCTAssertNil(model.providerAuthenticationErrorMessage)
    }

    @MainActor
    private func makePreviewModel() throws -> AppModel {
        let suiteName = "ProviderAuthenticationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
        return AppModel(
            cache: try LocalMessageStore(inMemory: true),
            sessionRuntimeRouteStore: SessionRuntimeRouteStore(defaults: defaults),
            previewMode: true
        )
    }
}

@MainActor
struct ModelReleaseTests {
    @Test func initialRouteSyncIsHiddenButRetainsTheSelectedModel() throws {
        let json = #"{"schemaVersion":1,"kind":"message","text":"","synchronizationOnly":true,"agentRuntimeRoute":{"model":"openai/gpt-6-astra","authProvider":"openai","thinking":"medium"}}"#
        let encoded = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let body = CloudMessageCodec.directPrefix + encoded
        #expect(CloudMessageCodec.isAgentControl(body))
        #expect(CloudMessageCodec.directEnvelope(body)?.agentRuntimeRoute?.defaultModel == "openai/gpt-6-astra")
    }

    @Test func releasedModelsSortFirstAndNormalizeThinking() {
        #expect(AgentModelPicker.modelNamesByProvider["openai"]?.contains("gpt-6-astra") == true)
        #expect(AgentModelPicker.modelNamesByProvider["anthropic"]?.contains("claude-fable-5-1") == true)
        #expect(AgentModelPicker.modelNamesByProvider["openai"]?.first == "gpt-6-astra")
        #expect(AgentModelPicker.modelNamesByProvider["anthropic"]?.first == "claude-fable-5-1")
        for route in ["gpt-6-astra", "openai/gpt-6-astra", "openai-codex/gpt-6-astra"] {
            #expect(AgentModelPicker.thinkingLevels(for: route) == ["default", "low", "medium", "high", "xhigh", "max"])
            #expect(AgentModelPicker.normalizedThinking("off", for: route) == "low")
            #expect(AgentModelPicker.normalizedThinking("minimal", for: route) == "low")
            #expect(AgentModelPicker.normalizedThinking("max", for: route) == "max")
        }
        let fable = "anthropic/claude-fable-5-1"
        #expect(!AgentModelPicker.thinkingLevels(for: fable).contains("off"))
        #expect(AgentModelPicker.normalizedThinking("off", for: fable) == "default")
        #expect(AgentModelPicker.normalizedThinking("xhigh", for: fable) == "xhigh")
        #expect(AgentModelPicker.normalizedThinking("off", for: "openai/gpt-5.6-sol") == "off")
    }
}
