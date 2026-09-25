import XCTest
@testable import Kordi

final class ProviderLoginMethodTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testLoginMethodsFollowTheCatalogLoginKind() throws {
        let catalog = [
            OMPProviderCatalogEntry(id: "openai", login: OMPProviderLoginPolicy(kind: "api-key", name: "OpenAI"), models: ["a"]),
            OMPProviderCatalogEntry(id: "openai-codex", login: OMPProviderLoginPolicy(kind: "oauth-code"), models: ["b"]),
            OMPProviderCatalogEntry(id: "openai-codex-device", login: OMPProviderLoginPolicy(
                kind: "custom", name: "ChatGPT device", instructions: "Enter code: {user_code}",
                hook: "openai-codex-device", storeCredentialsAs: "openai-codex"
            ), models: []),
            OMPProviderCatalogEntry(id: "anthropic", login: OMPProviderLoginPolicy(kind: "oauth-code", name: "Anthropic (Claude Pro/Max)"), models: ["c"]),
            OMPProviderCatalogEntry(id: "kimi-code", login: OMPProviderLoginPolicy(kind: "device-code", name: "Kimi Code"), models: ["d"]),
            OMPProviderCatalogEntry(id: "cloudflare-ai-gateway", login: OMPProviderLoginPolicy(kind: "custom", name: "Cloudflare AI Gateway", hook: "cloudflare-ai-gateway"), models: ["e"]),
            OMPProviderCatalogEntry(id: "groq", auth: OMPProviderAuthPolicy(kind: "api-key", name: "Groq", acceptsApiKey: true), models: ["f"]),
            OMPProviderCatalogEntry(id: "native", auth: OMPProviderAuthPolicy(kind: "native", name: "Native", acceptsApiKey: false, envVars: ["AWS_PROFILE"]), models: ["g"]),
        ]
        let definitions = ProviderAuthenticationDefinition.merged(catalog: catalog, savedProviderIDs: [])
        func methods(_ id: String) throws -> [ProviderLoginMethod] {
            ProviderLoginMethod.methods(for: try XCTUnwrap(definitions.first { $0.id == id }), catalog: catalog)
        }

        let openAI = try methods("openai")
        XCTAssertEqual(openAI.map(\.id), ["openai-codex-device", "openai-codex", "openai"])
        XCTAssertEqual(openAI[0].provider, "openai-codex")
        XCTAssertEqual(openAI[0].mode, "device")
        XCTAssertEqual(openAI.map(\.title), ["Device code", "Browser sign-in", "API key"])
        XCTAssertEqual(openAI.map(\.actionTitle), ["Show code", "Sign in", "Save key"])
        XCTAssertEqual(openAI[0].policy.storeCredentialsAs, "openai-codex")
        XCTAssertTrue(openAI[2].isKeyEntry)
        XCTAssertEqual(ProviderLoginMethod.summary(of: openAI), "Device code, ChatGPT sign-in, API key")

        XCTAssertEqual(try methods("anthropic").map(\.title), ["Browser sign-in"])
        XCTAssertEqual(try methods("anthropic").map(\.actionTitle), ["Sign in"])
        XCTAssertEqual(try methods("kimi-code").map(\.title), ["Device code"])
        XCTAssertEqual(try methods("cloudflare-ai-gateway").map(\.title), ["Vendor token"])
        XCTAssertEqual(try methods("cloudflare-ai-gateway").map(\.actionTitle), ["Add token"])
        let groq = try methods("groq")
        XCTAssertEqual(groq.map(\.title), ["API key"])
        XCTAssertEqual(groq.first?.policy.kind, "env-only")
        XCTAssertTrue(try methods("native").isEmpty)
        XCTAssertTrue(try methods("lm-studio").isEmpty)
        XCTAssertTrue(try methods("custom").isEmpty)

        // Without an `openai-codex-device` entry, ChatGPT sign-in still uses the device hook.
        let fallback = ProviderLoginMethod.methods(
            for: try XCTUnwrap(definitions.first { $0.id == "openai" }),
            catalog: catalog.filter { $0.id != "openai-codex-device" }
        )
        XCTAssertEqual(fallback.first { $0.mode == "device" }?.policy.hook, "openai-codex-device")
    }

    func testShortNamesDropTrailingQualifiers() {
        let short = ProviderAuthenticationDefinition.shortName
        XCTAssertEqual(short("Anthropic (Claude Pro/Max)"), "Anthropic")
        XCTAssertEqual(short("Antigravity (Gemini 3, Claude, GPT-OSS)"), "Antigravity")
        XCTAssertEqual(short("ChatGPT Plus/Pro (Codex Subscription)"), "ChatGPT")
        XCTAssertEqual(short("ChatGPT Plus/Pro (Codex, headless/device)"), "ChatGPT")
        XCTAssertEqual(short("Z.AI (GLM Coding Plan)"), "Z.AI")
        XCTAssertEqual(short("OpenAI"), "OpenAI")
        XCTAssertEqual(short("Cloudflare AI Gateway"), "Cloudflare AI Gateway")
        XCTAssertEqual(ProviderAuthenticationDefinition.nameQualifier("Anthropic (Claude Pro/Max)"), "Claude Pro/Max")
        XCTAssertNil(ProviderAuthenticationDefinition.nameQualifier("OpenAI"))
    }

    func testMethodLabelsNeverNameTheProvider() {
        let catalog = OMPProviderCatalog.pinned
        let definitions = ProviderAuthenticationDefinition.merged(catalog: catalog, savedProviderIDs: [])
        var checked = 0
        for definition in definitions {
            for method in ProviderLoginMethod.methods(for: definition, catalog: catalog) {
                checked += 1
                for text in [method.title, method.actionTitle] {
                    XCTAssertFalse(text.contains(definition.shortName), "\(definition.id): \(text)")
                }
                XCTAssertTrue(["Browser sign-in", "API key", "Device code", "Vendor token"].contains(method.title))
                XCTAssertTrue(["Sign in", "Save key", "Show code", "Add token"].contains(method.actionTitle))
                if method.policy.instructions == nil {
                    XCTAssertFalse(method.summary.contains(definition.shortName), "\(definition.id): \(method.summary)")
                }
                for sentence in method.summary.split(whereSeparator: { ".!?".contains($0) }) {
                    let lower = sentence.lowercased()
                    let mentions = lower.components(separatedBy: "sign in").count - 1
                        + lower.components(separatedBy: "sign-in").count - 1
                    XCTAssertLessThanOrEqual(mentions, 1, "\(definition.id): \(sentence)")
                }
            }
        }
        XCTAssertGreaterThan(checked, 50)
    }

    func testKeyMethodIsOfferedBesideSignInWhenOMPAcceptsAKey() async throws {
        let pinned = OMPProviderCatalog.pinned
        let definitions = ProviderAuthenticationDefinition.merged(catalog: pinned, savedProviderIDs: [])
        let anthropic = ProviderLoginMethod.methods(
            for: try XCTUnwrap(definitions.first { $0.id == "anthropic" }), catalog: pinned
        )
        XCTAssertEqual(anthropic.map(\.title), ["Browser sign-in", "API key"])
        XCTAssertEqual(anthropic.map(\.method), [nil, "api-key"])
        XCTAssertEqual(anthropic.map(\.provider), ["anthropic", "anthropic"])
        XCTAssertTrue(anthropic[1].summary.contains("ANTHROPIC_API_KEY"), anthropic[1].summary)

        // openai-codex has only its OAuth token variable, so it offers no key row.
        let codex = try XCTUnwrap(pinned.first { $0.id == "openai-codex" })
        XCTAssertFalse(codex.loginPolicy.acceptsAPIKeyMethod)
        let codexOnly = ProviderAuthenticationDefinition.merged(catalog: [codex], savedProviderIDs: [])
        let codexMethods = ProviderLoginMethod.methods(
            for: try XCTUnwrap(codexOnly.first { $0.id == "openai-codex" }), catalog: [codex]
        )
        XCTAssertEqual(codexMethods.map(\.title), ["Device code", "Browser sign-in"])
        XCTAssertFalse(codexMethods.contains(where: \.isKeyEntry))
        XCTAssertEqual(ProviderLoginMethod.summary(of: anthropic), "Browser sign-in, API key")
        let groq = ProviderLoginMethod.methods(
            for: try XCTUnwrap(definitions.first { $0.id == "groq" }), catalog: pinned
        )
        XCTAssertEqual(groq.map(\.title), ["API key"])

        // The explicit flag wins over the fallback rule.
        let explicit = try decode(OMPProviderLoginPolicy.self, #"{"kind":"oauth-code","pasteKey":true,"acceptsApiKeyMethod":false}"#)
        XCTAssertFalse(explicit.acceptsAPIKeyMethod)
        XCTAssertTrue(try decode(OMPProviderLoginPolicy.self, #"{"kind":"oauth-code","pasteKey":true}"#).acceptsAPIKeyMethod)

        let simulator = PreviewProviderLoginSimulator(catalog: pinned)
        let keySession = try await simulator.start(provider: "anthropic", label: "Key", mode: nil, method: "api-key")
        XCTAssertEqual(keySession.status, .awaitingInput)
        XCTAssertEqual(keySession.step, .apiKey(instructions: nil, placeholder: nil, authURL: nil))
        // Like the worker: 422 for a key OMP does not take, an env-only provider
        // without a key variable, or an unknown provider.
        for (provider, reason) in [("openai-codex", "unsupported_flow"), ("google-vertex", "unsupported_flow"), ("example-unknown", "unknown_provider")] {
            do {
                _ = try await simulator.start(provider: provider, label: "Key", mode: nil, method: "api-key")
                XCTFail("Expected login_unsupported for \(provider)")
            } catch let error as CloudAPIError {
                XCTAssertEqual(error.code, "login_unsupported", provider)
                XCTAssertEqual(error.statusCode, 422, provider)
                XCTAssertEqual(error.reason, reason, provider)
            }
        }
    }

    /// An env-only provider without a key variable has no iPhone method, even
    /// when the catalog's `auth` still claims it accepts a key.
    func testEnvOnlyProviderWithoutAKeyVariableOffersNoMethod() throws {
        let vertex = OMPProviderCatalogEntry(
            id: "example-vertex",
            auth: OMPProviderAuthPolicy(kind: "api-key", name: "Example Vertex", acceptsApiKey: true),
            login: OMPProviderLoginPolicy(kind: "env-only", name: "Example Vertex"),
            models: ["m"]
        )
        XCTAssertFalse(vertex.loginPolicy.acceptsAPIKeyMethod)
        XCTAssertTrue(ProviderLoginMethod.methods(for: vertex).isEmpty)
        let definition = ProviderAuthenticationDefinition.fromCatalog(vertex)
        XCTAssertFalse(definition.acceptsAPIKeyOnPhone)
        XCTAssertTrue(definition.subtitle.hasPrefix("Set up on Mac"), definition.subtitle)

        let pinned = OMPProviderCatalog.pinned
        let merged = ProviderAuthenticationDefinition.merged(catalog: pinned, savedProviderIDs: [])
        for id in ["google-vertex", "minimax-cn"] {
            guard let entry = merged.first(where: { $0.id == id }) else { continue }
            XCTAssertTrue(ProviderLoginMethod.methods(for: entry, catalog: pinned).isEmpty, id)
        }
        let groq = try XCTUnwrap(merged.first { $0.id == "groq" })
        XCTAssertEqual(ProviderLoginMethod.methods(for: groq, catalog: pinned).map(\.title), ["API key"])
    }

    /// Saved accounts are described from the provider's login policy, never
    /// from the raw auth choice of a hosted login.
    func testAccountMethodLabelsComeFromTheLoginPolicy() {
        let catalog = OMPProviderCatalog.pinned
        func label(_ provider: String, _ authChoice: String) -> String {
            ProviderAccountMethod.label(
                for: CloudProviderAuthSnapshot(snapshotId: "s", provider: provider, authChoice: authChoice, createdAt: "", revokedAt: nil),
                catalog: catalog
            )
        }
        XCTAssertEqual(label("openai-codex", "cloud-login:1"), "ChatGPT account")
        XCTAssertEqual(label("openai", "cloud-login:2"), "API key")
        XCTAssertEqual(label("cerebras", "cloud-login:3"), "API key")
        XCTAssertEqual(label("kimi-code", "cloud-login:4"), "Device code sign-in")
        XCTAssertEqual(label("github-copilot", "cloud-login:5"), "Device code sign-in")
        XCTAssertEqual(label("anthropic", "cloud-login:6"), "Browser sign-in or API key")
        XCTAssertEqual(label("anthropic", "ios-api-key:7"), "API key")
        XCTAssertEqual(label("custom", "ios-api-key:8"), "Custom API")
        XCTAssertEqual(label("example-unknown", "cloud-login:9"), "Saved account")
    }

    func testPreviewLoginStepsArgument() {
        XCTAssertEqual(PreviewLoginSteps.requestedProvider(in: ["--preview-data", "--preview-login-steps=anthropic"]), "anthropic")
        XCTAssertEqual(
            PreviewLoginSteps.request(in: ["--preview-login-steps=anthropic:api-key"]),
            PreviewLoginSteps.Request(provider: "anthropic", method: "api-key")
        )
        let pinned = OMPProviderCatalog.pinned
        let merged = ProviderAuthenticationDefinition.merged(catalog: pinned, savedProviderIDs: [])
        let anthropicMethods = ProviderLoginMethod.methods(for: merged.first { $0.id == "anthropic" }!, catalog: pinned)
        XCTAssertEqual(ProviderLoginMethod.preferred(in: anthropicMethods, provider: "anthropic", selector: "api-key")?.title, "API key")
        XCTAssertEqual(ProviderLoginMethod.preferred(in: anthropicMethods, provider: "anthropic", selector: nil)?.title, "Browser sign-in")
        let openAIMethods = ProviderLoginMethod.methods(for: merged.first { $0.id == "openai" }!, catalog: pinned)
        XCTAssertEqual(ProviderLoginMethod.preferred(in: openAIMethods, provider: "openai-codex-device", selector: nil)?.title, "Device code")
        XCTAssertEqual(PreviewLoginSteps.requestedProvider(in: ["--preview-codex-device-login"]), "openai-codex-device")
        XCTAssertNil(PreviewLoginSteps.requestedProvider(in: ["--preview-login-steps="]))
        XCTAssertNil(PreviewLoginSteps.requestedProvider(in: ["--preview-data"]))
        let definitions = ProviderAuthenticationDefinition.merged(catalog: OMPProviderCatalog.pinned, savedProviderIDs: [])
        XCTAssertEqual(PreviewLoginSteps.definition(for: "openai-codex-device", in: definitions)?.id, "openai")
        XCTAssertEqual(PreviewLoginSteps.definition(for: "anthropic", in: definitions)?.id, "anthropic")

        // Both login previews turn on preview data, so they never reach a backend.
        XCTAssertTrue(KordiPreviewModePersistence.launchRequested(by: ["--preview-login-steps=anthropic"]))
        XCTAssertTrue(KordiPreviewModePersistence.launchRequested(by: ["--preview-codex-device-login"]))
        XCTAssertTrue(KordiPreviewModePersistence.launchRequested(by: ["--preview-authentication-detail"]))
        XCTAssertFalse(KordiPreviewModePersistence.launchRequested(by: ["--preview-agent-model"]))
        XCTAssertFalse(KordiPreviewModePersistence.launchRequested(by: []))
    }
}
