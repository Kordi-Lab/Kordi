import Foundation

/// OMP's declarative login flow for one provider, from the bundled catalog.
/// A catalog without a `login` object falls back to `env-only`.
struct OMPProviderLoginPolicy: Decodable, Hashable {
    let kind: String
    let name: String?
    let instructions: String?
    let prompt: String?
    let placeholder: String?
    let authUrl: String?
    let validates: Bool
    let pasteKey: Bool
    let manualOnly: Bool
    let callbackPort: Int?
    let hook: String?
    let apiKeyFormat: String?
    let envVars: [String]
    let storeCredentialsAs: String?
    /// Whether OMP also accepts a pasted API key for this provider.
    private let acceptsApiKeyMethod: Bool?

    init(
        kind: String,
        name: String? = nil,
        instructions: String? = nil,
        prompt: String? = nil,
        placeholder: String? = nil,
        authUrl: String? = nil,
        validates: Bool = false,
        pasteKey: Bool = false,
        manualOnly: Bool = false,
        callbackPort: Int? = nil,
        hook: String? = nil,
        apiKeyFormat: String? = nil,
        envVars: [String] = [],
        storeCredentialsAs: String? = nil,
        acceptsApiKeyMethod: Bool? = nil
    ) {
        self.kind = kind
        self.name = name
        self.instructions = instructions
        self.prompt = prompt
        self.placeholder = placeholder
        self.authUrl = authUrl
        self.validates = validates
        self.pasteKey = pasteKey
        self.manualOnly = manualOnly
        self.callbackPort = callbackPort
        self.hook = hook
        self.apiKeyFormat = apiKeyFormat
        self.envVars = envVars
        self.storeCredentialsAs = storeCredentialsAs
        self.acceptsApiKeyMethod = acceptsApiKeyMethod
    }

    private enum CodingKeys: String, CodingKey {
        case kind, name, instructions, prompt, placeholder, authUrl, validates, pasteKey, manualOnly
        case callbackPort, hook, apiKeyFormat, envVars, storeCredentialsAs, acceptsApiKeyMethod
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decodeIfPresent(String.self, forKey: .kind)?.nonEmpty ?? "env-only"
        name = try values.decodeIfPresent(String.self, forKey: .name)
        instructions = try values.decodeIfPresent(String.self, forKey: .instructions)
        prompt = try values.decodeIfPresent(String.self, forKey: .prompt)
        placeholder = try values.decodeIfPresent(String.self, forKey: .placeholder)
        authUrl = try values.decodeIfPresent(String.self, forKey: .authUrl)
        validates = try values.decodeIfPresent(Bool.self, forKey: .validates) ?? false
        pasteKey = try values.decodeIfPresent(Bool.self, forKey: .pasteKey) ?? false
        manualOnly = try values.decodeIfPresent(Bool.self, forKey: .manualOnly) ?? false
        callbackPort = try values.decodeIfPresent(Int.self, forKey: .callbackPort)
        hook = try values.decodeIfPresent(String.self, forKey: .hook)
        apiKeyFormat = try values.decodeIfPresent(String.self, forKey: .apiKeyFormat)
        envVars = try values.decodeIfPresent([String].self, forKey: .envVars) ?? []
        storeCredentialsAs = try values.decodeIfPresent(String.self, forKey: .storeCredentialsAs)
        acceptsApiKeyMethod = try values.decodeIfPresent(Bool.self, forKey: .acceptsApiKeyMethod)
    }

    /// Used when the catalog has no `login` object: credentials come from a key.
    static func envOnly(from auth: OMPProviderAuthPolicy?, name: String?) -> OMPProviderLoginPolicy {
        OMPProviderLoginPolicy(
            kind: "env-only",
            name: auth?.name ?? name,
            instructions: auth?.instructions,
            placeholder: auth?.placeholder,
            authUrl: auth?.authUrl,
            envVars: auth?.envVars ?? [],
            // Without a `login` object, only `auth` states whether a key works.
            acceptsApiKeyMethod: auth.map(ProviderAuthenticationDefinition.catalogAcceptsAPIKey)
        )
    }

    /// Headless ChatGPT device login, used when the catalog predates the
    /// `openai-codex-device` entry. Mirrors OMP's hook text.
    static let chatGPTDeviceFallback = OMPProviderLoginPolicy(
        kind: "custom",
        name: "ChatGPT Plus/Pro (Codex, headless/device)",
        instructions: "Enter code: {user_code}",
        hook: "openai-codex-device",
        storeCredentialsAs: "openai-codex"
    )

    var acceptsKeyEntry: Bool { kind == "api-key" || kind == "env-only" }

    /// OMP's `acceptsApiKeyMethod`, or OMP's own rule for older catalogs:
    /// always for `api-key`, only with a key variable for `env-only`, and
    /// otherwise a pasteable key or an `*_API_KEY` variable.
    var acceptsAPIKeyMethod: Bool {
        if let acceptsApiKeyMethod { return acceptsApiKeyMethod }
        switch kind {
        case "api-key": return true
        case "env-only": return !envVars.isEmpty
        default: return pasteKey || envVars.contains { $0.hasSuffix("_API_KEY") }
        }
    }

    /// The key row offered beside another login kind. OMP's sign-in
    /// instructions do not apply to it, so only the key variable carries over.
    var apiKeyMethodPolicy: OMPProviderLoginPolicy {
        OMPProviderLoginPolicy(
            kind: "api-key",
            name: name,
            envVars: envVars,
            storeCredentialsAs: storeCredentialsAs,
            acceptsApiKeyMethod: true
        )
    }
}

extension OMPProviderCatalogEntry {
    static let chatGPTDeviceLoginID = "openai-codex-device"

    var loginPolicy: OMPProviderLoginPolicy {
        login ?? .envOnly(from: auth, name: name)
    }

    /// Keeps a live entry's login flow, or borrows the bundled one when a
    /// worker catalog predates the `login` field.
    func withLogin(from fallback: OMPProviderCatalogEntry?) -> OMPProviderCatalogEntry {
        guard login == nil, let login = fallback?.login else { return self }
        return OMPProviderCatalogEntry(
            id: id, name: name, defaultModel: defaultModel, auth: auth, login: login, models: models
        )
    }
}

/// One way to add an account for a provider row in Settings.
struct ProviderLoginMethod: Identifiable, Hashable {
    enum Style: Equatable {
        case browserSignIn, apiKey, deviceCode, vendorToken
    }

    let id: String
    /// Provider id sent to `login/start`.
    let provider: String
    let mode: String?
    let policy: OMPProviderLoginPolicy

    /// `login/start` method: key rows always ask for OMP's api-key flow.
    var method: String? { isKeyEntry ? "api-key" : nil }

    var style: Style { Self.style(for: policy) }
    var isKeyEntry: Bool { style == .apiKey }

    /// Row title; never contains the provider name.
    var title: String {
        switch style {
        case .browserSignIn: "Browser sign-in"
        case .apiKey: "API key"
        case .deviceCode: "Device code"
        case .vendorToken: "Vendor token"
        }
    }

    /// The row's single button.
    var actionTitle: String {
        switch style {
        case .browserSignIn: "Sign in"
        case .apiKey: "Save key"
        case .deviceCode: "Show code"
        case .vendorToken: "Add token"
        }
    }

    /// One line for the method picker; never names the provider.
    var pickerDescription: String {
        switch style {
        case .browserSignIn: "Approve access on the provider's page."
        case .apiKey: "Paste a key from the provider's console."
        case .deviceCode: "Enter a one-time code on the provider's page."
        case .vendorToken: "Paste a token issued by the provider."
        }
    }

    /// Lower-case label for the Add account subtitle.
    var listLabel: String {
        switch style {
        case .browserSignIn: provider == "openai-codex" ? "ChatGPT sign-in" : "browser sign-in"
        case .apiKey: "API key"
        case .deviceCode: "device code"
        case .vendorToken: "vendor token"
        }
    }

    /// "ChatGPT sign-in, device code, API key"
    static func summary(of methods: [ProviderLoginMethod]) -> String {
        let text = methods.map(\.listLabel).joined(separator: ", ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// Picks a method for `--preview-login-steps=<provider>[:<method>]`.
    static func preferred(
        in methods: [ProviderLoginMethod],
        provider: String,
        selector: String?
    ) -> ProviderLoginMethod? {
        if let selector = selector?.lowercased() {
            let style: Style? = switch selector {
            case "api-key", "key": .apiKey
            case "browser", "oauth", "sign-in": .browserSignIn
            case "device", "device-code", "code": .deviceCode
            case "token", "vendor-token", "custom": .vendorToken
            default: nil
            }
            return methods.first { $0.id == "\(provider):\(selector)" } ?? methods.first { $0.style == style }
        }
        return methods.first { $0.id == provider } ?? methods.first { $0.provider == provider } ?? methods.first
    }

    /// OMP's own instructions, or one short line that does not name the provider.
    var summary: String {
        if let instructions = policy.instructions?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
           !instructions.contains("{") {
            return instructions.last.map { ".!?".contains($0) } == true ? instructions : instructions + "."
        }
        switch style {
        case .browserSignIn:
            return "Opens the provider's page in your browser to approve access."
        case .apiKey:
            if let variable = policy.envVars.first(where: { $0.hasSuffix("_API_KEY") }) {
                return "Paste a key from the provider's console; OMP reads it as \(variable)."
            }
            return "Paste a key from the provider's console."
        case .deviceCode:
            return "Shows a one-time code to approve on the provider's page."
        case .vendorToken:
            return "Paste a token issued by the provider."
        }
    }

    static func style(for policy: OMPProviderLoginPolicy) -> Style {
        switch policy.kind {
        case "api-key", "env-only": return .apiKey
        case "oauth-code": return .browserSignIn
        case "device-code": return .deviceCode
        default:
            let deviceHooks: Set<String> = ["openai-codex-device", "github-copilot"]
            if deviceHooks.contains(policy.hook ?? "") || policy.instructions?.contains("{user_code}") == true {
                return .deviceCode
            }
            return .vendorToken
        }
    }

    static func methods(
        for definition: ProviderAuthenticationDefinition,
        catalog: [OMPProviderCatalogEntry]
    ) -> [ProviderLoginMethod] {
        guard definition.id != ProviderAuthenticationDefinition.custom.id else { return [] }
        if ProviderAuthenticationDefinition.canonicalID(definition.id) == "openai" {
            let device = catalog.first { $0.id == OMPProviderCatalogEntry.chatGPTDeviceLoginID }?.login
                ?? .chatGPTDeviceFallback
            // Device code comes first on iPhone: it needs no pasted callback address.
            var methods = [ProviderLoginMethod(
                id: OMPProviderCatalogEntry.chatGPTDeviceLoginID,
                provider: "openai-codex",
                mode: "device",
                policy: device
            )]
            if let browser = catalog.first(where: { $0.id == "openai-codex" }),
               browser.loginPolicy.kind == "oauth-code" {
                methods.append(ProviderLoginMethod(
                    id: browser.id, provider: browser.id, mode: nil, policy: browser.loginPolicy
                ))
            }
            if let entry = catalog.first(where: { $0.id == "openai" }),
               entry.loginPolicy.acceptsKeyEntry, entry.loginPolicy.acceptsAPIKeyMethod {
                methods.append(ProviderLoginMethod(id: entry.id, provider: entry.id, mode: nil, policy: entry.loginPolicy))
            }
            return methods
        }
        guard let entry = catalog.first(where: { $0.id == definition.id }) else { return [] }
        return methods(for: entry)
    }

    /// The methods OMP offers for one catalog entry outside the OpenAI family.
    /// OMP rejects the api-key flow of an `env-only` provider without a key
    /// variable, so such a provider offers no method on iPhone.
    static func methods(for entry: OMPProviderCatalogEntry) -> [ProviderLoginMethod] {
        let policy = entry.loginPolicy
        let primary = ProviderLoginMethod(id: entry.id, provider: entry.id, mode: nil, policy: policy)
        switch policy.kind {
        case "env-only":
            return policy.acceptsAPIKeyMethod ? [primary] : []
        case "api-key":
            return [primary]
        case "oauth-code", "device-code", "custom":
            guard policy.acceptsAPIKeyMethod else { return [primary] }
            return [primary, ProviderLoginMethod(
                id: "\(entry.id):api-key", provider: entry.id, mode: nil, policy: policy.apiKeyMethodPolicy
            )]
        default:
            return []
        }
    }
}

extension ProviderLoginMethod.Style {
    /// How a saved account that used this method is described.
    var accountLabel: String {
        switch self {
        case .browserSignIn: "Browser sign-in"
        case .apiKey: "API key"
        case .deviceCode: "Device code sign-in"
        case .vendorToken: "Vendor token"
        }
    }
}

/// Describes how a saved account signs in. The label comes from the account's
/// provider and OMP's login policy; an auth choice is an account identifier,
/// so only Kordi's own key and ChatGPT prefixes are read from it.
enum ProviderAccountMethod {
    static func label(for account: CloudProviderAuthSnapshot, catalog: [OMPProviderCatalogEntry]) -> String {
        let provider = account.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let family = ProviderAuthenticationDefinition.canonicalID(provider)
        if family == ProviderAuthenticationDefinition.custom.id { return "Custom API" }
        if family == "openai" {
            return provider == "openai" && !account.authChoice.contains("codex") ? "API key" : "ChatGPT account"
        }
        let entry = catalog.first { $0.id == provider }
            ?? catalog.first { ProviderAuthenticationDefinition.canonicalID($0.id) == family }
        var styles: [ProviderLoginMethod.Style] = []
        for method in entry.map(ProviderLoginMethod.methods(for:)) ?? [] where !styles.contains(method.style) {
            styles.append(method.style)
        }
        if styles.count > 1, account.authChoice.hasPrefix("ios-api-key:") { return "API key" }
        // A hosted login saves either method under one kind of auth choice.
        return styles.isEmpty ? "Saved account" : styles.map(\.accountLabel).joined(separator: " or ")
    }
}

extension ProviderAuthenticationDefinition {
    /// OMP's name without a trailing parenthetical or plan tier, for example
    /// "Anthropic (Claude Pro/Max)" -> "Anthropic" and
    /// "ChatGPT Plus/Pro (Codex Subscription)" -> "ChatGPT".
    static func shortName(_ name: String) -> String {
        var result = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = result.range(of: #"\s*\([^()]*\)\s*$"#, options: .regularExpression) {
            result.removeSubrange(range)
        }
        var words = result.split(separator: " ").map(String.init)
        while words.count > 1, words.last?.contains("/") == true { words.removeLast() }
        let short = words.joined(separator: " ")
        return short.isEmpty ? name : short
    }

    /// The trailing parenthetical of an OMP name, such as "Claude Pro/Max".
    static func nameQualifier(_ name: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"\(([^()]*)\)\s*$"#),
              let match = regex.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
              let range = Range(match.range(at: 1), in: name) else { return nil }
        return name[range].trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    var shortName: String { Self.shortName(name) }
    var nameQualifier: String? { Self.nameQualifier(name) }
}

// MARK: - Backend support

/// The one place that decides what a provider-auth failure means. A backend
/// that predates OMP (an HTTP 404 from these routes) or has OMP switched off
/// (503 `provider_auth_not_configured`) stays unavailable until a refresh
/// succeeds. A 503 `omp_unavailable` or `omp_busy` is a passing worker
/// failure, so the action stays available and can be retried.
enum OMPBackendSupport {
    static let notConfiguredCode = "provider_auth_not_configured"
    static let transientCode = "omp_unavailable"
    static let unavailableMessage = "OMP is not available on this backend yet. Saved accounts still work; key verification, route tests and sign-in steps need a newer server."
    static let transientMessage = "OMP is not responding right now. Wait a moment, then try again."

    /// A newer server's own 404s for a missing sign-in or account.
    private static let missingResourceCodes: Set<String> = [
        "login_not_found", "account_unavailable", "provider_auth_not_found",
    ]

    static func isUnavailable(_ error: Error) -> Bool {
        guard let error = error as? CloudAPIError else { return false }
        if error.code == notConfiguredCode { return true }
        return error.statusCode == 404 && !missingResourceCodes.contains(error.code)
    }

    static func isTransient(_ error: Error) -> Bool {
        guard let error = error as? CloudAPIError else { return false }
        return error.code == transientCode || error.code == "omp_busy"
    }
}
