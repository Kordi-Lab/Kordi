import SwiftUI

/// The card page's Memories section: the memories routed to this profile,
/// each with Move to… and Remove. Hidden without routing or memories.
struct CommonGroundCardMemoriesSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @State private var removeTarget: CloudProfileMemory?

    var body: some View {
        if model.showsProfileMemories, !model.profileMemories.isEmpty {
            CommonGroundSection(title: "Memories") {
                ForEach(Array(model.profileMemories.enumerated()), id: \.element.id) { index, memory in
                    if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                    row(memory)
                }
            }
            .alert(
                "Remove this memory?",
                isPresented: Binding(get: { removeTarget != nil }, set: { if !$0 { removeTarget = nil } }),
                presenting: removeTarget
            ) { memory in
                Button("Remove", role: .destructive) {
                    Task { await model.removeMemory(memory.id) }
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
            captions: memory.everyProfile ? ["Every profile"] : []
        )
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu { actions(memory) }
        .disabled(model.busy == "memory")
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Remove") { removeTarget = memory }
        .accessibilityIdentifier("profile-memory-\(memory.id)")
    }

    @ViewBuilder
    private func actions(_ memory: CloudProfileMemory) -> some View {
        Menu("Move to…", systemImage: "arrow.right.square") {
            ForEach(model.moveTargets(for: memory)) { profile in
                Button(profile.title) {
                    Task { await model.moveMemory(memory.id, toProfile: profile.profileId) }
                }
            }
            if model.offersNoProfile(for: memory) {
                Button("No profile") {
                    Task { await model.moveMemory(memory.id, toProfile: nil) }
                }
            }
        }
        Button("Remove", systemImage: "trash", role: .destructive) { removeTarget = memory }
    }
}
