import SwiftUI

/// Account memory settings. The sections and copy match the desktop Memory tab.
struct MemorySettingsView: View {
    @StateObject private var model: MemorySettingsModel
    @State private var editing: CloudMemory?
    @State private var deleteTarget: CloudMemory?
    @State private var confirmsForget = false
    @State private var confirmsReplayClear = false

    init(service: any MemoryService, accountLabel: String?) {
        _model = StateObject(wrappedValue: MemorySettingsModel(service: service, accountLabel: accountLabel))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let error = model.errorMessage {
                    errorBlock(error)
                }

                if let settings = model.settings {
                    memorySection(settings)
                    SettingsDivider()
                    savedMemoriesSection(settings)
                    replaySection
                } else if model.isLoading || model.errorMessage == nil {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading memory…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 48)
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
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
        .alert("Forget all memories?", isPresented: $confirmsForget) {
            Button("Forget everything", role: .destructive) {
                Task { await model.forgetAll() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(MemoryPresentation.forgetConsequences(count: model.memories.count))
        }
        .alert("Clear replay state?", isPresented: $confirmsReplayClear) {
            Button("Clear replay state", role: .destructive) {
                Task { await model.clearReplayState() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Follow-ups start from the saved conversation instead of the private replay. Nothing else is deleted.")
        }
    }

    private func errorBlock(_ error: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(error, systemImage: "exclamationmark.circle.fill")
                .font(.subheadline)
                .foregroundStyle(.red)
            if !model.hasLoaded {
                Button("Try again") { Task { await model.load() } }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 32)
                    .disabled(model.isLoading)
            }
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func memorySection(_ settings: CloudMemorySettings) -> some View {
        SettingsSectionTitle("Memory")
        if model.accountLabel != nil {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                if let caption = model.syncCaption(now: context.date) {
                    SettingsCaption(caption)
                }
            }
            .accessibilityIdentifier("memory-sync-caption")
        }
        Toggle(isOn: Binding(
            get: { settings.memoryEnabled },
            set: { enabled in Task { await model.setMemoryEnabled(enabled) } }
        )) {
            CompactSettingsLabel(
                title: "Let Kordi save memories",
                subtitle: settings.memoryEnabled
                    ? "New turns save and read memories on every device"
                    : "Memories are kept but not read on any device",
                systemImage: "brain"
            )
        }
        .frame(minHeight: 48)
        .disabled(model.isUpdatingSettings)
        .accessibilityIdentifier("memory-enabled-toggle")

        Toggle(isOn: Binding(
            get: { settings.excludeSensitive },
            set: { exclude in Task { await model.setExcludeSensitive(exclude) } }
        )) {
            CompactSettingsLabel(
                title: "Keep sensitive details out of memories",
                subtitle: "Health, finances, relationships, identity, credentials, other people's details",
                systemImage: "lock.shield"
            )
        }
        .frame(minHeight: 48)
        .disabled(model.isUpdatingSettings)
        .accessibilityIdentifier("memory-sensitive-toggle")
    }

    @ViewBuilder
    private func savedMemoriesSection(_ settings: CloudMemorySettings) -> some View {
        let groups = model.groups
        SettingsSectionTitle(MemoryPresentation.savedMemoriesTitle(count: model.memories.count))
        if !settings.memoryEnabled {
            SettingsCaption("Memory is off. These are kept but not read.")
        }
        if groups.isEmpty {
            SettingsCaption("No memories saved yet.")
        } else {
            ForEach(groups) { group in
                SettingsGroupLabel(group.label)
                ForEach(group.memories) { memory in
                    MemoryRow(
                        memory: memory,
                        edit: { editing = memory },
                        delete: { deleteTarget = memory }
                    )
                    .disabled(model.isMutating)
                }
            }

            Button {
                confirmsForget = true
            } label: {
                HStack(spacing: 10) {
                    CompactSettingsLabel(
                        title: "Forget everything",
                        subtitle: "Deletes every memory from your account and every signed-in device",
                        systemImage: "trash",
                        tint: .red
                    )
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
            .disabled(model.isMutating)
            .accessibilityIdentifier("memory-forget-everything")
        }
    }

    @ViewBuilder
    private var replaySection: some View {
        if let runCount = model.replayRunCount {
            SettingsDivider()
            SettingsSectionTitle("Replay state")
            SettingsCaption("Kordi keeps a private replay of each run so follow-ups can continue where they stopped. It is discarded when a message in it is deleted or when a member turns off AI use.")
            CompactSettingsLabel(
                title: "Replay state for this account",
                systemImage: "clock.arrow.circlepath",
                value: MemoryPresentation.replayRunsLabel(runCount)
            )
            .frame(minHeight: 48)

            let canClear = runCount > 0 && !model.isMutating
            Button {
                confirmsReplayClear = true
            } label: {
                HStack(spacing: 10) {
                    CompactSettingsLabel(
                        title: "Clear replay state",
                        systemImage: "xmark.circle",
                        tint: canClear ? KordiTheme.signalBlue : Color.secondary
                    )
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canClear)
            .accessibilityIdentifier("memory-clear-replay")
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
