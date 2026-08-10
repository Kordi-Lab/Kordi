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

    func testAppearanceValuesRemainStableForUserDefaults() {
        XCTAssertEqual(AppAppearance.allCases.map(\.rawValue), ["system", "light", "dark"])
    }
}
