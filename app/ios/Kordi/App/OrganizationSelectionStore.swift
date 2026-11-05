import Foundation
import SwiftUI

/// The account's organizations and the one the session acts in. Choosing an
/// organization exchanges the access token for one bound to it; the account,
/// sign-in, device, caches, and local data stay as they are. A failed
/// exchange keeps the old token and selection.
@MainActor
final class OrganizationSelectionStore: ObservableObject {
    /// Moves the session token to an organization; true once the token acts there.
    typealias TokenSwitch = @MainActor (_ organizationId: String, _ accountId: String) async -> Bool

    static let shared = OrganizationSelectionStore()

    @Published private(set) var organizations: [CloudOrganization] = []
    @Published private(set) var selectedOrganizationId: String?
    private(set) var accountId: String?
    private let defaults: UserDefaults
    private var api: CloudAPIClient?
    private weak var model: AppModel?
    private var mismatchRecovery: Task<String?, Never>?
    /// Replaces the token exchange in tests.
    var tokenSwitchOverride: TokenSwitch?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static func storageKey(accountId: String) -> String {
        "organization.selected.\(accountId)"
    }

    /// Personal first, then the server's order.
    static func ordered(_ organizations: [CloudOrganization]) -> [CloudOrganization] {
        organizations.filter(\.isPersonal) + organizations.filter { !$0.isPersonal }
    }

    /// The stored choice while it is still listed, otherwise the personal organization.
    static func resolvedSelection(storedId: String?, organizations: [CloudOrganization]) -> String? {
        if let storedId, organizations.contains(where: { $0.organizationId == storedId }) {
            return storedId
        }
        return (organizations.first(where: \.isPersonal) ?? organizations.first)?.organizationId
    }

    /// Hidden while the account only has its personal organization.
    var showsSwitcher: Bool { organizations.contains { !$0.isPersonal } }

    /// The team organization to send for new conversations; nil means personal.
    var teamOrganizationId: String? {
        organizations.first { $0.organizationId == selectedOrganizationId && !$0.isPersonal }?.organizationId
    }

    private var personalOrganizationId: String? {
        organizations.first(where: \.isPersonal)?.organizationId
    }

    func refresh(using model: AppModel) async {
        guard !model.isPreviewMode, let (api, token, accountId) = try? model.projectContext() else {
            reset()
            return
        }
        if self.accountId != accountId {
            reset()
            self.accountId = accountId
        }
        self.api = api
        self.model = model
        await api.setOrganizationMismatchHandler { [weak self] organizationId, token in
            await self?.recoverFromMismatch(organizationId: organizationId, token: token)
        }
        do {
            let listed = try await api.listOrganizations(token: token)
            guard self.accountId == accountId else { return }
            apply(listed, accountId: accountId)
        } catch {
            // Silent: keep a list already loaded for this account, otherwise personal.
            guard self.accountId == accountId else { return }
        }
        await reconcileToken(accountId: accountId)
        await publishSelection()
    }

    func apply(_ listed: [CloudOrganization], accountId: String) {
        let key = Self.storageKey(accountId: accountId)
        let ordered = Self.ordered(listed)
        let stored = defaults.string(forKey: key)
        let resolved = Self.resolvedSelection(storedId: stored, organizations: ordered)
        if stored != nil, stored != resolved {
            defaults.removeObject(forKey: key)
        }
        self.accountId = accountId
        organizations = ordered
        selectedOrganizationId = resolved
    }

    func select(_ organizationId: String) {
        Task { await choose(organizationId) }
    }

    /// Switches the session to `organizationId`. The selection moves only
    /// after the token exchange succeeds.
    @discardableResult
    func choose(_ organizationId: String) async -> Bool {
        guard let accountId, organizations.contains(where: { $0.organizationId == organizationId }) else { return false }
        guard organizationId != selectedOrganizationId else { return true }
        guard await switchToken(to: organizationId, accountId: accountId), self.accountId == accountId else { return false }
        defaults.set(organizationId, forKey: Self.storageKey(accountId: accountId))
        selectedOrganizationId = organizationId
        await publishSelection()
        return true
    }

    /// Answers `409 organization_mismatch`: reloads the organizations,
    /// exchanges the token when the selection differs from where the token
    /// acts, and returns the token to retry with. Concurrent mismatches share
    /// one recovery.
    func recoverFromMismatch(organizationId: String?, token: String) async -> String? {
        if let current = currentToken(), current != token { return current }
        if let mismatchRecovery { return await mismatchRecovery.value }
        let task = Task { await self.performMismatchRecovery(organizationId: organizationId) }
        mismatchRecovery = task
        let next = await task.value
        mismatchRecovery = nil
        return next
    }

    private func performMismatchRecovery(organizationId: String?) async -> String? {
        guard let model, let api, let (_, token, accountId) = try? model.projectContext(),
              accountId == self.accountId else { return nil }
        if let listed = try? await api.listOrganizations(token: token), self.accountId == accountId {
            apply(listed, accountId: accountId)
        }
        guard let selected = selectedOrganizationId else { return nil }
        if selected != organizationId {
            guard await switchToken(to: selected, accountId: accountId) else { return nil }
        }
        await publishSelection()
        return currentToken()
    }

    /// Brings the token to the resolved selection. When that fails, the
    /// selection follows the token while its organization is still listed.
    private func reconcileToken(accountId: String) async {
        guard let model, let token = currentToken(), let selected = selectedOrganizationId else { return }
        let tokenOrganization = await model.browserSignIn.store.tokenOrganization(for: token) ?? personalOrganizationId
        guard selected != tokenOrganization, self.accountId == accountId else { return }
        if await switchToken(to: selected, accountId: accountId) { return }
        if let tokenOrganization, self.accountId == accountId,
           organizations.contains(where: { $0.organizationId == tokenOrganization }) {
            selectedOrganizationId = tokenOrganization
        }
    }

    private func switchToken(to organizationId: String, accountId: String) async -> Bool {
        if let tokenSwitchOverride { return await tokenSwitchOverride(organizationId, accountId) }
        guard let model, let (api, token, current) = try? model.projectContext(), current == accountId else { return false }
        let start = OrganizationSwitchStart(accountId: accountId, accessToken: token)
        let result = await model.browserSignIn.store.switchOrganization(to: organizationId, from: start) { presented in
            try await api.exchangeOrganizationToken(token: presented, organizationId: organizationId)
        }
        guard case .switched(let next, let expiresAt, _) = result else { return false }
        if let expiresAt {
            model.applyRefreshedSession(token: next, expiresAt: ISO8601DateFormatter().string(from: expiresAt), accountId: accountId)
        }
        return true
    }

    private func currentToken() -> String? {
        (try? model?.projectContext())?.1
    }

    private func reset() {
        organizations = []
        selectedOrganizationId = nil
        accountId = nil
    }

    private func publishSelection() async {
        guard let api, let accountId else { return }
        await api.selectOrganizationForNewConversations(accountId: accountId, organizationId: teamOrganizationId)
        await api.selectRequestOrganization(accountId: accountId, organizationId: selectedOrganizationId)
        model?.saveShareOrganization(selectedOrganizationId, accountId: accountId)
    }
}

/// Loads the organizations whenever the signed-in account changes.
struct OrganizationSelectionSync: ViewModifier {
    @EnvironmentObject private var model: AppModel

    func body(content: Content) -> some View {
        content.task(id: model.account?.accountId) {
            await OrganizationSelectionStore.shared.refresh(using: model)
        }
    }
}
