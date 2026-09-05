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

    func testProviderRemovalFallsBackToNewestRemainingSnapshot() {
        let snapshots = [
            "openai": CloudProviderAuthSnapshot(
                snapshotId: "snap-openai",
                provider: "openai-codex",
                authChoice: "local-active-oauth",
                createdAt: "2026-08-17T09:00:00Z",
                revokedAt: nil
            ),
            "anthropic": CloudProviderAuthSnapshot(
                snapshotId: "snap-anthropic",
                provider: "anthropic",
                authChoice: "local-active-oauth",
                createdAt: "2026-08-17T10:00:00Z",
                revokedAt: nil
            ),
        ]

        XCTAssertEqual(
            ProviderAuthenticationDefinition.preferredFallbackSnapshot(
                in: snapshots,
                excluding: "anthropic"
            )?.snapshotId,
            "snap-openai"
        )
        XCTAssertNil(
            ProviderAuthenticationDefinition.preferredFallbackSnapshot(
                in: ["anthropic": snapshots["anthropic"]!],
                excluding: "anthropic"
            )
        )
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
}

@MainActor
struct ModelReleaseTests {
    @Test func releasedModelsKeepExistingDefaultsAndNormalizeThinking() {
        #expect(AgentModelPicker.modelNamesByProvider["openai"]?.contains("gpt-6-astra") == true)
        #expect(AgentModelPicker.modelNamesByProvider["anthropic"]?.contains("claude-fable-5-1") == true)
        #expect(AgentModelPicker.modelNamesByProvider["openai"]?.first == "gpt-5.6-sol")
        #expect(AgentModelPicker.modelNamesByProvider["anthropic"]?.first == "claude-sonnet-5")
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
