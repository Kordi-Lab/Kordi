import Foundation
import SwiftUI

/// The account's organizations and the one new group and AI conversations
/// belong to. The selection is a per-account preference only: changing it
/// never touches sign-in state, the keychain, caches, or local data.
@MainActor
final class OrganizationSelectionStore: ObservableObject {
    static let shared = OrganizationSelectionStore()

    @Published private(set) var organizations: [CloudOrganization] = []
    @Published private(set) var selectedOrganizationId: String?
    private(set) var accountId: String?
    private let defaults: UserDefaults
    private var api: CloudAPIClient?

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
        do {
            let listed = try await api.listOrganizations(token: token)
            guard self.accountId == accountId else { return }
            apply(listed, accountId: accountId)
        } catch {
            // Silent: keep a list already loaded for this account, otherwise personal.
            guard self.accountId == accountId else { return }
        }
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
        guard let accountId, organizations.contains(where: { $0.organizationId == organizationId }) else { return }
        defaults.set(organizationId, forKey: Self.storageKey(accountId: accountId))
        selectedOrganizationId = organizationId
        Task { await publishSelection() }
    }

    private func reset() {
        organizations = []
        selectedOrganizationId = nil
        accountId = nil
    }

    private func publishSelection() async {
        guard let api, let accountId else { return }
        await api.selectOrganizationForNewConversations(accountId: accountId, organizationId: teamOrganizationId)
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
