import SwiftUI

/// Memory rows shared by the Settings Memory screen and each conversation's Memory tab.
/// Each row opens the edit sheet on tap and offers Edit and Delete on long press;
/// deleting asks for confirmation first.
struct MemoryRowsView: View {
    @ObservedObject var model: MemorySettingsModel
    let memories: [CloudMemory]
    @State private var editing: CloudMemory?
    @State private var deleteTarget: CloudMemory?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(memories) { memory in
                MemoryRow(
                    memory: memory,
                    edit: { editing = memory },
                    delete: { deleteTarget = memory }
                )
                .disabled(model.isMutating)
            }
        }
        .sheet(item: $editing) { memory in
            MemoryEditSheet(memory: memory) { draft in
                await model.save(memoryId: memory.memoryId, draft: draft)
            }
        }
        .alert(
            "Delete this memory?",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            presenting: deleteTarget
        ) { memory in
            Button("Delete", role: .destructive) {
                Task { await model.delete(memory) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Kordi will not read it again on any device. This cannot be undone.")
        }
    }
}

private struct MemoryRow: View {
    let memory: CloudMemory
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        Button(action: edit) {
            HStack(spacing: 10) {
                CompactSettingsLabel(
                    title: memory.text,
                    subtitle: MemoryPresentation.detail(memory),
                    systemImage: nil,
                    titleLineLimit: 3
                )
                Spacer(minLength: 0)
                SettingsChevron()
            }
            .padding(.vertical, 4)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Edit", systemImage: "pencil", action: edit)
            Button("Delete", systemImage: "trash", role: .destructive, action: delete)
        }
        .accessibilityHint("Edit this memory")
        .accessibilityAction(named: "Delete") { delete() }
        .accessibilityIdentifier("memory-row-\(memory.memoryId)")
    }
}

private struct MemoryEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let memory: CloudMemory
    let save: (String) async -> String?
    @State private var draft: String
    @State private var error: String?
    @State private var isSaving = false
    @FocusState private var focused: Bool

    init(memory: CloudMemory, save: @escaping (String) async -> String?) {
        self.memory = memory
        self.save = save
        _draft = State(initialValue: memory.text)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Memory", text: $draft, axis: .vertical)
                        .font(.subheadline)
                        .lineLimit(6...14)
                        .focused($focused)
                        .disabled(isSaving)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(minHeight: 44)
                        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 12))
                        .onChange(of: draft) { _, _ in error = nil }
                        .accessibilityLabel("Memory text")

                    HStack(alignment: .firstTextBaseline) {
                        Text(MemoryPresentation.detail(memory))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Text(MemoryPresentation.counter(draft))
                            .monospacedDigit()
                            .foregroundStyle(MemoryPresentation.isOverLimit(draft) ? Color.red : Color.secondary)
                    }
                    .font(.caption)
                    .padding(.horizontal, 4)

                    if let error {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(Color(uiColor: .systemBackground))
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Edit memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { submit() }
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving)
    }

    private func submit() {
        if case .invalid(let reason) = MemoryPresentation.validate(draft) {
            error = reason
            return
        }
        isSaving = true
        Task {
            let failure = await save(draft)
            isSaving = false
            if let failure {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}
