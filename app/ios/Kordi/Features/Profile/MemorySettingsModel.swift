import Foundation

/// The memory routes the Memory screen uses. The cloud service calls the
/// account routes; the preview service keeps sample memories in memory.
@MainActor
protocol MemoryService: AnyObject {
    func list() async throws -> CloudMemoryListResponse
    func create(target: MemoryAddTarget, text: String) async throws -> CloudMemory
    func update(memoryId: String, text: String) async throws -> CloudMemory
    func delete(memoryId: String) async throws
    func forgetAll() async throws -> Int
    func updateSettings(memoryEnabled: Bool?, excludeSensitive: Bool?) async throws -> CloudMemorySettings
    /// The cloud ids of the group conversations whose client session id is `sessionId`.
    func cloudGroupConversationIds(sessionId: String) async -> [String]
    /// Changes a memory's category or cards (`memoryVersion` 3).
    func change(memoryId: String, _ request: CloudMemoryUpdateRequest) async throws -> CloudMemory
    /// The owner's cards, in profile order; empty when they cannot load.
    func cards() async -> [MemoryCard]
    /// The cloud conversations already loaded, for group names.
    func cloudConversations() async -> [CloudChatConversation]
}

extension MemoryService {
    func cloudGroupConversationIds(sessionId: String) async -> [String] { [] }
    func change(memoryId: String, _ request: CloudMemoryUpdateRequest) async throws -> CloudMemory {
        throw CloudAPIError(code: "invalid_update", message: "Could not change this memory. Try again.", statusCode: 400)
    }
    func cards() async -> [MemoryCard] { [] }
    func cloudConversations() async -> [CloudChatConversation] { [] }
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

    func create(target: MemoryAddTarget, text: String) async throws -> CloudMemory {
        try await api.createMemory(token: token(), target: target, text: text)
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

    func change(memoryId: String, _ request: CloudMemoryUpdateRequest) async throws -> CloudMemory {
        try await api.changeMemory(token: token(), memoryId: memoryId, request)
    }

    func cards() async -> [MemoryCard] {
        guard let token = tokenProvider(), let list = try? await api.commonGroundProfiles(token: token) else { return [] }
        return list.profiles.sorted { $0.position < $1.position }.map(MemoryCard.init(profile:))
    }

    func cloudConversations() async -> [CloudChatConversation] {
        await api.cachedChatConversations()
    }

    func cloudGroupConversationIds(sessionId: String) async -> [String] {
        let sessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionId.isEmpty else { return [] }
        return await api.cachedChatConversations()
            .filter { $0.kind == "group" && $0.legacySessionId?.trimmingCharacters(in: .whitespacesAndNewlines) == sessionId }
            .map(\.id)
    }
}

/// Offline sample memories for `--preview-data`. They match the desktop
/// preview client (`app/desktop/src/features/memory/memoryClient.ts`).
@MainActor
final class PreviewMemoryService: MemoryService {
    private var memories: [CloudMemory]
    private var settings = CloudMemorySettings(memoryEnabled: true, excludeSensitive: true)
    private var previewCards = PreviewMemoryCards()
    private var addedCount = 0
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
            return CloudMemory(memoryId: id, scope: scope, scopeId: scopeId, scopeLabel: scopeLabel, source: source, text: text,
                               createdAt: at, updatedAt: at, category: sampleCategories[id])
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
            // Matches the preview group conversation `group:mobile` (session id `session:group:mobile`).
            memory("lesson-7", .group, "mobile", "Mobile builders", .repeatedFailure,
                   "Share screenshots as attachments instead of links. Several members could not open the shared folder links.", hoursAgo: 40 * 24),
            memory("lesson-8", .global, "account", "", .userCorrection,
                   "Answer in British English and keep replies short unless I ask for more detail.", hoursAgo: 4),
            memory("lesson-9", .global, "account", "", .manual,
                   "Write times in the 24-hour clock and dates as 2026-10-10 in schedules and plans.", hoursAgo: 6 * 24),
            // Another member of the preview group saved this one.
            {
                var shared = memory("lesson-10", .group, "mobile", "Mobile builders", .manual,
                                    "Post review notes in the thread before Friday so everyone can read them over the weekend.", hoursAgo: 3 * 24)
                shared.ownerAccountId = "acct_priya"
                shared.ownerName = "Priya"
                return shared
            }(),
        ]
    }

    /// Categories for the samples, so rows show their chips in previews.
    private static let sampleCategories: [String: String] = [
        "lesson-1": "general_preferences", "lesson-2": "work_context", "lesson-3": "coordination_context",
        "lesson-4": "hcp-custom:task_lessons", "lesson-5": "hcp-custom:task_lessons", "lesson-6": "hcp-custom:task_lessons",
        "lesson-7": "general_preferences", "lesson-8": "general_preferences", "lesson-9": "coordination_context",
        "lesson-10": "goals_and_constraints",
    ]

    private func wait() async throws {
        try await Task.sleep(for: latency)
    }

    func list() async throws -> CloudMemoryListResponse {
        try await wait()
        return CloudMemoryListResponse(memories: memories.map(previewCards.filled), settings: settings)
    }

    func create(target: MemoryAddTarget, text: String) async throws -> CloudMemory {
        try await wait()
        guard case .valid(let normalized) = MemoryPresentation.validate(text) else {
            throw CloudAPIError(code: "memory_rejected", message: "Memories are \(MemoryPresentation.maxCharacters) characters or fewer.", statusCode: 422)
        }
        // Like the server, the same text in the same scope returns the memory already saved.
        if let existing = memories.first(where: { $0.scope == target.scope && $0.scopeId == target.scopeId && $0.text == normalized }) {
            return existing
        }
        addedCount += 1
        let at = ISO8601DateFormatter().string(from: Date())
        let created = CloudMemory(
            memoryId: "lesson-added-\(addedCount)", scope: target.scope, scopeId: target.scopeId,
            scopeLabel: target.scopeLabel, source: .manual, text: normalized, createdAt: at, updatedAt: at
        )
        memories.append(created)
        return previewCards.filled(created)
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
        return previewCards.filled(memories[index])
    }

    func change(memoryId: String, _ request: CloudMemoryUpdateRequest) async throws -> CloudMemory {
        try await wait()
        guard let index = memories.firstIndex(where: { $0.memoryId == memoryId }) else {
            throw CloudAPIError(code: "memory_not_found", message: "This memory no longer exists.", statusCode: 404)
        }
        if let category = request.category { memories[index].category = category }
        try previewCards.apply(request, to: memories[index])
        return previewCards.filled(memories[index])
    }

    func cards() async -> [MemoryCard] { previewCards.cards }

    func delete(memoryId: String) async throws {
        try await wait()
        memories.removeAll { $0.memoryId == memoryId }
    }

    func forgetAll() async throws -> Int {
        try await wait()
        // Like the server, forgetting keeps the memories other group members saved.
        let archived = memories.filter { $0.ownerAccountId == nil }.count
        memories.removeAll { $0.ownerAccountId == nil }
        return archived
    }

    func updateSettings(memoryEnabled: Bool?, excludeSensitive: Bool?) async throws -> CloudMemorySettings {
        try await wait()
        if let memoryEnabled { settings.memoryEnabled = memoryEnabled }
        if let excludeSensitive { settings.excludeSensitive = excludeSensitive }
        return settings
    }
}

@MainActor
final class MemorySettingsModel: ObservableObject {
    @Published private(set) var settings: CloudMemorySettings?
    @Published private(set) var memories: [CloudMemory] = []
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var isLoading = false
    @Published private(set) var isUpdatingSettings = false
    @Published private(set) var isMutating = false
    @Published var errorMessage: String?
    /// The owner's cards and the origin names for Account › Memory's labels.
    @Published private(set) var cards: [MemoryCard] = []
    @Published private(set) var originNames: MemoryOriginNames

    let accountLabel: String?
    /// The signed-in account, to tell group memories other members saved apart.
    let viewerAccountId: String?
    /// `memoryVersion` 3 with profiles: card labels and card actions.
    let cardsEnabled: Bool
    private let conversations: [ConversationSummary]
    private let service: any MemoryService

    init(service: any MemoryService, accountLabel: String?, viewerAccountId: String? = nil,
         cardsEnabled: Bool = false, conversations: [ConversationSummary] = []) {
        self.service = service
        self.accountLabel = accountLabel
        self.viewerAccountId = viewerAccountId
        self.cardsEnabled = cardsEnabled
        self.conversations = conversations
        originNames = MemoryOriginNames(conversations: conversations)
    }

    var organizer: MemoryOrganizer {
        MemoryOrganizer(memories: memories, cards: cards, cardsEnabled: cardsEnabled, viewerAccountId: viewerAccountId, origins: originNames)
    }

    var hasLoaded: Bool { settings != nil }
    /// Global memories for the Settings screen.
    var globalMemories: [CloudMemory] { MemoryPresentation.globalMemories(memories) }
    /// The memories Forget everything deletes: every one this account saved.
    var ownMemories: [CloudMemory] { memories.filter { MemoryPresentation.isOwn($0, viewerAccountId: viewerAccountId) } }

    func detail(_ memory: CloudMemory) -> String {
        MemoryPresentation.detail(memory, viewerAccountId: viewerAccountId)
    }

    func ownerCaption(_ memory: CloudMemory) -> String? {
        MemoryPresentation.ownerCaption(memory, viewerAccountId: viewerAccountId)
    }

    /// The memories a conversation's Memory tab lists.
    func memories(for scopes: MemoryPresentation.ConversationScopes) -> [CloudMemory] {
        MemoryPresentation.memories(memories, for: scopes)
    }

    /// The cloud group conversation ids a group's memories are saved under.
    func cloudGroupConversationIds(for conversation: ConversationSummary) async -> [String] {
        guard conversation.kind == .group else { return [] }
        return await service.cloudGroupConversationIds(sessionId: conversation.sessionId)
    }

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
        originNames = MemoryOriginNames(conversations: conversations, cloudConversations: await service.cloudConversations())
        if cardsEnabled { cards = await service.cards() }
    }

    func setCategory(_ memory: CloudMemory, to category: String) async {
        await change(memory, CloudMemoryUpdateRequest(category: category), fallback: "Could not change the category. Try again.")
    }

    func addToCard(_ memory: CloudMemory, card: MemoryCard) async {
        await change(memory, CloudMemoryUpdateRequest(addProfileId: card.profileId), fallback: "Could not add this memory to the card. Try again.")
    }

    func removeFromCard(_ memory: CloudMemory, card: MemoryCard) async {
        await change(memory, CloudMemoryUpdateRequest(removeProfileId: card.profileId), fallback: "Could not remove this memory from the card. Try again.")
    }

    private func change(_ memory: CloudMemory, _ request: CloudMemoryUpdateRequest, fallback: String) async {
        await mutate(fallback: fallback) {
            let updated = try await self.service.change(memoryId: memory.memoryId, request)
            self.memories = self.memories.map { $0.memoryId == memory.memoryId ? updated : $0 }
            self.lastSyncedAt = Date()
        }
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

    /// Adds a memory the person typed and returns an error message to show inline,
    /// or nil on success. The new memory is listed first at once.
    func add(to target: MemoryAddTarget, draft: String) async -> String? {
        let text: String
        switch MemoryPresentation.validate(draft) {
        case .invalid(let reason): return reason
        case .valid(let normalized): text = normalized
        }
        do {
            let created = try await service.create(target: target, text: text)
            // Text the scope already has comes back as that memory, so it is listed once.
            memories = [created] + memories.filter { $0.memoryId != created.memoryId }
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
            // Group memories other members saved stay.
            self.memories = self.memories.filter { !MemoryPresentation.isOwn($0, viewerAccountId: self.viewerAccountId) }
            self.lastSyncedAt = Date()
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
        if let apiError = error as? CloudAPIError, apiError.code == "not_a_group_member" {
            return MemoryPresentation.notAGroupMemberMessage
        }
        if let apiError = error as? CloudAPIError, !apiError.message.isEmpty { return apiError.message }
        return fallback
    }
}
