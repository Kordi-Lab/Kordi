import Foundation

/// The card page's Memories section: the owner's memories on the current
/// card, Add to card, Remove from card, and Delete.
extension CommonGroundModel {
    /// Whether the card page lists memories: profiles and `memoryVersion` 2.
    var showsProfileMemories: Bool { memoriesEnabled && profilesEnabled }

    /// Add to card and Remove from card need `memoryVersion` 3.
    var showsCardChoices: Bool { showsProfileMemories && cardChoicesEnabled }

    /// "N new memories since this card was built" near Rebuild card.
    var memoriesSinceBuildCaption: String? {
        guard showsProfileMemories else { return nil }
        return MemoryPresentation.memoriesSinceBuildCaption(owner?.memoriesSinceBuild)
    }

    /// The cards a memory can be added to: the owner's cards it is not on.
    func addTargets(for memory: CloudProfileMemory) -> [CommonGroundProfileSummary] {
        guard showsCardChoices else { return [] }
        let on = Set(memory.memory.profileIds ?? [currentProfileID].compactMap { $0 })
        return profiles.filter { !on.contains($0.profileId) }
    }

    /// Remove from card takes the memory off the current card. A schedule
    /// memory shown through its category is on every card, so it stays.
    func offersRemoveFromCard(_ memory: CloudProfileMemory) -> Bool {
        showsCardChoices && !memory.everyProfile && currentProfileID != nil
    }

    /// Loads the current profile's memories. Quiet on failure; an answer for
    /// a profile that is no longer current is dropped.
    func loadProfileMemories() async {
        guard showsProfileMemories, let profileId = currentProfileID else {
            profileMemories = []
            return
        }
        guard let list = try? await call({ try await $0.commonGroundProfileMemories(token: $1, profileId: profileId) }),
              profileId == currentProfileID else { return }
        profileMemories = list.memories
    }

    /// Adds a memory to another card; it stays on this one.
    @discardableResult
    func addMemory(_ memoryId: String, toCard profileId: String) async -> Bool {
        await changeMemory(memoryId, CloudMemoryUpdateRequest(addProfileId: profileId))
    }

    /// Takes a memory off the current card; it stays in the account.
    @discardableResult
    func removeMemoryFromCard(_ memoryId: String) async -> Bool {
        guard let profileId = currentProfileID else { return false }
        return await changeMemory(memoryId, CloudMemoryUpdateRequest(removeProfileId: profileId))
    }

    /// Deletes a memory from the account, on every device.
    @discardableResult
    func deleteMemory(_ memoryId: String) async -> Bool {
        guard (await run("memory", { try await $0.deleteMemory(token: $1, memoryId: memoryId) })) != nil else { return false }
        await refreshMemories()
        return true
    }

    private func changeMemory(_ memoryId: String, _ request: CloudMemoryUpdateRequest) async -> Bool {
        guard (await run("memory", { try await $0.changeMemory(token: $1, memoryId: memoryId, request) })) != nil else { return false }
        await refreshMemories()
        return true
    }

    /// The list and the card's "new memories" count both change after a card change or delete.
    private func refreshMemories() async {
        await loadProfileMemories()
        await refreshCard()
    }
}
