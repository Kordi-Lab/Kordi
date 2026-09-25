import SwiftUI

struct AgentModelPicker: View {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary
    let onDismiss: () -> Void
    @State private var selectedProvider = ""
    @State private var selectedAuthChoice = ""
    @State private var selectedModel = ""
    @State private var selectedThinking = "medium"
    @State private var isSaving = false
    @State private var isTesting = false
    @State private var routeTestResult: CloudProviderRouteTest?
    @State private var showsManualModel = false
    @State private var manualModelID = ""

    static let modelNamesByProvider = [
        "openai": [
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex-spark",
        ],
        "anthropic": [
            "claude-fable-5-1",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
        ],
        "google": ["gemini-3.1-pro"],
        "groq": ["llama-3.3-70b-versatile"],
        "openrouter": ["openai/gpt-5"],
        "xai": ["grok-4"],
    ]
    static func thinkingLevels(for model: String) -> [String] {
        switch model.split(separator: "/").last.map(String.init) {
        case "gpt-6-astra":
            return ["default", "low", "medium", "high", "xhigh", "max"]
        case "claude-fable-5-1":
            return ["default", "minimal", "low", "medium", "high", "xhigh", "max"]
        default:
            return ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]
        }
    }

    static func normalizedThinking(_ thinking: String, for model: String) -> String {
        guard !thinkingLevels(for: model).contains(thinking) else { return thinking }
        return model.split(separator: "/").last == "gpt-6-astra" ? "low" : "default"
    }

    private var thinkingLevels: [String] { Self.thinkingLevels(for: selectedModel) }

    private var routing: CloudModelRouting { model.runtimeRouting(for: conversation) }
    private var canEdit: Bool { model.canChangeRuntimeRouting(for: conversation) }
    private var selectedAccountIsUnavailable: Bool {
        !selectedAuthChoice.isEmpty && account(for: selectedAuthChoice) == nil
    }
    private var isCustomProvider: Bool {
        ProviderAuthenticationDefinition.canonicalID(selectedProvider) == ProviderAuthenticationDefinition.custom.id
    }

    private func account(for choice: String) -> CloudProviderAuthSnapshot? {
        model.authenticationSnapshots(for: selectedProvider).first { $0.authChoice == choice }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("AGENT MODEL")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)

                Spacer(minLength: 8)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(isSaving)
                .accessibilityLabel("Close agent model")
            }
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .padding(.top, 6)

            VStack(spacing: 0) {
                AgentModelMenuRow(
                    title: "Provider",
                    options: providers,
                    selection: $selectedProvider,
                    isEnabled: canEdit && !providers.isEmpty && !isTesting,
                    optionLabel: providerLabel
                )

                Divider()

                AgentModelMenuRow(
                    title: "Account",
                    options: accountChoices,
                    selection: $selectedAuthChoice,
                    isEnabled: canEdit && !accountChoices.isEmpty && !isTesting,
                    optionLabel: accountLabel
                )

                Divider()

                AgentModelMenuRow(
                    title: "Model",
                    options: routes,
                    selection: $selectedModel,
                    isEnabled: canEdit && !selectedProvider.isEmpty && !routes.isEmpty && !isTesting,
                    optionLabel: modelLabel
                )

                Divider()

                AgentModelMenuRow(
                    title: "Thinking level",
                    options: selectedProvider.isEmpty ? [] : thinkingLevels,
                    selection: $selectedThinking,
                    isEnabled: canEdit && !selectedProvider.isEmpty && !isTesting,
                    optionLabel: thinkingLabel
                )
            }
            .padding(.horizontal, 12)

            if selectedProvider == "custom" || showsManualModel {
                TextField("Model ID", text: $manualModelID)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal, 12)
                    .onChange(of: manualModelID) { _, value in
                        if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            selectedModel = "\(selectedProvider)/\(value.trimmingCharacters(in: .whitespacesAndNewlines))"
                        }
                    }
            } else {
                Button("Enter another model ID") { showsManualModel = true }
                    .font(.caption)
                    .padding(.horizontal, 12)
            }

            if !canEdit {
                Label("Only the agent owner can change this model route.", systemImage: "lock")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
            }
            if selectedAccountIsUnavailable {
                Label("Account unavailable. Choose another saved account or reconnect it in Settings → Authentication.", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 12)
                    .accessibilityIdentifier("agent-model-account-unavailable")
            }

            if isTesting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Testing route through OMP…")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("agent-model-route-test-pending")
            } else if let routeTestResult {
                // Every value shown here comes from the server-confirmed result.
                VStack(alignment: .leading, spacing: 5) {
                    Label("Route confirmed", systemImage: "checkmark.circle.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.green)
                    Text("Runner \(routeTestResult.runner) · \(routeTestResult.accountLabel) · \(modelLabel(routeTestResult.model))")
                        .font(.footnote)
                    Text(routeTestResult.response)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("agent-model-route-test-result")
            } else if let error = model.providerAuthenticationErrorMessage?.nonEmpty,
                      error != OMPBackendSupport.unavailableMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 12)
            }

            HStack {
                Button {
                    testRoute()
                } label: {
                    if isTesting {
                        ProgressView()
                    } else {
                        Text("Test route")
                    }
                }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .disabled(!canEdit || isSaving || isTesting || selectedModel.isEmpty || selectedAuthChoice.isEmpty
                    || selectedAccountIsUnavailable || model.ompBackendUnavailable)
                .accessibilityLabel("Test route")
                .accessibilityIdentifier("agent-model-test-route")
                Spacer()
                Button {
                    save()
                } label: {
                    if isSaving {
                        ProgressView().tint(.white)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
                .disabled(!canEdit || isSaving || isTesting || selectedModel.isEmpty || selectedAuthChoice.isEmpty || selectedAccountIsUnavailable)
                .accessibilityLabel("Save")
                .accessibilityIdentifier("agent-model-save")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            Text(model.ompBackendUnavailable
                ? OMPBackendSupport.unavailableMessage
                : "Test route runs one short hosted model request and may use provider quota.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .accessibilityIdentifier("agent-model-test-route-note")
        }
        .frame(maxWidth: .infinity)
        .modifier(ComposerFloatingPanelSurfaceModifier())
        .onAppear { loadSelection() }
        .task {
            if !model.hasLiveOMPProviderCatalog && !model.ompBackendUnavailable {
                await model.refreshOMPProviderCatalog()
            }
        }
        .onChange(of: selectedProvider) { _, provider in
            routeTestResult = nil
            selectCompatibleModel(for: provider)
            selectCompatibleAccount(for: provider)
        }
        .onChange(of: selectedAuthChoice) { previous, choice in
            routeTestResult = nil
            if isCustomProvider, !previous.isEmpty {
                // A Custom API endpoint serves only the model its account names.
                manualModelID = ""
                selectedModel = account(for: choice)?.modelHint?.nonEmpty.map { "\(selectedProvider)/\($0)" } ?? ""
            } else if !routes.contains(selectedModel) {
                selectedModel = routes.first ?? ""
            }
        }
        .onChange(of: selectedModel) { _, value in
            routeTestResult = nil
            selectedThinking = Self.normalizedThinking(selectedThinking, for: value)
        }
        .onChange(of: selectedThinking) { _, _ in routeTestResult = nil }
        .onChange(of: routing) { _, _ in
            guard !isSaving else { return }
            loadSelection()
        }
        .onChange(of: model.sessionRuntimeRouteRevision) { _, _ in
            guard !isSaving else { return }
            loadSelection()
        }
    }

    private var providers: [String] {
        var available = model.providerAuthSnapshots.keys.sorted { left, right in
            let leftCreatedAt = model.providerAuthSnapshots[left]?.createdAt ?? ""
            let rightCreatedAt = model.providerAuthSnapshots[right]?.createdAt ?? ""
            if leftCreatedAt == rightCreatedAt { return left < right }
            return leftCreatedAt > rightCreatedAt
        }
        guard let routeProvider = routing.defaultAuthProvider?.nonEmpty.map(
            ProviderAuthenticationDefinition.canonicalID
        ) else { return available }
        if let index = available.firstIndex(of: routeProvider) {
            available.remove(at: index)
        } else if routing.defaultAuthChoice?.nonEmpty == nil {
            return available
        }
        // A routed provider whose last account was removed stays listed, so the
        // route shows Account unavailable instead of moving to another provider.
        return [routeProvider] + available
    }

    private var routes: [String] {
        guard let provider = selectedProvider.nonEmpty else { return [] }
        let canonicalProvider = ProviderAuthenticationDefinition.canonicalID(provider)
        let selectedAccount = account(for: selectedAuthChoice)
        let catalogProvider = selectedAccount?.provider == "openai-codex" ? "openai-codex" : canonicalProvider
        let catalogModels = model.ompProviderCatalog
            .first { $0.id == catalogProvider }?.models ?? []
        let names = (catalogModels.isEmpty ? nil : Array(catalogModels.prefix(30)))
            ?? Self.modelNamesByProvider[canonicalProvider]
            ?? model.authenticationProviderDefinitions
                .first(where: { ProviderAuthenticationDefinition.canonicalID($0.id) == canonicalProvider })?
                .defaultModel.map { [$0] }
            ?? []
        let suggested = names.map { name in
            "\(provider)/\(name)"
        }
        // A Custom API route's model belongs to the account it was saved with.
        let routedAccount = !isCustomProvider || selectedAuthChoice == routing.defaultAuthChoice
        let current = routing.defaultModel?.nonEmpty.flatMap { currentModel -> String? in
            guard routedAccount else { return nil }
            let currentProvider = currentModel.split(separator: "/", maxSplits: 1)
                .first.map(String.init)
            return ProviderAuthenticationDefinition.canonicalID(currentProvider ?? "")
                == ProviderAuthenticationDefinition.canonicalID(provider)
                ? currentModel
                : nil
        }
        let savedModel = selectedAccount?.modelHint?.nonEmpty.map { "\(provider)/\($0)" }
        let manualModel = manualModelID.nonEmpty.map { "\(provider)/\($0)" }
        return ([savedModel, manualModel, current].compactMap { $0 } + suggested)
            .reduce(into: []) { options, option in
                if !options.contains(option) { options.append(option) }
            }
    }

    private var accountChoices: [String] {
        let saved = model.authenticationSnapshots(for: selectedProvider).map(\.authChoice)
        guard ProviderAuthenticationDefinition.canonicalID(routing.defaultAuthProvider ?? "")
            == ProviderAuthenticationDefinition.canonicalID(selectedProvider),
              let routed = routing.defaultAuthChoice?.nonEmpty,
              !saved.contains(routed) else { return saved }
        return [routed] + saved
    }

    private func accountLabel(_ choice: String) -> String {
        let accounts = model.authenticationSnapshots(for: selectedProvider)
        guard let index = accounts.firstIndex(where: { $0.authChoice == choice }) else { return "Account unavailable" }
        if let label = accounts[index].label?.nonEmpty { return label }
        return "\(ProviderAccountMethod.label(for: accounts[index], catalog: model.ompProviderCatalog)) \(index + 1)"
    }

    private func providerLabel(_ providerID: String) -> String {
        guard let providerID = providerID.nonEmpty else { return "No Provider" }
        let canonicalID = ProviderAuthenticationDefinition.canonicalID(providerID)
        let provider = model.authenticationProviderDefinitions
            .first(where: { ProviderAuthenticationDefinition.canonicalID($0.id) == canonicalID })?
            .shortName
            ?? providerID.replacingOccurrences(of: "_", with: " ").capitalized
        return provider
    }

    private func loadSelection() {
        let routeProvider = routing.defaultAuthProvider?.nonEmpty.map(
            ProviderAuthenticationDefinition.canonicalID
        )
        selectedProvider = routeProvider.flatMap { providers.contains($0) ? $0 : nil }
            ?? providers.first
            ?? ""
        let routeChoice = routeProvider == selectedProvider ? routing.defaultAuthChoice : nil
        selectedAuthChoice = routeChoice.flatMap { accountChoices.contains($0) ? $0 : nil }
            ?? accountChoices.first
            ?? ""
        let routeModel = routing.defaultModel?.nonEmpty
        let routeModelProvider = routeModel.flatMap { value in
            value.firstIndex(of: "/").map {
                ProviderAuthenticationDefinition.canonicalID(String(value[..<$0]))
            }
        }
        selectedModel = routeModelProvider == selectedProvider
            ? routeModel ?? ""
            : routes.first ?? ""
        selectCompatibleModel(for: selectedProvider)
        selectedThinking = selectedProvider.isEmpty
            ? ""
            : Self.normalizedThinking(routing.thinking?.nonEmpty ?? "medium", for: selectedModel)
    }

    private func selectCompatibleModel(for provider: String) {
        guard let provider = provider.nonEmpty else { return }
        let currentProvider = selectedModel.split(separator: "/", maxSplits: 1)
            .first.map(String.init)
        guard ProviderAuthenticationDefinition.canonicalID(currentProvider ?? "")
            != ProviderAuthenticationDefinition.canonicalID(provider) else { return }
        selectedModel = routes.first ?? ""
    }

    private func selectCompatibleAccount(for provider: String) {
        // `accountChoices` keeps a routed account that was removed, so the route
        // stays attached to it until the owner explicitly picks another account.
        guard !accountChoices.contains(selectedAuthChoice) else { return }
        selectedAuthChoice = accountChoices.first ?? ""
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            let saved = await model.updateRuntimeRouting(
                for: conversation,
                provider: selectedProvider,
                authChoice: selectedAuthChoice,
                model: selectedModel,
                thinking: Self.normalizedThinking(selectedThinking, for: selectedModel)
            )
            isSaving = false
            if saved { onDismiss() }
        }
    }

    /// Tests the selection on screen without saving it; only Save changes the route.
    private func testRoute() {
        guard !isSaving, !isTesting, !selectedAccountIsUnavailable else { return }
        isTesting = true
        routeTestResult = nil
        model.clearProviderAuthenticationError()
        Task {
            routeTestResult = await model.testProviderRoute(
                provider: selectedProvider,
                authChoice: selectedAuthChoice,
                model: selectedModel,
                thinking: Self.normalizedThinking(selectedThinking, for: selectedModel)
            )
            isTesting = false
        }
    }

    private func modelLabel(_ value: String) -> String {
        guard !value.isEmpty else { return "-" }
        guard let separator = value.firstIndex(of: "/") else { return value }
        return String(value[value.index(after: separator)...])
    }

    private func thinkingLabel(_ value: String) -> String {
        guard !value.isEmpty else { return "-" }
        return value == "xhigh" ? "Extra High" : value.capitalized
    }
}
