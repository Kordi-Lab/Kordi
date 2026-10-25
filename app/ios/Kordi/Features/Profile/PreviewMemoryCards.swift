import Foundation

/// Card choices for `--preview-data`, following the server's rules (#2035):
/// a memory's cards are the cards its category routes to, minus the ones the
/// person removed it from, plus the ones the person added it to.
struct PreviewMemoryCards {
    static let samples = [
        MemoryCard(profileId: "prof-work", kind: "work", title: "Work"),
        MemoryCard(profileId: "prof-health", kind: "health", title: "Health"),
        MemoryCard(profileId: "prof-daily", kind: "daily", title: "Daily"),
        MemoryCard(profileId: "prof-lab", kind: "custom", title: "Lab"),
    ]

    var cards = Self.samples
    private var added: [String: Set<String>] = [:]
    private var removed: [String: Set<String>] = [:]

    /// The card kinds a category routes to; schedule memories go to every fixed kind.
    static func routed(category: String?, kind: String) -> Bool {
        switch category {
        case "work_context", "education_learner_profile": kind == "work"
        case "health_context": kind == "health"
        case "location_context", "purchase_history_preferences": kind == "daily"
        case "coordination_context": kind == "work" || kind == "health" || kind == "daily"
        default: false
        }
    }

    /// The memory with its `profileIds` and `excludedProfileIds` filled in.
    func filled(_ memory: CloudMemory) -> CloudMemory {
        var memory = memory
        guard memory.scope != .group else {
            memory.profileIds = []
            memory.excludedProfileIds = []
            return memory
        }
        let added = added[memory.memoryId] ?? [], removed = removed[memory.memoryId] ?? []
        memory.profileIds = cards.filter {
            added.contains($0.profileId) || (!removed.contains($0.profileId) && Self.routed(category: memory.category, kind: $0.kind))
        }.map(\.profileId)
        memory.excludedProfileIds = cards.filter { removed.contains($0.profileId) }.map(\.profileId)
        return memory
    }

    /// Applies an edit's card changes, or throws the server's error.
    mutating func apply(_ request: CloudMemoryUpdateRequest, to memory: CloudMemory) throws {
        guard request.addProfileId != nil || request.removeProfileId != nil else { return }
        guard memory.scope != .group else {
            throw CloudAPIError(code: "memory_profile_not_allowed", message: "Group memories do not feed cards.", statusCode: 403)
        }
        let id = memory.memoryId
        if let card = request.addProfileId {
            guard cards.contains(where: { $0.profileId == card }) else { throw Self.profileNotFound }
            if removed[id]?.remove(card) == nil { added[id, default: []].insert(card) }
        }
        if let card = request.removeProfileId {
            guard filled(memory).profileIds?.contains(card) == true else {
                throw CloudAPIError(code: "memory_profile_not_found", message: "This memory is not on that card.", statusCode: 404)
            }
            if added[id]?.remove(card) == nil { removed[id, default: []].insert(card) }
            if let kind = cards.first(where: { $0.profileId == card })?.kind, Self.routed(category: memory.category, kind: kind) {
                removed[id, default: []].insert(card)
            }
        }
    }

    private static let profileNotFound = CloudAPIError(code: "profile_not_found", message: "Card not found.", statusCode: 404)
}
