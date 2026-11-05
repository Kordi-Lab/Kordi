import Foundation

/// The route Settings › Usage reads.
@MainActor
protocol UsageService: AnyObject {
    func accountUsage() async throws -> CloudAccountUsage
}

@MainActor
final class CloudUsageService: UsageService {
    private let api: CloudAPIClient
    private let tokenProvider: @MainActor () -> String?

    init(api: CloudAPIClient, tokenProvider: @escaping @MainActor () -> String?) {
        self.api = api
        self.tokenProvider = tokenProvider
    }

    func accountUsage() async throws -> CloudAccountUsage {
        guard let token = tokenProvider() else {
            throw CloudAPIError(code: "unauthorized", message: "Sign in to see usage.", statusCode: 401)
        }
        return try await api.accountUsage(token: token)
    }
}

/// Offline sample usage for `--preview-data`.
@MainActor
final class PreviewUsageService: UsageService {
    func accountUsage() async throws -> CloudAccountUsage {
        let resetsAt = "2026-01-01T00:00:00Z"
        return CloudAccountUsage(organizations: [
            CloudOrganizationUsageSummary(organizationId: "org_personal", name: "Personal", kind: "personal", role: "owner", snapshots: [
                CloudUsageSnapshot(limitId: "pool.runs", scope: "pool", used: 7, limit: 10, usedPercent: 70, resetsAt: resetsAt),
                CloudUsageSnapshot(limitId: "pool.spend", scope: "pool", used: 800_000, limit: 1_000_000, usedPercent: 80, resetsAt: resetsAt),
                CloudUsageSnapshot(limitId: "account.grounding_runs", scope: "account", used: 2, limit: 20, usedPercent: 10, resetsAt: resetsAt),
            ]),
            CloudOrganizationUsageSummary(organizationId: "org_team", name: "Design team", kind: "team", role: "member", snapshots: [
                CloudUsageSnapshot(limitId: "conversation.system_agent_runs", scope: "conversation", usedPercent: 100,
                                   resetsAt: resetsAt, reached: "daily_limit", pausedSince: "2025-12-31T14:20:00Z"),
            ]),
        ])
    }
}

@MainActor
final class UsageSettingsModel: ObservableObject {
    @Published private(set) var organizations: [CloudOrganizationUsageSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var errorMessage: String?

    private let service: any UsageService

    init(service: any UsageService) {
        self.service = service
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            organizations = try await service.accountUsage().organizations
            errorMessage = nil
            hasLoaded = true
        } catch {
            errorMessage = (error as? CloudAPIError)?.message ?? "Could not load usage."
        }
    }
}
