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
    /// Kordi compatibility endpoint sent with saved API keys; OMP does not publish one.
    let baseURL: String?
    let defaultModel: String?
    /// Fields below come from the OMP catalog when it lists this provider.
    let authKind: String?
    let acceptsAPIKey: Bool
    let models: [String]

    init(
        id: String,
        name: String,
        subtitle: String,
        systemImage: String,
        runtime: Runtime,
        baseURL: String?,
        defaultModel: String?,
        authKind: String? = nil,
        acceptsAPIKey: Bool? = nil,
        models: [String] = []
    ) {
        self.id = id
        self.name = name
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.runtime = runtime
        self.baseURL = baseURL
        self.defaultModel = defaultModel
        self.authKind = authKind
        self.acceptsAPIKey = acceptsAPIKey ?? (runtime == .cloudAPI)
        self.models = models
    }

    var acceptsAPIKeyOnPhone: Bool { acceptsAPIKey }

    /// OMP may report `acceptsApiKey: false` for a provider that still reads a key
    /// from an `*_API_KEY` environment variable. `*_TOKEN` variables hold
    /// vendor-issued tokens, not API keys, and do not enable key entry.
    static func catalogAcceptsAPIKey(_ auth: OMPProviderAuthPolicy) -> Bool {
        auth.acceptsApiKey || auth.envVars.contains { $0.hasSuffix("_API_KEY") }
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

    static let custom = ProviderAuthenticationDefinition(
        id: "custom", name: "Custom API", subtitle: "OpenAI-compatible endpoint",
        systemImage: "slider.horizontal.3", runtime: .cloudAPI,
        baseURL: nil, defaultModel: nil
    )

    /// Builds a definition from OMP. When OMP and Kordi both know a provider, OMP
    /// supplies the identity, name, models, and authentication policy; Kordi keeps
    /// only its icon and compatibility endpoint. OMP's login policy decides
    /// whether a key works: an `env-only` provider without a key variable
    /// takes none, whatever `auth` says.
    static func fromCatalog(_ entry: OMPProviderCatalogEntry) -> ProviderAuthenticationDefinition {
        let local = definition(for: entry.id)
        let supportsChatGPT = canonicalID(entry.id) == "openai"
        let acceptsAPIKey = entry.login != nil || entry.auth != nil
            ? entry.loginPolicy.acceptsAPIKeyMethod
            : local?.acceptsAPIKey ?? !entry.models.isEmpty
        return ProviderAuthenticationDefinition(
            id: entry.id,
            name: entry.auth?.name?.nonEmpty ?? entry.name?.nonEmpty ?? derivedName(entry.id),
            subtitle: catalogSubtitle(
                authKind: entry.auth?.kind,
                acceptsAPIKey: acceptsAPIKey,
                supportsChatGPT: supportsChatGPT,
                signInStyles: ProviderLoginMethod.methods(for: entry).map(\.style).filter { $0 != .apiKey },
                modelCount: entry.models.count
            ),
            systemImage: local?.systemImage ?? "sparkles",
            runtime: acceptsAPIKey || supportsChatGPT ? .cloudAPI : .mac,
            baseURL: local?.baseURL,
            defaultModel: entry.defaultModel?.nonEmpty ?? entry.models.first,
            authKind: entry.auth?.kind,
            acceptsAPIKey: acceptsAPIKey,
            models: entry.models
        )
    }

    /// The provider list shown in Settings: every OMP provider with models, one row
    /// per provider family, plus Kordi's Mac-only providers and any provider that
    /// has saved accounts but is missing from OMP. Custom API stays last.
    static func merged(
        catalog: [OMPProviderCatalogEntry],
        savedProviderIDs: [String]
    ) -> [ProviderAuthenticationDefinition] {
        var entriesByFamily: [String: OMPProviderCatalogEntry] = [:]
        for entry in catalog where !entry.models.isEmpty && entry.id != custom.id {
            let family = canonicalID(entry.id)
            // `openai` and `openai-codex` share one row; the entry whose id names
            // the family keeps its OMP id.
            if let current = entriesByFamily[family], current.id == family { continue }
            if entriesByFamily[family] == nil || entry.id == family {
                entriesByFamily[family] = entry
            }
        }
        var definitions = entriesByFamily.isEmpty
            ? all
            : entriesByFamily.values.map { fromCatalog($0) }
        var families = Set(definitions.map { canonicalID($0.id) })
        let savedFamilies = Set(savedProviderIDs.map(canonicalID))
        for local in all where !families.contains(local.id)
            && (local.runtime == .mac || savedFamilies.contains(local.id)) {
            definitions.append(local)
            families.insert(local.id)
        }
        for family in savedFamilies.sorted() where !family.isEmpty
            && family != custom.id && !families.contains(family) {
            definitions.append(ProviderAuthenticationDefinition(
                id: family,
                name: derivedName(family),
                subtitle: "Saved account",
                systemImage: "sparkles",
                runtime: .mac,
                baseURL: nil,
                defaultModel: nil
            ))
            families.insert(family)
        }
        definitions.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        definitions.append(custom)
        return definitions
    }

    private static func derivedName(_ providerID: String) -> String {
        providerID
            .split(separator: "-")
            .map { $0.uppercased().count <= 3 ? $0.uppercased() : $0.capitalized }
            .joined(separator: " ")
    }

    /// Names the ways to add an account on iPhone, from OMP's login methods.
    /// Only providers with no iPhone method point to the Mac.
    private static func catalogSubtitle(
        authKind: String?,
        acceptsAPIKey: Bool,
        supportsChatGPT: Bool,
        signInStyles: [ProviderLoginMethod.Style],
        modelCount: Int
    ) -> String {
        let access: String
        if supportsChatGPT {
            access = acceptsAPIKey ? "ChatGPT account or API key" : "ChatGPT account"
        } else if let style = signInStyles.first {
            let signIn = style == .vendorToken ? "Vendor token" : "Subscription sign-in"
            access = acceptsAPIKey ? "\(signIn) or API key" : signIn
        } else if acceptsAPIKey {
            access = "API key"
        } else {
            switch authKind {
            case "native": access = "Provider credentials on Mac"
            case "custom": access = "Custom setup on Mac"
            default: access = "Set up on Mac"
            }
        }
        return "\(access) · \(modelCount) \(modelCount == 1 ? "model" : "models")"
    }

    static func canonicalID(_ provider: String) -> String {
        switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "openai-codex", "codex", "openai-codex-device": "openai"
        case "google-gemini": "google"
        default: provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
    }

    static func definition(for providerID: String) -> ProviderAuthenticationDefinition? {
        let canonicalProviderID = canonicalID(providerID)
        return all.first { $0.id == canonicalProviderID }
    }
}

extension OMPProviderCatalog {
    static let pinnedResourceName = "omp-provider-catalog"

    /// The OMP provider catalog bundled with the app. It is decoded once and used
    /// until a live catalog is fetched, including offline and in preview data.
    static let pinned: [OMPProviderCatalogEntry] = pinnedProviders(in: .main)

    static func pinnedProviders(in bundle: Bundle) -> [OMPProviderCatalogEntry] {
        guard let url = bundle.url(forResource: pinnedResourceName, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONDecoder().decode(OMPProviderCatalog.self, from: data) else {
            return []
        }
        return catalog.providers
    }
}

enum ProviderAuthenticationPolicy {
    static func requiresAuthentication(
        isAgentConversation: Bool,
        mentionedAgentOwnerAccountID: String?,
        ownAccountID: String?
    ) -> Bool {
        if isAgentConversation { return true }
        guard let mentionedAgentOwnerAccountID,
              let ownAccountID else { return false }
        return mentionedAgentOwnerAccountID == ownAccountID
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
