import CFNetwork
import Foundation

/// One proxy policy for every Kordi Apple transport.
///
/// Kordi Cloud traffic follows the system proxy settings while they work. A
/// proxy problem must never stop app usage, so the policy is:
///
/// - loopback API origins always connect directly,
/// - requests never wait indefinitely for a proxy that cannot be reached,
/// - a failure that happened before any bytes reached the network is retried
///   once directly, and
/// - a request that still cannot be routed fails fast with an actionable
///   error instead of hanging in a sending state.
enum NetworkProxyPolicy {
    enum SystemState: Equatable {
        case direct
        case manualProxy
        case automaticProxy
    }

    static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    /// Failures raised before any request bytes reach the network. Retrying
    /// these directly cannot duplicate a server-side effect.
    static func isDirectRetryEligible(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        switch error.code {
        case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .notConnectedToInternet:
            return true
        default:
            return false
        }
    }

    static var systemState: SystemState {
        state(systemProxySettings: currentSystemSettings())
    }

    /// The PAC keys are macOS-only constants, so the parser reads the shared
    /// SystemConfiguration names directly and tolerates their absence.
    static func state(systemProxySettings settings: [String: Any]) -> SystemState {
        if flag(settings["ProxyAutoConfigEnable"]) || flag(settings["ProxyAutoDiscoveryEnable"]) {
            return .automaticProxy
        }
        if flag(settings["HTTPEnable"]) || flag(settings["HTTPSEnable"]) || flag(settings["SOCKSEnable"]) {
            return .manualProxy
        }
        return .direct
    }

    static func failureMessage(for state: SystemState, fallback: String) -> String {
        switch state {
        case .automaticProxy:
            return "Kordi can't use this Wi-Fi network's automatic proxy configuration. Turn it off in Wi-Fi settings, or connect to another network."
        case .manualProxy:
            return "Kordi can't reach this Wi-Fi network's proxy server. Check the Wi-Fi proxy settings, or connect to another network."
        case .direct:
            return fallback
        }
    }

    static func currentSystemSettings() -> [String: Any] {
        guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() else { return [:] }
        return settings as NSDictionary as? [String: Any] ?? [:]
    }

    private static func flag(_ value: Any?) -> Bool {
        switch value {
        case let number as NSNumber:
            return number.boolValue
        case let string as String:
            return string == "1"
        default:
            return false
        }
    }
}
