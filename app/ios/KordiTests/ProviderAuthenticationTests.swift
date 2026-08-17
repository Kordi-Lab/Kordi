import XCTest
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
