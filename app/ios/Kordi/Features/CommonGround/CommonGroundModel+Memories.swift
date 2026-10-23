import Foundation

/// The card page's Memories section: the owner's memories routed to the
/// current profile, Move to another profile or none, and Remove.
extension CommonGroundModel {
    /// Whether the card page lists memories: profiles and `memoryVersion` 2.
    var showsProfileMemories: Bool { memoriesEnabled && profilesEnabled }

    /// "N new memories since this card was built" near Rebuild card.
    var memoriesSinceBuildCaption: String? {
        guard showsProfileMemories else { return nil }
        return MemoryPresentation.memoriesSinceBuildCaption(owner?.memoriesSinceBuild)
    }

    /// The profiles a memory can move to: the owner's other profiles, and
    /// this one too for a memory listed in every profile, which narrows it.
    func moveTargets(for memory: CloudProfileMemory) -> [CommonGroundProfileSummary] {
        profiles.filter { $0.profileId != currentProfileID || memory.everyProfile }
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

    /// Files a memory under another profile, or none when `profileId` is nil.
    @discardableResult
    func moveMemory(_ memoryId: String, toProfile profileId: String?) async -> Bool {
        guard (await run("memory", { try await $0.moveMemory(token: $1, memoryId: memoryId, toProfile: profileId) })) != nil else { return false }
        await refreshMemories()
        return true
    }

    /// Deletes a memory from the account, on every device.
    @discardableResult
    func removeMemory(_ memoryId: String) async -> Bool {
        guard (await run("memory", { try await $0.deleteMemory(token: $1, memoryId: memoryId) })) != nil else { return false }
        await refreshMemories()
        return true
    }

    /// The list and the card's "new memories" count both change after a move or remove.
    private func refreshMemories() async {
        await loadProfileMemories()
        await refreshCard()
    }
}
