import SwiftUI

/// The card page's Memories section: the memories on this card, each with
/// Add to card, Remove from card and Delete. Hidden without routing or memories.
struct CommonGroundCardMemoriesSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @State private var deleteTarget: CloudProfileMemory?

    var body: some View {
        if model.showsProfileMemories, !model.profileMemories.isEmpty {
            CommonGroundSection(title: "Memories") {
                ForEach(Array(model.profileMemories.enumerated()), id: \.element.id) { index, memory in
                    if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                    row(memory)
                }
            }
            .alert(
                "Delete this memory?",
                isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
                presenting: deleteTarget
            ) { memory in
                Button("Delete", role: .destructive) {
                    Task { await model.deleteMemory(memory.id) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Kordi will not read it again on any device.")
            }
        }
    }

    private func row(_ memory: CloudProfileMemory) -> some View {
        MemoryRowLabel(
            text: memory.memory.text,
            detail: MemoryPresentation.detail(memory.memory),
            category: memory.memory.category,
            captions: memory.everyProfile ? [MemoryOrganizer.everyCardTitle] : []
        )
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu { actions(memory) }
        .disabled(model.busy == "memory")
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Delete") { deleteTarget = memory }
        .accessibilityIdentifier("profile-memory-\(memory.id)")
    }

    @ViewBuilder
    private func actions(_ memory: CloudProfileMemory) -> some View {
        let targets = model.addTargets(for: memory)
        if !targets.isEmpty {
            Menu("Add to card", systemImage: "plus.rectangle.on.rectangle") {
                ForEach(targets) { profile in
                    Button("\(profile.title) card") {
                        Task { await model.addMemory(memory.id, toCard: profile.profileId) }
                    }
                }
            }
        }
        if model.offersRemoveFromCard(memory) {
            Button("Remove from card", systemImage: "minus.rectangle") {
                Task { await model.removeMemoryFromCard(memory.id) }
            }
        }
        Button("Delete", systemImage: "trash", role: .destructive) { deleteTarget = memory }
    }
}
