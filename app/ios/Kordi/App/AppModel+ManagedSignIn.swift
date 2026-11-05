import Foundation

/// The result of the managed device membership check.
enum ManagedOrganizationCheck: Equatable {
    /// No organization restriction, or the account qualifies.
    case allowed
    /// The server answered and the account does not qualify.
    case refused
    /// No usable answer.
    case failed
}

/// Thrown at launch when the restored account no longer qualifies.
struct ManagedSignInRefusal: Error {
    let accountId: String
    let token: String
}

// Managed device pinning for AppModel. The rules live in
// docs/development/managed-devices.md.
extension AppModel {
    /// Re-reads Managed App Configuration, which device management can
    /// replace at any time, and returns the current policy.
    @discardableResult
    func reloadManagedSignInPolicy() -> ManagedSignInPolicy {
        let next = ManagedSignInPolicy.current()
        if next != managedSignInPolicy { managedSignInPolicy = next }
        return next
    }

    /// Loads the account's organizations with `token` and checks them against
    /// the current policy. Preview mode and unrestricted devices never ask.
    func managedOrganizationCheck(token: String) async -> ManagedOrganizationCheck {
        let policy = reloadManagedSignInPolicy()
        guard policy.restrictsOrganizations, !isPreviewMode else { return .allowed }
        guard let response = try? await api.accountOrganizations(token: token) else { return .failed }
        return policy.accountSatisfies(response) ? .allowed : .refused
    }

    /// The message that ends a new sign-in, or nil when it may be kept. The
    /// caller revokes the new session when this returns a message.
    func managedSignInRefusal(token: String) async -> String? {
        switch await managedOrganizationCheck(token: token) {
        case .allowed: return nil
        case .refused: return ManagedSignInPolicy.refusedMessage
        case .failed: return ManagedSignInPolicy.checkFailedMessage
        }
    }

    /// Whether the current policy offers `method`. Sets the error otherwise.
    func managedSignInAllows(_ method: ManagedSignInMethod) -> Bool {
        let policy = reloadManagedSignInPolicy()
        guard !policy.allows(method) else { return true }
        errorMessage = policy.allowsAnyMethod ? ManagedSignInPolicy.methodNotAllowedMessage : ManagedSignInPolicy.noMethodsMessage
        return false
    }

    /// Called when user defaults change. A new managed configuration is
    /// checked against the signed-in account right away.
    func managedConfigurationMayHaveChanged() async {
        let previous = managedSignInPolicy
        guard reloadManagedSignInPolicy() != previous else { return }
        await enforceManagedOrganization()
    }
}
