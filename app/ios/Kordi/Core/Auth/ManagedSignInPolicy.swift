import Foundation

// Managed device pinning. The contract lives in
// docs/development/managed-devices.md: an organization's device management
// system limits the sign-in methods and the organizations whose accounts the
// app keeps. The policy comes only from Managed App Configuration, never from
// a server response.

enum ManagedSignInMethod: String, CaseIterable, Equatable, Sendable {
    case google
    case github
    /// Password sign-in, sign-up and email codes.
    case email
}

extension CloudOAuthProvider {
    var managedSignInMethod: ManagedSignInMethod {
        switch self {
        case .google: .google
        case .github: .github
        }
    }
}

struct ManagedSignInPolicy: Equatable, Sendable {
    static let configurationKey = "com.apple.configuration.managed"
    static let methodsKey = "allowed_sign_in_methods"
    static let organizationsKey = "allowed_organizations"

    static let noMethodsMessage = "This device does not allow any sign-in method."
    static let methodNotAllowedMessage = "This device does not allow this sign-in method."
    static let refusedMessage = "This device only allows accounts from your organization."
    static let checkFailedMessage = "Could not check your organization. Try again."
    static let signedOutMessage = "You were signed out because this device only allows accounts from your organization."

    /// Nil when the key is missing: every method is allowed.
    let allowedMethods: [ManagedSignInMethod]?
    /// Nil when the key is missing: any account is kept.
    let allowedOrganizations: [String]?

    static let unrestricted = ManagedSignInPolicy(allowedMethods: nil, allowedOrganizations: nil)

    /// The policy for this app. Only the Kordi Beta app reads Managed App
    /// Configuration for now; every other build is unrestricted.
    static func current(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        defaults: UserDefaults = .standard
    ) -> ManagedSignInPolicy {
        #if BETA
        guard bundleIdentifier == KordiAppEnvironment.betaBundleIdentifier else { return .unrestricted }
        return parse(defaults.dictionary(forKey: configurationKey))
        #else
        return .unrestricted
        #endif
    }

    /// A missing key restricts nothing. A present key restricts to its valid
    /// entries, so a key with no valid entry, or a value that is not an array
    /// of strings, allows nothing.
    static func parse(_ configuration: [String: Any]?) -> ManagedSignInPolicy {
        guard let configuration else { return .unrestricted }
        let methods = configuration[methodsKey].map { value in
            unique(strings(value).compactMap { ManagedSignInMethod(rawValue: $0.lowercased()) })
        }
        let organizations = configuration[organizationsKey].map { value in
            unique(strings(value).filter { !$0.isEmpty })
        }
        return ManagedSignInPolicy(allowedMethods: methods, allowedOrganizations: organizations)
    }

    var isRestricted: Bool { allowedMethods != nil || allowedOrganizations != nil }
    var restrictsOrganizations: Bool { allowedOrganizations != nil }

    func allows(_ method: ManagedSignInMethod) -> Bool {
        allowedMethods?.contains(method) ?? true
    }

    var allowsAnyMethod: Bool {
        ManagedSignInMethod.allCases.contains(where: allows)
    }

    /// The first allowed organization, sent so the sign-in page can open on it.
    var organizationHint: String? { allowedOrganizations?.first }

    /// The allowed methods as a comma list, when methods are restricted.
    var signInMethodsHint: String? {
        guard let allowedMethods, !allowedMethods.isEmpty else { return nil }
        return allowedMethods.map(\.rawValue).joined(separator: ",")
    }

    /// Query fields for the browser sign-in authorize URL. Hints only shape
    /// the page; the callback check is what enforces the organization.
    var authorizeHintFields: [(String, String)] {
        var fields: [(String, String)] = []
        if let organizationHint { fields.append(("organization_hint", organizationHint)) }
        if let signInMethodsHint { fields.append(("sign_in_methods", signInMethodsHint)) }
        return fields
    }

    /// Whether the account is an active member of an allowed organization.
    func accountSatisfies(_ response: CloudAccountOrganizations) -> Bool {
        guard let allowedOrganizations else { return true }
        let allowed = Set(allowedOrganizations)
        func isAllowed(_ id: String?) -> Bool {
            guard let id else { return false }
            return allowed.contains(id)
        }
        if response.organizations.contains(where: { isAllowed($0.organizationId) }) {
            return true
        }
        return response.configured.contains { entry in
            (entry.admission == "member" || entry.admission == "reverify")
                && (isAllowed(entry.id) || isAllowed(entry.organizationId))
        }
    }

    private static func strings(_ value: Any) -> [String] {
        guard let array = value as? [Any] else { return [] }
        // Any entry that is not a string makes the whole value invalid.
        var result: [String] = []
        for entry in array {
            guard let string = entry as? String else { return [] }
            result.append(string.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return result
    }

    private static func unique<T: Hashable>(_ values: [T]) -> [T] {
        var seen = Set<T>()
        return values.filter { seen.insert($0).inserted }
    }
}

/// `GET /v1/cloud/account/organizations`, reduced to what the membership
/// check reads. `organizations` is required so an unrelated answer is never
/// taken as "no memberships".
struct CloudAccountOrganizations: Decodable, Equatable, Sendable {
    struct Membership: Decodable, Equatable, Sendable {
        let organizationId: String?
    }

    struct Configured: Decodable, Equatable, Sendable {
        let id: String?
        let organizationId: String?
        let admission: String?
    }

    let organizations: [Membership]
    let configured: [Configured]

    init(organizations: [Membership], configured: [Configured]) {
        self.organizations = organizations
        self.configured = configured
    }

    private enum CodingKeys: String, CodingKey {
        case organizations
        case configured
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        organizations = try container.decode([Membership].self, forKey: .organizations)
        configured = try container.decodeIfPresent([Configured].self, forKey: .configured) ?? []
    }
}

extension CloudAPIClient {
    func accountOrganizations(token: String) async throws -> CloudAccountOrganizations {
        try await send(
            path: "/v1/cloud/account/organizations",
            method: "GET",
            token: token,
            fallback: ManagedSignInPolicy.checkFailedMessage
        )
    }

    /// `organizationHint` for `GET /v1/cloud/auth/oauth/:provider/start`.
    static func oauthStartHintItems(organizationHint: String?) -> [URLQueryItem] {
        guard let hint = organizationHint?.trimmingCharacters(in: .whitespacesAndNewlines), !hint.isEmpty else { return [] }
        return [URLQueryItem(name: "organizationHint", value: hint)]
    }
}
