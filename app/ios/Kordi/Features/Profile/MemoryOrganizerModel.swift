import Foundation

/// One Grounding card a memory can feed, from the owner's profiles.
struct MemoryCard: Hashable, Identifiable {
    let profileId: String
    let kind: String
    let title: String

    var id: String { profileId }
    /// "Work card", "Lab card".
    var label: String { "\(title) card" }
    /// Work, Health and Daily; schedule memories feed every one of them.
    var isFixed: Bool { kind != CommonGroundProfileKind.custom.rawValue }

    init(profileId: String, kind: String, title: String) {
        self.profileId = profileId
        self.kind = kind
        self.title = title
    }

    init(profile: CommonGroundProfileSummary) {
        self.init(profileId: profile.profileId, kind: profile.kind, title: profile.title)
    }
}

/// The three label layers on a memory row and in the filter row.
enum MemoryLabelLayer: Int, CaseIterable, Hashable {
    case card
    case category
    case origin

    var title: String {
        switch self {
        case .card: "Cards"
        case .category: "Categories"
        case .origin: "From"
        }
    }
}

/// One label: on a row it shows what the memory is, in the filter row it filters.
struct MemoryLabel: Hashable, Identifiable {
    let layer: MemoryLabelLayer
    let value: String
    let title: String

    var id: String { "\(layer.rawValue):\(value)" }
}

/// The chosen labels. Within a layer any chosen label matches; across layers all must.
struct MemoryFilters: Equatable {
    private(set) var selected: [MemoryLabelLayer: Set<String>] = [:]

    var isEmpty: Bool { selected.values.allSatisfy(\.isEmpty) }

    func contains(_ label: MemoryLabel) -> Bool {
        selected[label.layer]?.contains(label.value) ?? false
    }

    mutating func toggle(_ label: MemoryLabel) {
        var values = selected[label.layer] ?? []
        if values.contains(label.value) { values.remove(label.value) } else { values.insert(label.value) }
        selected[label.layer] = values
    }

    mutating func clear() { selected = [:] }
}

/// One layer of the filter row and its labels with how many memories carry each.
struct MemoryFilterGroup: Equatable, Identifiable {
    struct Chip: Equatable, Identifiable {
        let label: MemoryLabel
        let count: Int
        var id: String { label.id }
    }

    let layer: MemoryLabelLayer
    let chips: [Chip]
    var id: Int { layer.rawValue }
}

/// What a row's long-press menu offers. Empty lists hide their item.
struct MemoryRowActions: Equatable {
    var categories: [String] = []
    var addCards: [MemoryCard] = []
    var removeCards: [MemoryCard] = []
}

/// Account › Memory: every memory of the account in one list, newest first,
/// labelled by category, cards and origin. Pure rules, shared by the view and tests.
struct MemoryOrganizer {
    static let everyCardValue = "every"
    static let everyCardTitle = "Every card"
    static let scheduleCategory = "coordination_context"
    /// Category order in the menu and the filter row, as on the Mac.
    static let categoryOrder = [
        "general_preferences", "work_context", "education_learner_profile", "health_context", "coordination_context",
        "location_context", "purchase_history_preferences", "goals_and_constraints", "values_and_ethics", "hcp-custom:task_lessons",
    ]
    /// Group memories may not use these; the server refuses them (`memory_category_not_shared`).
    static let groupRefusedCategories: Set<String> = [
        "health_context", "location_context", "purchase_history_preferences", "values_and_ethics",
    ]

    var memories: [CloudMemory] = []
    var cards: [MemoryCard] = []
    /// `memoryVersion` 3: card labels and card actions; older servers hide them.
    var cardsEnabled = false
    var viewerAccountId: String?
    var origins = MemoryOriginNames()

    var total: Int { memories.count }

    func rows(filters: MemoryFilters, query: String = "") -> [CloudMemory] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return memories.filter { matches($0, filters: filters, query: query) }.sorted(by: MemoryPresentation.isNewer)
    }

    func matches(_ memory: CloudMemory, filters: MemoryFilters, query: String = "") -> Bool {
        if !query.isEmpty, !memory.text.localizedCaseInsensitiveContains(query) { return false }
        let labels = Set(labels(for: memory))
        for layer in MemoryLabelLayer.allCases {
            guard let chosen = filters.selected[layer], !chosen.isEmpty else { continue }
            guard labels.contains(where: { $0.layer == layer && chosen.contains($0.value) }) else { return false }
        }
        return true
    }

    /// The row's labels in order: the category, the cards, then the origin.
    func labels(for memory: CloudMemory) -> [MemoryLabel] {
        [categoryLabel(for: memory)].compactMap { $0 } + cardLabels(for: memory) + [originLabel(for: memory)]
    }

    func categoryLabel(for memory: CloudMemory) -> MemoryLabel? {
        guard let category = memory.category, let title = MemoryPresentation.categoryLabel(for: category) else { return nil }
        return MemoryLabel(layer: .category, value: category, title: title)
    }

    func originLabel(for memory: CloudMemory) -> MemoryLabel {
        MemoryLabel(layer: .origin, value: MemoryOriginNames.key(for: memory), title: origins.name(for: memory))
    }

    /// A schedule memory nobody removed from a card is shown through its category as "Every card".
    func showsEveryCard(_ memory: CloudMemory) -> Bool {
        memory.category == Self.scheduleCategory && (memory.excludedProfileIds ?? []).isEmpty && cards.contains(where: \.isFixed)
    }

    /// The cards the memory is on, in profile order. Group memories have none.
    func cardsOn(_ memory: CloudMemory) -> [MemoryCard] {
        guard cardsEnabled, memory.scope != .group else { return [] }
        let ids = Set(memory.profileIds ?? [])
        return cards.filter { ids.contains($0.profileId) }
    }

    func cardLabels(for memory: CloudMemory) -> [MemoryLabel] {
        guard cardsEnabled, memory.scope != .group else { return [] }
        let every = showsEveryCard(memory)
        let shown = cardsOn(memory).filter { !(every && $0.isFixed) }
        let labels = shown.map { MemoryLabel(layer: .card, value: $0.profileId, title: $0.label) }
        return every ? [MemoryLabel(layer: .card, value: Self.everyCardValue, title: Self.everyCardTitle)] + labels : labels
    }

    func actions(for memory: CloudMemory) -> MemoryRowActions {
        var actions = MemoryRowActions()
        // Only the person who saved a memory changes its category; group rows can be another member's.
        if MemoryPresentation.isOwn(memory, viewerAccountId: viewerAccountId) {
            actions.categories = memory.scope == .group
                ? Self.categoryOrder.filter { !Self.groupRefusedCategories.contains($0) }
                : Self.categoryOrder
        }
        guard cardsEnabled, memory.scope != .group else { return actions }
        let on = cardsOn(memory)
        actions.addCards = cards.filter { !on.contains($0) }
        // "Every card" comes from the Schedule category, so its cards are not removed one by one.
        actions.removeCards = showsEveryCard(memory) ? on.filter { !$0.isFixed } : on
        return actions
    }

    /// The filter row: each layer's labels with how many memories carry them.
    /// A label no memory carries is left out unless it is chosen.
    func filterGroups(filters: MemoryFilters) -> [MemoryFilterGroup] {
        var counts: [MemoryLabel: Int] = [:]
        var originOrder: [MemoryLabel] = []
        for memory in memories.sorted(by: MemoryPresentation.isNewer) {
            for label in labels(for: memory) {
                if label.layer == .origin, counts[label] == nil { originOrder.append(label) }
                counts[label, default: 0] += 1
            }
        }
        let cardLabels = cards.map { MemoryLabel(layer: .card, value: $0.profileId, title: $0.label) }
            + [MemoryLabel(layer: .card, value: Self.everyCardValue, title: Self.everyCardTitle)]
        let categoryLabels = Self.categoryOrder.compactMap { category in
            MemoryPresentation.categoryLabel(for: category).map { MemoryLabel(layer: .category, value: category, title: $0) }
        }
        let globalFirst = originOrder.filter { $0.value == "global" } + originOrder.filter { $0.value != "global" }
        let layers: [(MemoryLabelLayer, [MemoryLabel])] = [
            (.card, cardsEnabled ? cardLabels : []), (.category, categoryLabels), (.origin, globalFirst),
        ]
        return layers.compactMap { layer, labels in
            let chips = labels.compactMap { label -> MemoryFilterGroup.Chip? in
                let count = counts[label] ?? 0
                return count > 0 || filters.contains(label) ? MemoryFilterGroup.Chip(label: label, count: count) : nil
            }
            return chips.isEmpty ? nil : MemoryFilterGroup(layer: layer, chips: chips)
        }
    }

    static func allMemoriesTitle(count: Int) -> String { "All memories · \(count)" }
}
