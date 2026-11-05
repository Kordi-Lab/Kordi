import Foundation

/// The routes Settings › Usage reads.
@MainActor
protocol UsageService: AnyObject {
    func organizations() async throws -> [CloudOrganization]
    func usage(organizationId: String) async throws -> CloudOrganizationUsage
}

@MainActor
final class CloudUsageService: UsageService {
    private let api: CloudAPIClient
    private let tokenProvider: @MainActor () -> String?

    init(api: CloudAPIClient, tokenProvider: @escaping @MainActor () -> String?) {
        self.api = api
        self.tokenProvider = tokenProvider
    }

    private func token() throws -> String {
        guard let token = tokenProvider() else {
            throw CloudAPIError(code: "unauthorized", message: "Sign in to see usage.", statusCode: 401)
        }
        return token
    }

    func organizations() async throws -> [CloudOrganization] {
        try await api.organizations(token: token())
    }

    func usage(organizationId: String) async throws -> CloudOrganizationUsage {
        try await api.organizationUsage(token: token(), organizationId: organizationId)
    }
}

/// Offline sample usage for `--preview-data`.
@MainActor
final class PreviewUsageService: UsageService {
    func organizations() async throws -> [CloudOrganization] {
        [
            CloudOrganization(organizationId: "org_personal", name: "Personal", kind: "personal", role: "owner"),
            CloudOrganization(organizationId: "org_team", name: "Design team", kind: "team", role: "member"),
        ]
    }

    func usage(organizationId: String) async throws -> CloudOrganizationUsage {
        let resetsAt = "2026-01-01T00:00:00Z"
        if organizationId == "org_team" {
            return CloudOrganizationUsage(organizationId: organizationId, role: "member", snapshots: [
                CloudUsageSnapshot(limitId: "pool.runs", scope: "pool", usedPercent: 100, resetsAt: resetsAt, reached: "daily_limit"),
            ])
        }
        return CloudOrganizationUsage(organizationId: organizationId, role: "owner", snapshots: [
            CloudUsageSnapshot(limitId: "pool.runs", scope: "pool", used: 7, limit: 10, usedPercent: 70, resetsAt: resetsAt),
            CloudUsageSnapshot(limitId: "pool.spend", scope: "pool", used: 400_000, limit: 1_000_000, usedPercent: 40, resetsAt: resetsAt),
            CloudUsageSnapshot(limitId: "account.grounding_runs", scope: "account", used: 2, limit: 20, usedPercent: 10, resetsAt: resetsAt),
        ], notices: [CloudUsageNotice(threshold: 75, at: resetsAt)])
    }
}

@MainActor
final class UsageSettingsModel: ObservableObject {
    struct Section: Identifiable, Hashable {
        let organization: CloudOrganization
        /// Nil when this organization's usage could not load.
        let usage: CloudOrganizationUsage?

        var id: String { organization.organizationId }
    }

    @Published private(set) var sections: [Section] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var errorMessage: String?

    private let service: any UsageService
    private let onOrganizations: @MainActor ([CloudOrganization]) -> Void

    init(service: any UsageService, onOrganizations: @escaping @MainActor ([CloudOrganization]) -> Void = { _ in }) {
        self.service = service
        self.onOrganizations = onOrganizations
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let organizations = try await service.organizations()
            onOrganizations(organizations)
            let service = service
            var usages: [String: CloudOrganizationUsage] = [:]
            await withTaskGroup(of: (String, CloudOrganizationUsage?).self) { group in
                for organization in organizations {
                    let id = organization.organizationId
                    group.addTask { @MainActor in (id, try? await service.usage(organizationId: id)) }
                }
                for await (id, usage) in group {
                    if let usage { usages[id] = usage }
                }
            }
            sections = organizations.map { Section(organization: $0, usage: usages[$0.organizationId]) }
            errorMessage = nil
            hasLoaded = true
        } catch {
            errorMessage = (error as? CloudAPIError)?.message ?? "Could not load usage."
        }
    }
}
