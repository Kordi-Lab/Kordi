import Foundation

/// The memory routes the Memory screen uses. The cloud service calls the
/// account routes; the preview service keeps sample memories in memory.
@MainActor
protocol MemoryService: AnyObject {
    func list() async throws -> CloudMemoryListResponse
    func update(memoryId: String, text: String) async throws -> CloudMemory
    func delete(memoryId: String) async throws
    func forgetAll() async throws -> Int
    func updateSettings(memoryEnabled: Bool?, excludeSensitive: Bool?) async throws -> CloudMemorySettings
    func replayRunCount() async throws -> Int
    func clearReplayState() async throws -> Int
}

@MainActor
final class CloudMemoryService: MemoryService {
    private let api: CloudAPIClient
    private let tokenProvider: @MainActor () -> String?

    init(api: CloudAPIClient, tokenProvider: @escaping @MainActor () -> String?) {
        self.api = api
        self.tokenProvider = tokenProvider
    }

    private func token() throws -> String {
        guard let token = tokenProvider() else {
            throw CloudAPIError(code: "unauthorized", message: "Sign in to manage memory.", statusCode: 401)
        }
        return token
    }

    func list() async throws -> CloudMemoryListResponse {
        try await api.listMemories(token: token())
    }

    func update(memoryId: String, text: String) async throws -> CloudMemory {
        try await api.updateMemory(token: token(), memoryId: memoryId, text: text)
    }

    func delete(memoryId: String) async throws {
        try await api.deleteMemory(token: token(), memoryId: memoryId)
    }

    func forgetAll() async throws -> Int {
        try await api.forgetAllMemories(token: token())
    }

    func updateSettings(memoryEnabled: Bool?, excludeSensitive: Bool?) async throws -> CloudMemorySettings {
        try await api.updateMemorySettings(token: token(), memoryEnabled: memoryEnabled, excludeSensitive: excludeSensitive)
    }

    func replayRunCount() async throws -> Int {
        try await api.replayState(token: token()).runCount
    }

    func clearReplayState() async throws -> Int {
        try await api.clearReplayState(token: token())
    }
}

/// Offline sample memories for `--preview-data`. They match the desktop
/// preview client (`app/desktop/src/features/memory/memoryClient.ts`).
@MainActor
final class PreviewMemoryService: MemoryService {
    private var memories: [CloudMemory]
    private var settings = CloudMemorySettings(memoryEnabled: true, excludeSensitive: true)
    private var runCount = 6
    private let latency: Duration

    init(now: Date = Date(), latency: Duration = .milliseconds(300)) {
        self.latency = latency
        memories = Self.samples(now: now)
    }

    static func samples(now: Date) -> [CloudMemory] {
        let formatter = ISO8601DateFormatter()
        func memory(
            _ id: String,
            _ scope: CloudMemoryScope,
            _ scopeId: String,
            _ scopeLabel: String,
            _ source: CloudMemorySource,
            _ text: String,
            hoursAgo: Double
        ) -> CloudMemory {
            let at = formatter.string(from: now.addingTimeInterval(-hoursAgo * 3_600))
            return CloudMemory(memoryId: id, scope: scope, scopeId: scopeId, scopeLabel: scopeLabel, source: source, text: text, createdAt: at, updatedAt: at)
        }
        return [
            memory("lesson-1", .conversation, "conv-launch-copy", "Launch copy with Priya", .userCorrection,
                   "Keep launch headlines under eight words and write them in sentence case, not title case.", hoursAgo: 2),
            memory("lesson-2", .conversation, "conv-launch-copy", "Launch copy with Priya", .outcome,
                   "Priya approved the second draft once the pricing line moved below the feature list. Lead with what the product does.", hoursAgo: 3 * 24),
            memory("lesson-3", .conversation, "conv-weekly-planning", "Weekly planning", .manual,
                   "Plan the week on Monday mornings and list at most three priorities, each with one owner.", hoursAgo: 24 + 2),
            memory("lesson-4", .conversation, "conv-weekly-planning", "Weekly planning", .userCorrection,
                   "Do not move unfinished tasks to the next week automatically. Ask which ones still matter first.", hoursAgo: 12 * 24),
            memory("lesson-5", .project, "proj-launch-site", "~/Projects/launch-site", .repeatedFailure,
                   "The site build fails when images are added without width and height. Set both before running the build again.", hoursAgo: 5 * 24),
            memory("lesson-6", .project, "proj-kordi-plugins", "~/Projects/kordi-plugins", .outcome,
                   "Plugin tests pass only after the sample config is copied into the test folder. Copy it before the first run.", hoursAgo: 21 * 24),
            memory("lesson-7", .group, "group-design-review", "Design review", .repeatedFailure,
                   "Share screenshots as attachments instead of links. Several members could not open the shared folder links.", hoursAgo: 40 * 24),
        ]
    }

    private func wait() async throws {
        try await Task.sleep(for: latency)
    }

    func list() async throws -> CloudMemoryListResponse {
        try await wait()
        return CloudMemoryListResponse(memories: memories, settings: settings)
    }

    func update(memoryId: String, text: String) async throws -> CloudMemory {
        try await wait()
        guard case .valid(let normalized) = MemoryPresentation.validate(text) else {
            throw CloudAPIError(code: "memory_rejected", message: "Memories are \(MemoryPresentation.maxCharacters) characters or fewer.", statusCode: 422)
        }
        guard let index = memories.firstIndex(where: { $0.memoryId == memoryId }) else {
            throw CloudAPIError(code: "memory_not_found", message: "This memory no longer exists.", statusCode: 404)
        }
        memories[index].text = normalized
        memories[index].updatedAt = ISO8601DateFormatter().string(from: Date())
        return memories[index]
    }

    func delete(memoryId: String) async throws {
        try await wait()
        memories.removeAll { $0.memoryId == memoryId }
    }

    func forgetAll() async throws -> Int {
        try await wait()
        let archived = memories.count
        memories = []
        return archived
    }

    func updateSettings(memoryEnabled: Bool?, excludeSensitive: Bool?) async throws -> CloudMemorySettings {
        try await wait()
        if let memoryEnabled { settings.memoryEnabled = memoryEnabled }
        if let excludeSensitive { settings.excludeSensitive = excludeSensitive }
        return settings
    }

    func replayRunCount() async throws -> Int {
        try await wait()
        return runCount
    }

    func clearReplayState() async throws -> Int {
        try await wait()
        defer { runCount = 0 }
        return runCount
    }
}

@MainActor
final class MemorySettingsModel: ObservableObject {
    @Published private(set) var settings: CloudMemorySettings?
    @Published private(set) var memories: [CloudMemory] = []
    /// Nil hides the Replay state section, for example when the request fails.
    @Published private(set) var replayRunCount: Int?
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var isLoading = false
    @Published private(set) var isUpdatingSettings = false
    @Published private(set) var isMutating = false
    @Published var errorMessage: String?

    let accountLabel: String?
    private let service: any MemoryService

    init(service: any MemoryService, accountLabel: String?) {
        self.service = service
        self.accountLabel = accountLabel
    }

    var hasLoaded: Bool { settings != nil }
    var groups: [MemoryPresentation.Group] { MemoryPresentation.groups(memories) }

    func syncCaption(now: Date = Date()) -> String? {
        guard let accountLabel else { return nil }
        return MemoryPresentation.syncCaption(accountLabel: accountLabel, lastSyncedAt: lastSyncedAt, now: now)
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await service.list()
            settings = response.settings
            memories = response.memories
            lastSyncedAt = Date()
            errorMessage = nil
        } catch {
            report(error, fallback: "Could not load memory settings.")
        }
        // A failed replay lookup hides the section instead of blocking the page.
        replayRunCount = try? await service.replayRunCount()
    }

    func setMemoryEnabled(_ enabled: Bool) async {
        await updateSettings(memoryEnabled: enabled, excludeSensitive: nil)
    }

    func setExcludeSensitive(_ exclude: Bool) async {
        await updateSettings(memoryEnabled: nil, excludeSensitive: exclude)
    }

    private func updateSettings(memoryEnabled: Bool?, excludeSensitive: Bool?) async {
        isUpdatingSettings = true
        defer { isUpdatingSettings = false }
        do {
            settings = try await service.updateSettings(memoryEnabled: memoryEnabled, excludeSensitive: excludeSensitive)
            lastSyncedAt = Date()
            errorMessage = nil
        } catch {
            report(error, fallback: "Could not update memory settings. Try again.")
        }
    }

    /// Saves an edit and returns an error message to show inline, or nil on success.
    func save(memoryId: String, draft: String) async -> String? {
        let text: String
        switch MemoryPresentation.validate(draft) {
        case .invalid(let reason): return reason
        case .valid(let normalized): text = normalized
        }
        do {
            let updated = try await service.update(memoryId: memoryId, text: text)
            memories = memories.map { $0.memoryId == memoryId ? updated : $0 }
            lastSyncedAt = Date()
            return nil
        } catch {
            return Self.message(for: error, fallback: "Could not save this memory. Try again.")
        }
    }

    func delete(_ memory: CloudMemory) async {
        await mutate(fallback: "Could not delete this memory. Try again.") {
            try await self.service.delete(memoryId: memory.memoryId)
            self.memories.removeAll { $0.memoryId == memory.memoryId }
            self.lastSyncedAt = Date()
        }
    }

    func forgetAll() async {
        await mutate(fallback: "Could not delete your memories. Try again.") {
            _ = try await self.service.forgetAll()
            self.memories = []
            self.lastSyncedAt = Date()
        }
    }

    func clearReplayState() async {
        await mutate(fallback: "Could not clear replay state. Try again.") {
            _ = try await self.service.clearReplayState()
            self.replayRunCount = 0
        }
    }

    private func mutate(fallback: String, _ action: @escaping () async throws -> Void) async {
        isMutating = true
        defer { isMutating = false }
        do {
            try await action()
            errorMessage = nil
        } catch {
            report(error, fallback: fallback)
        }
    }

    private func report(_ error: Error, fallback: String) {
        guard !CloudTransportErrorPolicy.isCancellation(error) else { return }
        errorMessage = Self.message(for: error, fallback: fallback)
    }

    static func message(for error: Error, fallback: String) -> String {
        if let apiError = error as? CloudAPIError, !apiError.message.isEmpty { return apiError.message }
        return fallback
    }
}
