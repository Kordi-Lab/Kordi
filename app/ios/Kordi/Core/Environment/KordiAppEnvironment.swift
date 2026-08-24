import Foundation

enum KordiDistributionChannel: String, Equatable {
    case production
    case beta
}

enum KordiAppEnvironmentError: LocalizedError, Equatable {
    case missingSetting(String)
    case invalidSetting(String)

    var errorDescription: String? {
        switch self {
        case .missingSetting(let key):
            "The required iOS build setting \(key) is missing."
        case .invalidSetting(let key):
            "The iOS build setting \(key) does not match its distribution channel."
        }
    }
}

struct KordiAppEnvironment: Equatable {
    static let productionBundleIdentifier = "ai.kordi.ios"
    static let betaBundleIdentifier = "ai.kordi.ios.beta"
    static let productionBaseURL = URL(string: "https://kordi.ai")!
    static let betaBaseURL = URL(string: "http://127.0.0.1:17081")!

    let channel: KordiDistributionChannel
    let bundleIdentifier: String
    let cloudBaseURL: URL
    let oauthCallbackURL: URL

    var keychainService: String { bundleIdentifier }

    static var current: KordiAppEnvironment {
        do {
            return try configured(
                infoDictionary: Bundle.main.infoDictionary ?? [:],
                bundleIdentifier: Bundle.main.bundleIdentifier
            )
        } catch {
            preconditionFailure("Unsafe Kordi iOS environment: \(error.localizedDescription)")
        }
    }

    static func configured(
        infoDictionary: [String: Any],
        bundleIdentifier: String?
    ) throws -> KordiAppEnvironment {
        let channelValue = try setting("KordiDistributionChannel", in: infoDictionary)
        guard let channel = KordiDistributionChannel(rawValue: channelValue) else {
            throw KordiAppEnvironmentError.invalidSetting("KordiDistributionChannel")
        }

        let baseURLValue = try setting("KordiCloudBaseURL", in: infoDictionary)
        guard let baseURL = URL(string: baseURLValue) else {
            throw KordiAppEnvironmentError.invalidSetting("KordiCloudBaseURL")
        }

        let callbackScheme = try setting("KordiOAuthCallbackScheme", in: infoDictionary)
        guard let callbackURL = URL(string: "\(callbackScheme)://oauth/callback"),
              let bundleIdentifier,
              !bundleIdentifier.isEmpty else {
            throw KordiAppEnvironmentError.missingSetting("CFBundleIdentifier")
        }

        switch channel {
        case .production:
            guard bundleIdentifier == productionBundleIdentifier else {
                throw KordiAppEnvironmentError.invalidSetting("CFBundleIdentifier")
            }
            guard callbackScheme == "kordi" else {
                throw KordiAppEnvironmentError.invalidSetting("KordiOAuthCallbackScheme")
            }
            guard isExactProductionURL(baseURL) else {
                throw KordiAppEnvironmentError.invalidSetting("KordiCloudBaseURL")
            }
        case .beta:
            guard bundleIdentifier == betaBundleIdentifier else {
                throw KordiAppEnvironmentError.invalidSetting("CFBundleIdentifier")
            }
            guard callbackScheme == "kordi-beta" else {
                throw KordiAppEnvironmentError.invalidSetting("KordiOAuthCallbackScheme")
            }
            guard isLoopbackBetaURL(baseURL) || isTemporaryPhysicalDeviceRelayURL(baseURL) else {
                throw KordiAppEnvironmentError.invalidSetting("KordiCloudBaseURL")
            }
        }

        return KordiAppEnvironment(
            channel: channel,
            bundleIdentifier: bundleIdentifier,
            cloudBaseURL: baseURL,
            oauthCallbackURL: callbackURL
        )
    }

    static func permitsAPIBaseURL(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "https" {
            return true
        }
        return url.scheme?.lowercased() == "http"
            && ["127.0.0.1", "localhost"].contains(url.host?.lowercased() ?? "")
    }

    private static func setting(_ key: String, in dictionary: [String: Any]) throws -> String {
        guard let value = dictionary[key] as? String else {
            throw KordiAppEnvironmentError.missingSetting(key)
        }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, !normalized.contains("$(") else {
            throw KordiAppEnvironmentError.invalidSetting(key)
        }
        return normalized
    }

    private static func isExactProductionURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "kordi.ai"
            && url.port == nil
            && hasNoExtraURLComponents(url)
    }

    private static func isLoopbackBetaURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http"
            && url.host?.lowercased() == "127.0.0.1"
            && url.port != nil
            && hasNoExtraURLComponents(url)
    }

    private static func isTemporaryPhysicalDeviceRelayURL(_ url: URL) -> Bool {
        #if KORDI_PHYSICAL_DEVICE_RELAY
        guard let host = url.host else { return false }
        return url.scheme?.lowercased() == "https"
            && host.contains(":")
            && url.port != nil
            && hasNoExtraURLComponents(url)
        #else
        return false
        #endif
    }

    private static func hasNoExtraURLComponents(_ url: URL) -> Bool {
        (url.path.isEmpty || url.path == "/")
            && url.user == nil
            && url.password == nil
            && url.query == nil
            && url.fragment == nil
    }
}
