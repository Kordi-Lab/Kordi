import Foundation

struct ProviderAuthenticationDefinition: Identifiable, Hashable {
    enum Runtime: Hashable {
        case cloudAPI
        case mac
    }

    let id: String
    let name: String
    let subtitle: String
    let systemImage: String
    let runtime: Runtime
    let baseURL: String?
    let defaultModel: String?

    var acceptsAPIKeyOnPhone: Bool { runtime == .cloudAPI }

    var queryProviderIDs: [String] {
        switch id {
        case "openai": ["openai", "openai-codex", "codex"]
        case "google": ["google", "google-gemini"]
        default: [id]
        }
    }

    static let all: [ProviderAuthenticationDefinition] = [
        .init(
            id: "openai",
            name: "OpenAI",
            subtitle: "ChatGPT account or API key",
            systemImage: "circle.hexagongrid.fill",
            runtime: .cloudAPI,
            baseURL: "https://api.openai.com/v1",
            defaultModel: "gpt-5.6-sol"
        ),
        .init(
            id: "anthropic",
            name: "Claude",
            subtitle: "API key synced through Kordi Cloud",
            systemImage: "asterisk",
            runtime: .cloudAPI,
            baseURL: "https://api.anthropic.com",
            defaultModel: "claude-sonnet-5"
        ),
        .init(
            id: "github-copilot",
            name: "GitHub Copilot",
            subtitle: "Copilot subscription on Mac",
            systemImage: "chevron.left.forwardslash.chevron.right",
            runtime: .mac,
            baseURL: nil,
            defaultModel: nil
        ),
        .init(
            id: "google",
            name: "Google Gemini",
            subtitle: "API key synced through Kordi Cloud",
            systemImage: "diamond.fill",
            runtime: .cloudAPI,
            baseURL: "https://generativelanguage.googleapis.com",
            defaultModel: "gemini-3.1-pro"
        ),
        .init(
            id: "groq",
            name: "Groq",
            subtitle: "Cloud API key",
            systemImage: "bolt.fill",
            runtime: .cloudAPI,
            baseURL: "https://api.groq.com/openai/v1",
            defaultModel: "llama-3.3-70b-versatile"
        ),
        .init(
            id: "openrouter",
            name: "OpenRouter",
            subtitle: "Model router API key",
            systemImage: "point.3.connected.trianglepath.dotted",
            runtime: .cloudAPI,
            baseURL: "https://openrouter.ai/api/v1",
            defaultModel: "openai/gpt-5"
        ),
        .init(
            id: "xai",
            name: "xAI",
            subtitle: "Cloud API key",
            systemImage: "atom",
            runtime: .cloudAPI,
            baseURL: "https://api.x.ai/v1",
            defaultModel: "grok-4"
        ),
        .init(
            id: "lm-studio",
            name: "LM Studio",
            subtitle: "Runs through your Mac",
            systemImage: "cpu",
            runtime: .mac,
            baseURL: nil,
            defaultModel: nil
        ),
        .init(
            id: "ollama",
            name: "Ollama",
            subtitle: "Runs through your Mac",
            systemImage: "server.rack",
            runtime: .mac,
            baseURL: nil,
            defaultModel: nil
        ),
    ]

    static func canonicalID(_ provider: String) -> String {
        switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "openai-codex", "codex": "openai"
        case "google-gemini": "google"
        default: provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
    }
}

enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    static let storageKey = "kordi.appearance"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var systemImage: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max.fill"
        case .dark: "moon.fill"
        }
    }
}
