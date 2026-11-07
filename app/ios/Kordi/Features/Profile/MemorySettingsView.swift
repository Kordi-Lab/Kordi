import SwiftUI
import UniformTypeIdentifiers

/// Account memory settings: the switches, every memory of the account with its
/// category, cards and origin, and Forget everything. The sections and copy
/// match the desktop Memory settings.
struct MemorySettingsView: View {
    @StateObject private var model: MemorySettingsModel
    @State private var confirmsForget = false
    @State private var showsImporter = false
    @State private var isExtracting = false
    @State private var importReview: MemoryImportReview?
    @State private var importMessage: String?
    /// Turning memory on needs the AI choice; true when it may proceed.
    private var allowsAI: @MainActor () -> Bool = { true }
    /// Shows the AI choice for a 403 `ai_consent_required`; true when it was that.
    private var noteConsentRequired: @MainActor (Error) -> Bool = { _ in false }

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
        allowsAI = { [weak appModel] in appModel?.requireAIConsent() ?? true }
        noteConsentRequired = { [weak appModel] error in appModel?.noteIfAIConsentRequired(error) ?? false }
    }

    var body: some View {
        SettingsPage {
            if let error = model.errorMessage {
                errorBlock(error)
            }

            if let settings = model.settings {
                memorySection(settings)
                SettingsDivider()
                MemoryOrganizerSection(model: model, memoryEnabled: settings.memoryEnabled)
                forgetEverything
            } else if model.isLoading || model.errorMessage == nil {
                SettingsLoadingRow("Loading memory…")
            }
        }
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
        .task {
            // `--preview-memory-import`: the review list for a sample file, without the picker.
            guard ProcessInfo.processInfo.arguments.contains("--preview-memory-import") else { return }
            try? await Task.sleep(for: .milliseconds(600))
            await extract([MemoryImportFile(name: "AGENTS.md", text: "Run the unit tests before opening a pull request.")], notice: nil)
        }
        .fileImporter(
            isPresented: $showsImporter,
            allowedContentTypes: Self.importTypes,
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            let read = MemoryImportFile.read(urls)
            guard !read.files.isEmpty else {
                importMessage = read.notice ?? "Choose .md, .txt, or .json files."
                return
            }
            Task { await extract(read.files, notice: read.notice) }
        }
        .sheet(item: $importReview) { review in
            MemoryImportReviewSheet(review: review) { rows in
                let result = await model.saveImports(rows)
                importMessage = result.error ?? (result.saved == 1 ? "Imported 1 memory" : "Imported \(result.saved) memories")
            }
        }
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
        VStack(alignment: .leading, spacing: 0) {
            SettingsErrorLabel(error)
            if !model.hasLoaded {
                Button("Try again") { Task { await model.load() } }
                    .font(SettingsFont.action)
                    .frame(minHeight: SettingsMetrics.textRowMinHeight)
                    .disabled(model.isLoading)
            }
        }
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
            set: { enabled in
                guard !enabled || allowsAI() else { return }
                Task { await model.setMemoryEnabled(enabled) }
            }
        )) {
            CompactSettingsLabel(
                title: "Let Kordi save memories",
                subtitle: settings.memoryEnabled
                    ? "New turns save and read memories on every device"
                    : "Memories are kept but not read on any device",
                systemImage: "brain"
            )
        }
        .frame(minHeight: SettingsMetrics.rowMinHeight)
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
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .disabled(model.isUpdatingSettings)
        .accessibilityIdentifier("memory-sensitive-toggle")

        Button {
            guard allowsAI() else { return }
            importMessage = nil
            showsImporter = true
        } label: {
            HStack(spacing: 10) {
                CompactSettingsLabel(
                    title: isExtracting ? "Reading files…" : "Import from files",
                    subtitle: ".md, .txt or .json, up to 20 files of 200 KB",
                    systemImage: "square.and.arrow.down"
                )
                Spacer(minLength: 0)
                if isExtracting { ProgressView() }
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isExtracting)
        .accessibilityIdentifier("memory-import")
        if let importMessage {
            SettingsCaption(importMessage)
        }
    }

    private static let importTypes: [UTType] = [.plainText, .json, .text]
        + ["md", "markdown"].compactMap { UTType(filenameExtension: $0) }

    private func extract(_ files: [MemoryImportFile], notice: String?) async {
        isExtracting = true
        defer { isExtracting = false }
        do {
            let rows = try await model.extractImport(files)
            if rows.isEmpty {
                importMessage = notice ?? "Nothing new"
            } else {
                importReview = MemoryImportReview(rows: rows, fileCount: files.count, notice: notice)
            }
        } catch {
            if !noteConsentRequired(error) {
                importMessage = (error as? CloudAPIError)?.message.nonEmpty ?? "Could not read these files. Try again."
            }
        }
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
                .frame(minHeight: SettingsMetrics.rowMinHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 12)
            .disabled(model.isMutating)
            .accessibilityIdentifier("memory-forget-everything")
        }
    }
}

/// Memories read from chosen files, before anything is saved.
struct MemoryImportReview: Identifiable {
    let id = UUID()
    let rows: [MemoryImportCandidateRow]
    let fileCount: Int
    let notice: String?
}

/// Review of an import: every memory starts chosen; Import saves the chosen ones.
private struct MemoryImportReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let review: MemoryImportReview
    let onImport: ([MemoryImportCandidateRow]) async -> Void
    @State private var skipped = Set<UUID>()
    @State private var isSaving = false

    private var chosen: [MemoryImportCandidateRow] { review.rows.filter { !skipped.contains($0.id) } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(review.rows) { row in
                        Button {
                            if skipped.contains(row.id) { skipped.remove(row.id) } else { skipped.insert(row.id) }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: skipped.contains(row.id) ? "circle" : "checkmark.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(skipped.contains(row.id) ? Color(uiColor: .tertiaryLabel) : Color.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.text)
                                        .font(.body)
                                        .foregroundStyle(.primary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text([MemoryPresentation.categoryLabel(for: row.category), row.fileName].compactMap { $0 }.joined(separator: " · "))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text(review.fileCount == 1 ? "From 1 file" : "From \(review.fileCount) files")
                        .font(.footnote)
                        .textCase(nil)
                } footer: {
                    if let notice = review.notice { Text(notice) }
                }
            }
            .navigationTitle("Import memories")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Importing…" : "Import \(chosen.count)") {
                        isSaving = true
                        Task {
                            await onImport(chosen)
                            isSaving = false
                            dismiss()
                        }
                    }
                    .disabled(chosen.isEmpty || isSaving)
                }
            }
        }
    }
}
