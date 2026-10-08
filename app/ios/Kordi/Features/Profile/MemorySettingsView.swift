import SwiftUI

/// Account memory settings. The sections and copy match the desktop Memory tab.
struct MemorySettingsView: View {
    @StateObject private var model: MemorySettingsModel
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
        SettingsSectionTitle(MemoryPresentation.savedMemoriesTitle(count: model.personalMemories.count))
        if !settings.memoryEnabled {
            SettingsCaption("Memory is off. These are kept but not read.")
        }
        if groups.isEmpty {
            SettingsCaption("No memories saved yet.")
        }
        ForEach(groups) { group in
            SettingsGroupLabel(group.label)
            MemoryRowsView(model: model, memories: group.memories)
        }
        // Forget everything also covers group memories, so it stays while any exist.
        if !model.memories.isEmpty {
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
        SettingsCaption("Group memories are managed from each group's info page.")
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
