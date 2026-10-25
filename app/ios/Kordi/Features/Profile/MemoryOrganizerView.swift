import SwiftUI

/// Account › Memory's list: every memory of the account, newest first, with a
/// search field, label filters, Add memory, and one row per memory showing its
/// category, cards and origin. Long-press a row to change it.
struct MemoryOrganizerSection: View {
    @ObservedObject var model: MemorySettingsModel
    let memoryEnabled: Bool
    @State private var filters = MemoryFilters()
    @State private var query = ""
    @State private var editing: CloudMemory?
    @State private var deleteTarget: CloudMemory?

    var body: some View {
        let organizer = model.organizer
        let rows = organizer.rows(filters: filters, query: query)
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionTitle(MemoryOrganizer.allMemoriesTitle(count: organizer.total))
            if !memoryEnabled {
                SettingsCaption("Memory is off. These are kept but not read.")
            }
            if organizer.total > 0 {
                searchField
                MemoryFilterRow(groups: organizer.filterGroups(filters: filters), filters: $filters)
            }
            if memoryEnabled {
                // The server refuses new memories while memory is off.
                MemoryAddRow(model: model, target: .global)
            }
            if organizer.total == 0 {
                SettingsCaption("No memories yet.")
            } else if rows.isEmpty {
                SettingsCaption("No memories match.")
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, memory in
                    if index > 0 { Divider() }
                    row(memory, organizer: organizer)
                }
            }
        }
        .sheet(item: $editing) { memory in
            MemoryEditSheet(memory: memory, detail: model.detail(memory)) { draft in
                await model.save(memoryId: memory.memoryId, draft: draft)
            }
        }
        .alert(
            "Delete this memory?",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            presenting: deleteTarget
        ) { memory in
            Button("Delete", role: .destructive) { Task { await model.delete(memory) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Kordi will not read it again on any device. This cannot be undone.")
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Search memories", text: $query)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !query.isEmpty {
                Button("Clear search", systemImage: "xmark.circle.fill") { query = "" }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 10))
        .padding(.vertical, 6)
        .accessibilityIdentifier("memory-search")
    }

    private func row(_ memory: CloudMemory, organizer: MemoryOrganizer) -> some View {
        let captions = model.ownerCaption(memory).map { [$0] } ?? []
        return VStack(alignment: .leading, spacing: 6) {
            Button { editing = memory } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(memory.text)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    ForEach([model.detail(memory)] + captions, id: \.self) { line in
                        Text(line).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Edit this memory")
            FlowLayout(spacing: 6) {
                ForEach(organizer.labels(for: memory)) { label in
                    MemoryLabelChip(label: label, isOn: filters.contains(label)) { filters.toggle(label) }
                }
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .contextMenu { actions(memory, organizer.actions(for: memory)) }
        .disabled(model.isMutating)
        .accessibilityAction(named: "Delete") { deleteTarget = memory }
        .accessibilityIdentifier("memory-row-\(memory.memoryId)")
    }

    @ViewBuilder
    private func actions(_ memory: CloudMemory, _ actions: MemoryRowActions) -> some View {
        if !actions.categories.isEmpty {
            Menu("Change category", systemImage: "tag") {
                ForEach(actions.categories, id: \.self) { category in
                    Button {
                        guard category != memory.category else { return }
                        Task { await model.setCategory(memory, to: category) }
                    } label: {
                        let title = MemoryPresentation.categoryLabel(for: category) ?? category
                        if category == memory.category { Label(title, systemImage: "checkmark") } else { Text(title) }
                    }
                }
            }
        }
        if !actions.addCards.isEmpty {
            Menu("Add to card", systemImage: "plus.rectangle.on.rectangle") {
                ForEach(actions.addCards) { card in
                    Button(card.label) { Task { await model.addToCard(memory, card: card) } }
                }
            }
        }
        if !actions.removeCards.isEmpty {
            Menu("Remove from card", systemImage: "minus.rectangle") {
                ForEach(actions.removeCards) { card in
                    Button(card.label) { Task { await model.removeFromCard(memory, card: card) } }
                }
            }
        }
        Button("Edit", systemImage: "pencil") { editing = memory }
        Button("Delete", systemImage: "trash", role: .destructive) { deleteTarget = memory }
    }
}
