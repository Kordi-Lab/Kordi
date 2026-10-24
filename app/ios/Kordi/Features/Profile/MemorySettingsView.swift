import SwiftUI

/// Account memory settings: the switches, every memory of the account with its
/// category, cards and origin, and Forget everything. The sections and copy
/// match the desktop Memory settings.
struct MemorySettingsView: View {
    @StateObject private var model: MemorySettingsModel
    @State private var confirmsForget = false

    init(service: any MemoryService, accountLabel: String?, viewerAccountId: String? = nil,
         cardsEnabled: Bool = false, conversations: [ConversationSummary] = []) {
        _model = StateObject(wrappedValue: MemorySettingsModel(
            service: service, accountLabel: accountLabel, viewerAccountId: viewerAccountId,
            cardsEnabled: cardsEnabled, conversations: conversations
        ))
    }

    /// Account › Memory for the signed-in account. Card labels need
    /// `memoryVersion` 3 and profiles (`commonGroundVersion` 2).
    init(appModel: AppModel) {
        let capabilities = appModel.memoryCapabilities
        self.init(
            service: appModel.makeMemoryService(),
            accountLabel: MemoryPresentation.accountLabel(email: appModel.account?.primaryEmail, kordiId: appModel.account?.kordiId),
            viewerAccountId: appModel.account?.accountId,
            cardsEnabled: MemoryPresentation.hasCardChoices(capabilities)
                && (CommonGroundAvailability.hasProfiles(capabilities: capabilities) || appModel.isPreviewMode),
            conversations: appModel.conversations
        )
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
                    MemoryOrganizerSection(model: model, memoryEnabled: settings.memoryEnabled)
                    forgetEverything
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
            Text(MemoryPresentation.forgetConsequences(count: model.ownMemories.count))
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

    /// Forget everything covers every scope, so it stays while any memory exists.
    @ViewBuilder
    private var forgetEverything: some View {
        if !model.ownMemories.isEmpty {
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
            .padding(.top, 12)
            .disabled(model.isMutating)
            .accessibilityIdentifier("memory-forget-everything")
        }
    }
}
