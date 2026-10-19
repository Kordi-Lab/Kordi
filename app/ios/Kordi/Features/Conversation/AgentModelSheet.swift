import SwiftUI

struct AgentModelPicker: View {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary
    let onDismiss: () -> Void
    @Binding var page: AgentModelPickerPage
    @Environment(\.kordiChatTheme) private var chatTheme
    @State private var search = ""
    @State private var showsAllModels = false
    @State private var showsAccountConfirmation = false
    @State private var dismissAfterConfirmation = false
    @State private var saveError: String?
    @State private var retrySelection: AgentModelRouteSelection?

    @State private var selectedProvider = ""
    @State private var selectedAuthChoice = ""
    @State private var selectedModel = ""
    @State private var selectedThinking = "medium"
    @State private var isSaving = false
    @State private var showsManualModel = false
    @State private var manualModelID = ""

    static let modelNamesByProvider = [
        "openai": [
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
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
        case "gpt-6-astra", "gpt-6-sol", "gpt-6-luna":
            return ["default", "low", "medium", "high", "xhigh", "max"]
        case "claude-fable-5-1":
            return ["default", "minimal", "low", "medium", "high", "xhigh", "max"]
        default:
            return ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]
        }
    }

    static func normalizedThinking(_ thinking: String, for model: String) -> String {
        guard !thinkingLevels(for: model).contains(thinking) else { return thinking }
        let name = model.split(separator: "/").last.map(String.init) ?? ""
        return ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].contains(name) ? "low" : "default"
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
        VStack(spacing: 6) {
            if page == .effort {
                effortControl
            } else {
                HStack {
                    if page != .models {
                        Button { page = .models } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("Back to models")
                    }
                    Text(page == .accounts ? "Choose account" : "Select model")
                        .font(.caption.weight(.semibold))
                    Spacer()
                    Button(action: onDismiss) { Image(systemName: "xmark") }
                        .accessibilityLabel("Close model picker")
                }
                .buttonStyle(.plain)
                .frame(minHeight: 28)
                .padding(.horizontal, 6)
                if page == .accounts { accountsMenu } else { modelsMenu }
            }
            if let saveError {
                VStack(alignment: .leading, spacing: 4) {
                    Text(saveError).font(.caption).foregroundStyle(.secondary)
                    if let retrySelection {
                        Button("Retry") { apply(retrySelection, dismissAfter: page != .effort) }
                    }
                }
                .accessibilityIdentifier("agent-model-save-error")
            }
        }
        .padding(page == .effort ? 8 : 10)
        .frame(width: page == .effort ? 208 : 288)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).stroke(chatTheme.accent.opacity(0.15), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.06), radius: 6, y: 3)
        .tint(chatTheme.accent)
        .disabled(isSaving)
        .onAppear { loadSelection() }
        .task {
            if !model.hasLiveOMPProviderCatalog && !model.ompBackendUnavailable {
                await model.refreshOMPProviderCatalog()
            }
        }
        .onChange(of: routing) { _, _ in
            if !isSaving && !showsAccountConfirmation { loadSelection() }
        }
        .onChange(of: model.sessionRuntimeRouteRevision) { _, _ in
            if !isSaving && !showsAccountConfirmation { loadSelection() }
        }
        .confirmationDialog("Change shared account?", isPresented: $showsAccountConfirmation, titleVisibility: .visible) {
            Button("Change account") { save(dismissAfter: dismissAfterConfirmation, confirmAccountChange: false) }
            Button("Cancel", role: .cancel) { loadSelection() }
        } message: {
            Text("Future agent replies in this conversation will use \(accountLabel(selectedAuthChoice)).")
        }
    }

    private var effortControl: some View {
        VStack(spacing: 4) {
            HStack(spacing: 0) {
                Color.clear.frame(width: 28, height: 28).accessibilityHidden(true)
                Spacer(minLength: 0)
                VStack(spacing: 1) {
                    Text(thinkingLabel(selectedThinking))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(chatTheme.accent)
                    Button { page = .models } label: {
                        HStack(spacing: 2) {
                            Text(modelLabel(selectedModel)).lineLimit(1)
                            Image(systemName: "chevron.right").font(.system(size: 7, weight: .semibold))
                        }
                        .font(.caption2).foregroundStyle(.secondary)
                    }
                    .accessibilityLabel("Select model")
                }
                Spacer(minLength: 0)
                Button {
                    selectedThinking = "default"
                    save(dismissAfter: false)
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .disabled(!canEdit || selectedAccountIsUnavailable || selectedAuthChoice.isEmpty)
                .accessibilityLabel("Reset effort to model default")
            }
            .buttonStyle(.plain)
            AgentEffortSlider(
                value: $selectedThinking,
                levels: thinkingLevels.filter { $0 != "default" },
                accent: chatTheme.accent,
                onCommit: { save(dismissAfter: false) }
            )
            .disabled(!canEdit || selectedAccountIsUnavailable || selectedAuthChoice.isEmpty)
        }
    }

    private var modelChoices: [String] {
        providers.flatMap { provider in
            availableRoutes(for: provider, authChoice: provider == selectedProvider
                ? selectedAuthChoice : model.authenticationSnapshots(for: provider).first?.authChoice ?? "")
        }
    }

    private var visibleModels: [String] {
        if showsAllModels {
            return modelChoices.filter { search.isEmpty || modelLabel($0).localizedCaseInsensitiveContains(search) }
        }
        var choices = Array(modelChoices.prefix(5))
        if !selectedModel.isEmpty && !choices.contains(selectedModel) { choices.append(selectedModel) }
        return choices
    }

    private var defaultRouteModel: String? {
        let preferred = model.authenticationProviderDefinitions.first {
            ProviderAuthenticationDefinition.canonicalID($0.id) == ProviderAuthenticationDefinition.canonicalID(selectedProvider)
        }?.defaultModel
        return preferred.map { "\(selectedProvider)/\($0)" }.flatMap { routes.contains($0) ? $0 : nil } ?? routes.first
    }

    private var modelsMenu: some View {
        VStack(spacing: 2) {
            if !canEdit {
                Label("Only the agent owner can change this model route.", systemImage: "lock")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if selectedAccountIsUnavailable {
                Button("Account unavailable") { page = .accounts }
                    .font(.caption).foregroundStyle(.orange)
                    .accessibilityIdentifier("agent-model-account-unavailable")
            }
            if showsAllModels {
                TextField("Find a model", text: $search).textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            } else {
                pickerRow("Default", detail: defaultRouteModel.map(modelLabel)) {
                    if let defaultRouteModel { selectedThinking = "default"; chooseModel(defaultRouteModel) }
                }
                .disabled(!canEdit || defaultRouteModel == nil)
            }
            ScrollView {
                VStack(spacing: 1) {
                    ForEach(visibleModels, id: \.self) { value in
                        pickerRow(modelLabel(value), selected: value == selectedModel) { chooseModel(value) }
                            .disabled(!canEdit)
                            .accessibilityIdentifier("agent-model-option-\(value)")
                    }
                    if visibleModels.isEmpty { Text("No models found").font(.caption).foregroundStyle(.secondary) }
                }
            }
            .frame(height: min(240, max(36, CGFloat(visibleModels.count) * 37)))
            if !showsAllModels && modelChoices.count > 5 {
                pickerRow("More models", chevron: true) { showsAllModels = true }
            }
            Divider()
            pickerRow(selectedAccountIsUnavailable ? "Account unavailable" : accountLabel(selectedAuthChoice), chevron: true) { page = .accounts }
                .accessibilityIdentifier("agent-model-account")
            if showsAllModels {
                if showsManualModel || isCustomProvider {
                    TextField("Model ID", text: $manualModelID)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder).onSubmit { applyManualModel() }
                    Button("Use model", action: applyManualModel).disabled(!canEdit || manualModelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else {
                    Button("Enter another model ID") { showsManualModel = true }.font(.caption)
                }
            }
        }
    }

    private var accountsMenu: some View {
        VStack(spacing: 4) {
            Menu {
                ForEach(providers, id: \.self) { provider in
                    Button(providerLabel(provider)) {
                        selectedProvider = provider
                        selectedAuthChoice = ""
                        selectCompatibleModel(for: provider)
                    }
                }
            } label: { HStack { Text(providerLabel(selectedProvider)); Spacer(); Image(systemName: "chevron.down") } }
            .font(.caption).padding(8).disabled(!canEdit)
            ForEach(accountChoices, id: \.self) { choice in
                pickerRow(accountLabel(choice), selected: choice == selectedAuthChoice) { chooseAccount(choice) }
                    .disabled(!canEdit || account(for: choice) == nil)
            }
            if !accountChoices.contains(where: { account(for: $0) != nil }) {
                Text("No signed-in account. Connect one in Settings → Authentication.")
                    .font(.caption).foregroundStyle(.secondary)
            }

        }
    }

    private func pickerRow(_ title: String, detail: String? = nil, selected: Bool = false,
                           chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.caption).foregroundStyle(.primary)
                    if let detail { Text(detail).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 4)
                if selected { Image(systemName: "checkmark").font(.caption).foregroundStyle(chatTheme.accent) }
                if chevron { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 8).frame(minHeight: 36).contentShape(Rectangle())
            .background(selected ? chatTheme.accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func chooseModel(_ value: String) {
        let provider = value.split(separator: "/", maxSplits: 1).first.map(String.init) ?? selectedProvider
        let changesProvider = ProviderAuthenticationDefinition.canonicalID(provider) != ProviderAuthenticationDefinition.canonicalID(selectedProvider)
        selectedModel = value
        selectedThinking = Self.normalizedThinking(selectedThinking, for: value)
        if changesProvider {
            selectedProvider = provider
            selectedAuthChoice = ""
            page = .accounts
        } else if selectedAccountIsUnavailable || selectedAuthChoice.isEmpty {
            page = .accounts
        } else {
            save()
        }
    }

    private func chooseAccount(_ choice: String) {
        selectedAuthChoice = choice
        if isCustomProvider {
            manualModelID = ""
            selectedModel = account(for: choice)?.modelHint?.nonEmpty.map { "\(selectedProvider)/\($0)" } ?? ""
        } else if !routes.contains(selectedModel) { selectedModel = routes.first ?? "" }
        selectedThinking = Self.normalizedThinking(selectedThinking, for: selectedModel)
        save(dismissAfter: false)
    }

    private func applyManualModel() {
        guard let value = manualModelID.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else { return }
        chooseModel("\(selectedProvider)/\(value)")
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

    private var routes: [String] { availableRoutes(for: selectedProvider, authChoice: selectedAuthChoice) }

    private func availableRoutes(for provider: String, authChoice: String) -> [String] {
        guard let provider = provider.nonEmpty else { return [] }
        let canonicalProvider = ProviderAuthenticationDefinition.canonicalID(provider)
        let selectedAccount = model.authenticationSnapshots(for: provider).first { $0.authChoice == authChoice }
        let catalogProvider = selectedAccount?.provider == "openai-codex" ? "openai-codex" : canonicalProvider
        let catalogModels = model.ompProviderCatalog
            .first { $0.id == catalogProvider }?.models ?? []
        // Long catalogs are capped, so the current models listed above come first.
        let preferred = (Self.modelNamesByProvider[canonicalProvider] ?? []).filter(catalogModels.contains)
        let ordered = preferred + catalogModels.filter { !preferred.contains($0) }
        let names = (catalogModels.isEmpty ? nil : Array(ordered.prefix(30)))
            ?? Self.modelNamesByProvider[canonicalProvider]
            ?? model.authenticationProviderDefinitions
                .first(where: { ProviderAuthenticationDefinition.canonicalID($0.id) == canonicalProvider })?
                .defaultModel.map { [$0] }
            ?? []
        let suggested = names.map { name in
            "\(provider)/\(name)"
        }
        // A Custom API route's model belongs to the account it was saved with.
        let routedAccount = canonicalProvider != "custom" || authChoice == routing.defaultAuthChoice
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
        let manualModel = provider == selectedProvider ? manualModelID.nonEmpty.map { "\(provider)/\($0)" } : nil
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

    private func save(dismissAfter: Bool = true, confirmAccountChange: Bool = true) {
        guard canEdit, !isSaving, !selectedAccountIsUnavailable,
              !selectedAuthChoice.isEmpty, !selectedModel.isEmpty else { return }
        let changesAccount = routing.defaultAuthChoice != selectedAuthChoice
            || ProviderAuthenticationDefinition.canonicalID(routing.defaultAuthProvider ?? "") != ProviderAuthenticationDefinition.canonicalID(selectedProvider)
        if confirmAccountChange && conversation.kind != .agent && changesAccount {
            dismissAfterConfirmation = dismissAfter
            showsAccountConfirmation = true
            return
        }
        apply(AgentModelRouteSelection(provider: selectedProvider, account: selectedAuthChoice,
            model: selectedModel, effort: Self.normalizedThinking(selectedThinking, for: selectedModel)), dismissAfter: dismissAfter)
    }

    private func apply(_ selection: AgentModelRouteSelection, dismissAfter: Bool) {
        guard !isSaving, canEdit else { return }
        isSaving = true
        saveError = nil
        retrySelection = nil
        Task { @MainActor in
            let saved = await model.updateRuntimeRouting(for: conversation, provider: selection.provider,
                authChoice: selection.account, model: selection.model, thinking: selection.effort)
            isSaving = false
            loadSelection()
            if saved {
                if dismissAfter { onDismiss() }
            } else {
                saveError = "Could not change the model route."
                retrySelection = selection
            }
        }
    }

    private func modelLabel(_ value: String) -> String { AgentModelPresentation.name(value) }
    private func thinkingLabel(_ value: String) -> String { AgentModelPresentation.effort(value) }
}

enum AgentModelPickerPage { case models, effort, accounts }

private struct AgentModelRouteSelection {
    let provider: String
    let account: String
    let model: String
    let effort: String
}

enum AgentModelPresentation {
    static func notice(_ message: ChatMessage) -> String {
        guard message.isAgentModelChangeNotice,
              let rawModel = ChatMessage.modelFromAgentModelChangeNotice(message.text),
              let range = message.text.range(of: rawModel) else { return message.text }
        return message.text.replacingCharacters(in: range, with: name(rawModel))
    }

    static func name(_ value: String) -> String {
        let id = value.split(separator: "/").last.map(String.init) ?? value
        guard !id.isEmpty, id != "default" else { return "Default" }
        guard ["gpt-", "claude-", "gemini-", "grok-"].contains(where: id.hasPrefix) else { return id }
        let normalized = id.replacingOccurrences(of: "(\\d)-(\\d)", with: "$1.$2", options: .regularExpression)
        return normalized.split(separator: "-").map { word in
            word == "gpt" ? "GPT" : word.prefix(1).uppercased() + word.dropFirst()
        }.joined(separator: " ").replacingOccurrences(of: "^GPT ", with: "GPT-", options: .regularExpression)
    }

    static func effort(_ value: String) -> String {
        if value.isEmpty || ["default", "auto", "thinking"].contains(value) { return "Default" }
        return value == "xhigh" ? "Extra high" : value.capitalized
    }
}

private struct AgentEffortSlider: View {
    @Environment(\.isEnabled) private var isEnabled
    @Binding var value: String
    let levels: [String]
    let accent: Color
    let onCommit: () -> Void
    private var index: Int { levels.firstIndex(of: value) ?? 0 }

    var body: some View {
        GeometryReader { geometry in
            let travel = max(0, geometry.size.width - 24)
            let fraction = Double(index) / Double(max(1, levels.count - 1))
            ZStack(alignment: .leading) {
                Capsule().fill(accent.opacity(0.12)).frame(height: 20)
                Capsule().fill(accent).frame(width: levels.contains(value) ? 12 + travel * fraction : 0, height: 20)
                HStack {
                    ForEach(levels, id: \.self) { level in
                        Circle().fill(Color.secondary.opacity(0.35)).frame(width: 4, height: 4)
                        if level != levels.last { Spacer(minLength: 0) }
                    }
                }.padding(.horizontal, 12)
                Circle().fill(Color(uiColor: .systemBackground)).shadow(color: .black.opacity(0.15), radius: 2, y: 1)
                    .frame(width: 20, height: 20).offset(x: 2 + travel * fraction)
            }
            .frame(height: 28).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                guard isEnabled, levels.count > 1, travel > 0 else { return }
                let step = Int(((gesture.location.x - 12) / travel * Double(levels.count - 1)).rounded())
                value = levels[min(max(0, step), levels.count - 1)]
            }.onEnded { _ in if isEnabled { onCommit() } })
        }
        .frame(height: 28)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thinking effort")
        .accessibilityValue(AgentModelPresentation.effort(value))
        .accessibilityIdentifier("agent-effort-slider")
        .accessibilityAdjustableAction { direction in
            guard isEnabled, !levels.isEmpty else { return }
            switch direction {
            case .increment: value = levels[min(index + 1, levels.count - 1)]
            case .decrement: value = levels[max(index - 1, 0)]
            @unknown default: return
            }
            onCommit()
        }
    }
}
