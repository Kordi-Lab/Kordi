import SwiftUI

struct ProviderAuthenticationDetailView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    let provider: ProviderAuthenticationDefinition

    @State private var apiKey = ""
    @State private var profileLabel = ""
    @State private var isSaving = false
    @State private var saved = false
    @State private var showRemoveConfirmation = false
    @State private var removeTarget: CloudProviderAuthSnapshot?
    @State private var customBaseURL = ""
    @State private var customModelID = ""
    @State private var editingCustom: CloudProviderAuthSnapshot?
    @State private var showsAddAccount = false
    @State private var isStartingChat = false
    @State private var highlightedSnapshotID: String?
    @State private var previewMethod: ProviderLoginMethod?
    @State private var didOpenPreviewLogin = false
    @FocusState private var apiKeyFocused: Bool

    private var profiles: [CloudProviderAuthSnapshot] {
        model.authenticationSnapshots(for: provider.id)
    }

    private var loginMethods: [ProviderLoginMethod] {
        ProviderLoginMethod.methods(for: provider, catalog: model.ompProviderCatalog)
    }

    var body: some View {
        ScrollViewReader { scroller in
        List {
            Group {
                header
                    .padding(.top, SettingsMetrics.pageInsets.top)

                SettingsDivider()
                SettingsSectionTitle("Saved accounts")
                if profiles.isEmpty {
                    SettingsCaption("No accounts connected yet")
                }
                ForEach(profiles, id: \.snapshotId) { profile in
                    savedAccountRow(profile)
                }

                startChatButton
                    .padding(.top, 12)
                if profiles.isEmpty {
                    SettingsCaption("Add an account to start a chat.")
                } else if let active = model.activeAccount(for: provider.id) {
                    if let modelName = activeChatModel {
                        SettingsCaption("Uses \(active.label?.nonEmpty ?? accountMethod(active)) with \(modelName).")
                    } else {
                        SettingsCaption("Add a model ID to start chatting.")
                    }
                }

                if !loginMethods.isEmpty {
                    SettingsDivider()
                    addAccountButton
                    if model.ompBackendUnavailable {
                        SettingsCaption(OMPBackendSupport.unavailableMessage)
                            .accessibilityIdentifier("omp-backend-unavailable")
                    }
                } else if provider.id == ProviderAuthenticationDefinition.custom.id {
                    customAccountForm
                } else {
                    SettingsDivider()
                    SettingsSectionTitle("Mac runtime")
                    HStack(alignment: .top, spacing: SettingsMetrics.iconSpacing) {
                        Image(systemName: "macbook")
                            .font(.body)
                            .frame(width: SettingsMetrics.iconWidth)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(macRuntimeTitle)
                                .font(SettingsFont.rowTitle)
                            Text(macRuntimeDetail)
                                .font(SettingsFont.subtitle)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)
                }

                if let error = model.providerAuthenticationErrorMessage.nonEmpty {
                    SettingsDivider()
                    AuthenticationErrorRow(error: error) {
                        Task { await model.refreshProviderAuthentication() }
                    }
                }
            }
            .settingsListRow()
        }
        .onChange(of: highlightedSnapshotID) { _, id in
            guard let id else { return }
            withAnimation(.easeInOut(duration: 0.25)) { scroller.scrollTo(id, anchor: .center) }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(4))
                if highlightedSnapshotID == id { withAnimation { highlightedSnapshotID = nil } }
            }
        }
        }
        .settingsListStyle()
        // The full provider name appears once, in the header above.
        .navigationTitle("Accounts")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        await model.refreshProviderAuthentication()
                        // A successful catalog fetch also clears a stale backend-unavailable state.
                        await model.refreshOMPProviderCatalog()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(model.isRefreshingProviderAuthentication)
                .accessibilityLabel("Refresh authentication")
            }
        }
        .navigationDestination(isPresented: $showsAddAccount) {
            addAccountDestination
        }
        .onAppear {
            model.clearProviderAuthenticationError()
            openPreviewLoginIfRequested()
        }
        .confirmationDialog(
            "Remove this saved account?",
            isPresented: $showRemoveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Remove account", role: .destructive) {
                guard let removeTarget else { return }
                Task { _ = await model.revokeProviderAuthentication(removeTarget) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Sessions using this account may need another account selected.")
        }
    }

    /// Symbol, full provider name, and its sign-in summary, like the Settings sheet's account header.
    private var header: some View {
        HStack(spacing: SettingsMetrics.iconSpacing) {
            ProviderAuthenticationIcon(provider: provider, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(provider.name)
                    .font(SettingsFont.headerTitle)
                Text(provider.subtitle)
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 6)
    }

    private func savedAccountRow(_ profile: CloudProviderAuthSnapshot) -> some View {
        HStack(spacing: SettingsMetrics.iconSpacing) {
            Image(systemName: "checkmark.circle.fill")
                .font(.body)
                .foregroundStyle(.green)
                .frame(width: SettingsMetrics.iconWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.label?.nonEmpty ?? accountMethod(profile))
                    .font(SettingsFont.rowTitle)
                    .accessibilityIdentifier(
                        profile.snapshotId == highlightedSnapshotID ? "saved-account-new" : "saved-account"
                    )
                Text(accountDetail(profile))
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("saved-account-detail")
                if provider.id == ProviderAuthenticationDefinition.custom.id, profile.modelHint?.nonEmpty == nil {
                    Text("Add a model ID to start chatting")
                        .font(SettingsFont.subtitle)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("custom-missing-model")
                }
            }
            Spacer(minLength: 8)
            if provider.id == ProviderAuthenticationDefinition.custom.id {
                Button {
                    startEditingCustom(profile)
                } label: {
                    Image(systemName: "pencil")
                        .frame(width: 36, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Edit \(profile.label?.nonEmpty ?? "account")")
            }
            Button(role: .destructive) {
                removeTarget = profile
                showRemoveConfirmation = true
            } label: {
                Image(systemName: "trash")
                    .frame(width: 36, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Remove \(profile.label?.nonEmpty ?? accountMethod(profile))")
        }
        .padding(.vertical, 5)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .id(profile.snapshotId)
        .listRowBackground(
            profile.snapshotId == highlightedSnapshotID ? Color.green.opacity(0.14) : nil
        )
        .swipeActions(edge: .leading) {
            if !isActive(profile) {
                Button("Make active") { model.makeAccountActive(profile) }
                    .tint(chatTheme.accent)
            }
        }
    }

    private var startChatButton: some View {
        Button {
            startChat()
        } label: {
            HStack(spacing: 8) {
                if isStartingChat { ProgressView().controlSize(.small).tint(.white) }
                Text("Start chat")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(profiles.isEmpty || isStartingChat || activeChatModel == nil)
        .accessibilityIdentifier("provider-start-chat")
    }

    private var addAccountButton: some View {
        Button {
            showsAddAccount = true
        } label: {
            HStack(spacing: 10) {
                CompactSettingsLabel(
                    title: "Add account",
                    subtitle: ProviderLoginMethod.summary(of: loginMethods),
                    systemImage: "plus"
                )
                Spacer(minLength: 0)
                SettingsChevron()
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("provider-add-account")
    }

    @ViewBuilder
    private var customAccountForm: some View {
        SettingsDivider()
        SettingsSectionTitle(editingCustom.map { "Edit \($0.label?.nonEmpty ?? "account")" } ?? "New account name")
        TextField("For example, Personal or Work", text: $profileLabel)
            .textInputAutocapitalization(.words)
            .settingsField()
            .accessibilityIdentifier("custom-label")

        SettingsSectionTitle("Endpoint")
            .padding(.top, 8)
        TextField("https://api.example.com/v1", text: $customBaseURL)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
            .autocorrectionDisabled()
            .settingsField()
            .accessibilityIdentifier("custom-base-url")
        SettingsCaption("Use a public HTTPS endpoint with an OpenAI-compatible Chat Completions API.")

        SettingsSectionTitle("Model ID")
            .padding(.top, 8)
        TextField("deepseek-chat", text: $customModelID)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .settingsField()
            .accessibilityIdentifier("custom-model-id")
        if customModelIDTooLong {
            Text("Use at most \(Self.customModelIDLimit) characters.")
                .font(SettingsFont.subtitle)
                .foregroundStyle(.red)
                .padding(.vertical, 4)
        }
        SettingsCaption("The model name your endpoint serves, sent as the Chat Completions model field.")

        SettingsSectionTitle("Add API key")
            .padding(.top, 8)
        HStack(spacing: 10) {
            Image(systemName: "key")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            SecureField("Paste API key", text: $apiKey)
                .textContentType(.password)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive()
                .focused($apiKeyFocused)
                .accessibilityIdentifier("custom-api-key")
        }
        .settingsField()
        Button {
            Task { await saveAPIKey() }
        } label: {
            HStack(spacing: 8) {
                if isSaving { ProgressView().controlSize(.small) }
                Text(editingCustom == nil ? apiKeyActionTitle : "Save changes")
            }
            .font(SettingsFont.action)
            .frame(maxWidth: .infinity, minHeight: SettingsMetrics.textRowMinHeight, alignment: .center)
        }
        .buttonStyle(.borderless)
        .disabled(isSaving || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || customBaseURL.isEmpty || customModelIDValue.isEmpty || customModelIDTooLong)
        .accessibilityIdentifier("custom-save")
        if editingCustom != nil {
            Button("Cancel editing", role: .cancel) { stopEditingCustom() }
                .font(SettingsFont.rowTitle)
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity, minHeight: SettingsMetrics.textRowMinHeight, alignment: .center)
                .accessibilityIdentifier("custom-cancel-edit")
        }
        SettingsCaption(editingCustom == nil
            ? "Encrypted in your Kordi account and available to Cloud sessions on iPhone and Mac. The key is cleared from this screen after saving."
            : "Enter the endpoint and key again; this iPhone does not keep them. Saving replaces this account.")
    }

    private func saveAPIKey() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        let snapshot = await model.saveProviderAPIKey(
            provider: provider, apiKey: apiKey, label: profileLabel,
            replacing: editingCustom,
            baseURLOverride: provider.id == "custom" ? customBaseURL : nil,
            modelOverride: provider.id == "custom" ? customModelIDValue : nil
        )
        saved = snapshot != nil
        if let snapshot {
            highlightedSnapshotID = snapshot.snapshotId
            apiKey = ""
            profileLabel = ""
            customModelID = ""
            editingCustom = nil
            apiKeyFocused = false
        }
    }

    static let customModelIDLimit = 120
    private var customModelIDValue: String { customModelID.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var customModelIDTooLong: Bool { customModelIDValue.count > Self.customModelIDLimit }

    /// Editing re-publishes the same account; the endpoint and key are entered again.
    private func startEditingCustom(_ profile: CloudProviderAuthSnapshot) {
        editingCustom = profile
        profileLabel = profile.label ?? ""
        customModelID = profile.modelHint ?? ""
        customBaseURL = ""
        apiKey = ""
        saved = false
    }

    private func stopEditingCustom() {
        editingCustom = nil
        profileLabel = ""
        customModelID = ""
        apiKey = ""
    }

    private func accountDetail(_ profile: CloudProviderAuthSnapshot) -> String {
        let base = provider.id == ProviderAuthenticationDefinition.custom.id
            ? (profile.modelHint?.nonEmpty.map { "Custom API · \($0)" } ?? "Custom API")
            : accountMethod(profile)
        return isActive(profile) ? "\(base) · Active" : base
    }

    /// Every Custom API account is an API key.
    private var apiKeyActionTitle: String {
        if isSaving { return "Saving…" }
        if saved && apiKey.isEmpty { return "Saved" }
        return profiles.isEmpty ? "Save API key" : "Save another API key"
    }

    private func accountMethod(_ profile: CloudProviderAuthSnapshot) -> String {
        ProviderAccountMethod.label(for: profile, catalog: model.ompProviderCatalog)
    }

    /// Layer 2 when there is a choice of methods, otherwise the login screen.
    @ViewBuilder
    private var addAccountDestination: some View {
        let methods = loginMethods
        let labels = profiles.compactMap(\.label)
        if methods.count == 1, let method = methods.first {
            ProviderLoginScreen(
                provider: provider,
                method: method,
                existingLabels: labels,
                autoStart: previewMethod == method,
                onFinish: finishAddAccount,
                onStartChat: finishAndStartChat
            )
        } else {
            ProviderLoginMethodPicker(
                provider: provider,
                methods: methods,
                existingLabels: labels,
                initialMethod: previewMethod,
                autoStart: previewMethod != nil,
                onFinish: finishAddAccount,
                onStartChat: finishAndStartChat
            )
        }
    }

    private func finishAddAccount(_ snapshotID: String?) {
        previewMethod = nil
        showsAddAccount = false
        Task { @MainActor in
            // Highlight after the pop so the list can scroll to the new row.
            try? await Task.sleep(for: .milliseconds(450))
            highlightedSnapshotID = snapshotID
        }
    }

    /// Start chat on the completion screen uses the account just added, even
    /// when the provider keeps an earlier account active.
    private func finishAndStartChat(_ snapshotID: String?) {
        finishAddAccount(snapshotID)
        startChat(snapshotID: snapshotID)
    }

    private func isActive(_ profile: CloudProviderAuthSnapshot) -> Bool {
        model.activeAccount(for: provider.id)?.authChoice == profile.authChoice
    }

    private var activeChatModel: String? {
        model.activeAccount(for: provider.id).flatMap { model.preferredModel(for: $0, provider: provider) }
    }

    private func startChat(snapshotID: String? = nil) {
        guard !isStartingChat else { return }
        isStartingChat = true
        Task {
            _ = await model.startAgentChat(with: provider, snapshotID: snapshotID)
            isStartingChat = false
        }
    }

    /// `--preview-login-steps=<provider>[:<method>]` opens that login screen
    /// against the offline simulator so each step can be reviewed.
    private func openPreviewLoginIfRequested() {
        guard model.isPreviewMode, !didOpenPreviewLogin,
              let request = PreviewLoginSteps.request else { return }
        didOpenPreviewLogin = true
        guard let method = ProviderLoginMethod.preferred(
            in: loginMethods, provider: request.provider, selector: request.method
        ) else { return }
        previewMethod = method
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            showsAddAccount = true
        }
    }

    private var macRuntimeTitle: String {
        switch provider.id {
        case "github-copilot": "Sign in with GitHub on your Mac"
        case "lm-studio", "ollama": "Connect the local runtime on your Mac"
        default: "Managed by Kordi on your Mac"
        }
    }

    private var macRuntimeDetail: String {
        switch provider.id {
        case "github-copilot":
            "Copilot uses an interactive GitHub subscription login. Open Settings → Authentication on your Mac, then refresh this page to see its Cloud access status."
        case "lm-studio", "ollama":
            "This provider runs on your Mac's local network and cannot run directly on iPhone or Kordi Cloud. Configure it in Settings → Authentication on your Mac."
        default:
            "Open Settings → Authentication on your Mac to add or switch this access, then refresh this page."
        }
    }
}
