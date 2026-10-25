import SwiftUI

struct AgentModelPicker: View {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary
    let onDismiss: () -> Void
    @Binding var page: AgentModelPickerPage
    var maxHeight: CGFloat = .infinity
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var search = ""
    @State private var listContentHeight: CGFloat = 0
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
            "gpt-6.1-sol",
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
            "claude-sonnet-5-5",
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
    /// OMP's catalog efforts for the model, then its family (gpt-6.1-sol uses
    /// gpt-6-sol), then the built-in table when the catalog has no entry.
    static func thinkingLevels(for model: String, catalog: [OMPProviderCatalogEntry] = OMPProviderCatalog.pinned) -> [String] {
        if let efforts = catalogEfforts(for: model, catalog: catalog) {
            return ["default"] + efforts.filter { $0 != "default" }
        }
        switch model.split(separator: "/").last.map(String.init) {
        case "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna":
            return ["default", "low", "medium", "high", "xhigh", "max"]
        case "claude-fable-5-1":
            return ["default", "minimal", "low", "medium", "high", "xhigh", "max"]
        default:
            return ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]
        }
    }

    private static func catalogEfforts(for model: String, catalog: [OMPProviderCatalogEntry]) -> [String]? {
        let parts = model.split(separator: "/", maxSplits: 1).map(String.init)
        guard let name = parts.last?.split(separator: "/").last.map(String.init), !name.isEmpty else { return nil }
        let family: (String) -> String = { $0 == "openai-codex" ? "openai" : ProviderAuthenticationDefinition.canonicalID($0) }
        let entries = parts.count > 1
            ? catalog.filter { $0.id == parts[0] } + catalog.filter { $0.id != parts[0] && family($0.id) == family(parts[0]) }
            : catalog
        let familyName = name.replacingOccurrences(of: "(\\d+)\\.\\d+(?=-|$)", with: "$1", options: .regularExpression)
        for candidate in [name, familyName] {
            if let efforts = entries.lazy.compactMap({ $0.modelThinking[candidate]?.efforts }).first(where: { !$0.isEmpty }) {
                return efforts
            }
        }
        return nil
    }

    static func normalizedThinking(_ thinking: String, for model: String,
                                   catalog: [OMPProviderCatalogEntry] = OMPProviderCatalog.pinned) -> String {
        guard !thinkingLevels(for: model, catalog: catalog).contains(thinking) else { return thinking }
        let name = model.split(separator: "/").last.map(String.init) ?? ""
        return name.hasPrefix("gpt-6") ? "low" : "default"
    }

    private var thinkingLevels: [String] { Self.thinkingLevels(for: selectedModel, catalog: model.ompProviderCatalog) }

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
            if showsAccountConfirmation {
                accountConfirmation
            } else if page == .effort {
                effortControl
            } else {
                HStack {
                    if page != .models {
                        Button { page = .models } label: {
                            Image(systemName: "chevron.left").frame(width: 28, height: 28).contentShape(Rectangle())
                        }
                        .accessibilityLabel("Back to models")
                    }
                    Text(page == .accounts ? "Choose account" : "Select model")
                        .font(.body.weight(.semibold))
                    Spacer()
                    Button(action: onDismiss) {
                        Image(systemName: "xmark").frame(width: 36, height: 36).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close model picker")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .frame(minHeight: 36)
                .padding(.leading, page == .models ? 12 : 0)
                // The title row stays pinned; only the rows scroll.
                ScrollView {
                    Group { if page == .accounts { accountsMenu } else { modelsMenu } }
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listContentHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(listContentHeight, max(120, maxHeight - 16 - 8 - 42)))
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
        .padding([.top, .horizontal], 16)
        .padding(.bottom, page == .effort || showsAccountConfirmation ? 16 : 8)
        .containerRelativeFrame(.horizontal) { width, _ in min(width - 32, 360) }
        .fixedSize(horizontal: false, vertical: true)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.ultraThinMaterial)
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(colorScheme == .dark ? Color.black.opacity(0.6) : Color.white.opacity(0.72)))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(chatTheme.accent.opacity(0.15), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.4 : 0.12), radius: 25, y: 18)
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.2 : 0.05), radius: 5, y: 2)
        .tint(chatTheme.accent)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-model-panel")
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
    }

    /// Shown inside the panel: the picker lives in a window overlay, not a presenting view controller.
    private var accountConfirmation: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Change shared account?").font(.body.weight(.semibold))
            Text("Future agent replies in this conversation will use \(accountLabel(selectedAuthChoice)).")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("Cancel") {
                    showsAccountConfirmation = false
                    loadSelection()
                }
                .buttonStyle(.bordered)
                Button("Change account") {
                    showsAccountConfirmation = false
                    save(dismissAfter: dismissAfterConfirmation, confirmAccountChange: false)
                }
                .buttonStyle(.borderedProminent)
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var effortControl: some View {
        VStack(spacing: 14) {
            Button { page = .models } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(AgentModelPresentation.shortName(selectedModel)).lineLimit(1)
                        .font(.body.weight(.semibold)).foregroundStyle(.primary)
                    Text(thinkingLabel(selectedThinking)).lineLimit(1)
                        .font(.body).foregroundStyle(.secondary)
                        .contentTransition(reduceMotion ? .identity : .opacity)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 4).padding(.top, 2)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Select model")
            AgentEffortSlider(
                value: $selectedThinking,
                levels: thinkingLevels.filter { $0 != "default" },
                accent: chatTheme.accent,
                onCommit: { save(dismissAfter: false) }
            )
            .disabled(!canEdit || selectedAccountIsUnavailable || selectedAuthChoice.isEmpty)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: selectedThinking)
    }

    private var modelChoices: [String] {
        Self.uniqueModels(providers.flatMap { provider in
            availableRoutes(for: provider, authChoice: provider == selectedProvider
                ? selectedAuthChoice : model.authenticationSnapshots(for: provider).first?.authChoice ?? "")
        })
    }

    /// openai and openai-codex routes to one model id are the same row.
    static func sameModel(_ left: String, _ right: String) -> Bool { modelKey(left) == modelKey(right) }

    private static func modelKey(_ route: String) -> String {
        let parts = route.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return route }
        return "\(ProviderAuthenticationDefinition.canonicalID(parts[0]))/\(parts[1])"
    }

    static func uniqueModels(_ routes: [String]) -> [String] {
        routes.reduce(into: []) { unique, route in
            if !unique.contains(where: { sameModel($0, route) }) { unique.append(route) }
        }
    }

    private var visibleModels: [String] {
        if showsAllModels {
            return modelChoices.filter { search.isEmpty || modelLabel($0).localizedCaseInsensitiveContains(search) }
        }
        // Keep the catalog's order, so picking a model never reshuffles the short list.
        let ranked = modelChoices.enumerated().sorted { left, right in
            let rank = { (route: String) -> Int in
                let parts = route.split(separator: "/", maxSplits: 1).map(String.init)
                let names = Self.modelNamesByProvider[ProviderAuthenticationDefinition.canonicalID(parts.first ?? "")] ?? []
                return names.firstIndex(of: parts.last ?? "") ?? Int.max
            }
            let (l, r) = (rank(left.element), rank(right.element))
            return l == r ? left.offset < right.offset : l < r
        }.map(\.element)
        var choices = Array(ranked.prefix(5))
        if !selectedModel.isEmpty && !choices.contains(where: { Self.sameModel($0, selectedModel) }) { choices.append(selectedModel) }
        return choices
    }

    private var defaultRouteModel: String? {
        let canonicalProvider = ProviderAuthenticationDefinition.canonicalID(selectedProvider)
        // ChatGPT's default is the newest model, as in AppModel.preferredModel.
        let preferred = (canonicalProvider == "openai" ? Self.modelNamesByProvider["openai"]?.first : nil)
            ?? model.authenticationProviderDefinitions.first {
                ProviderAuthenticationDefinition.canonicalID($0.id) == canonicalProvider
            }?.defaultModel
        return preferred.flatMap { name in routes.first { Self.sameModel($0, "\(selectedProvider)/\(name)") } } ?? routes.first
    }

    private var modelsMenu: some View {
        VStack(spacing: 2) {
            if !canEdit {
                Label("Only the agent owner can change this model route.", systemImage: "lock")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if selectedAccountIsUnavailable {
                Button("Account unavailable") { page = .accounts }
                    .font(.footnote).foregroundStyle(.orange)
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
            ForEach(visibleModels, id: \.self) { value in
                pickerRow(modelLabel(value), selected: Self.sameModel(value, selectedModel)) { chooseModel(value) }
                    .disabled(!canEdit)
                    .accessibilityIdentifier("agent-model-option-\(value)")
            }
            if visibleModels.isEmpty { Text("No models found").font(.footnote).foregroundStyle(.secondary) }
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
                    Button("Enter another model ID") { showsManualModel = true }.font(.footnote)
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
            .font(.subheadline).padding(.horizontal, 12).frame(minHeight: 44).disabled(!canEdit)
            ForEach(accountChoices, id: \.self) { choice in
                pickerRow(accountLabel(choice), selected: choice == selectedAuthChoice) { chooseAccount(choice) }
                    .disabled(!canEdit || account(for: choice) == nil)
            }
            if !accountChoices.contains(where: { account(for: $0) != nil }) {
                Text("No signed-in account. Connect one in Settings → Authentication.")
                    .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 12)
            }

        }
    }

    private func pickerRow(_ title: String, detail: String? = nil, selected: Bool = false,
                           chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline).foregroundStyle(.primary)
                    if let detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 4)
                if selected { Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(chatTheme.accent) }
                if chevron { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 44).contentShape(Rectangle())
            .background(selected ? chatTheme.accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func chooseModel(_ value: String) {
        let provider = value.split(separator: "/", maxSplits: 1).first.map(String.init) ?? selectedProvider
        let changesProvider = ProviderAuthenticationDefinition.canonicalID(provider) != ProviderAuthenticationDefinition.canonicalID(selectedProvider)
        selectedModel = value
        selectedThinking = Self.normalizedThinking(selectedThinking, for: value, catalog: model.ompProviderCatalog)
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
        selectedThinking = Self.normalizedThinking(selectedThinking, for: selectedModel, catalog: model.ompProviderCatalog)
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
        // The pinned catalog may not list the newest ChatGPT model yet, and its
        // internal daybreak models are never offered.
        let listed = Self.modelNamesByProvider[canonicalProvider] ?? []
        let preferred = listed.filter {
            catalogModels.contains($0) || (canonicalProvider == "openai" && !catalogModels.isEmpty && $0 == listed.first)
        }
        let ordered = (preferred + catalogModels.filter { !preferred.contains($0) })
            .filter { !$0.localizedCaseInsensitiveContains("daybreak") }
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
        return Self.uniqueModels([savedModel, manualModel, current].compactMap { $0 } + suggested)
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
            : Self.normalizedThinking(routing.thinking?.nonEmpty ?? "medium", for: selectedModel, catalog: model.ompProviderCatalog)
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
            model: selectedModel, effort: Self.normalizedThinking(selectedThinking, for: selectedModel, catalog: model.ompProviderCatalog)), dismissAfter: dismissAfter)
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

    /// The composer drops the GPT- prefix so the name and effort fit beside Send.
    static func shortName(_ value: String) -> String {
        let display = name(value)
        return display.hasPrefix("GPT-") ? String(display.dropFirst(4)) : display
    }

    static func effort(_ value: String) -> String {
        if value.isEmpty || ["default", "auto", "thinking"].contains(value) { return "Default" }
        return value == "xhigh" ? "Extra high" : value.capitalized
    }
}

private struct AgentEffortSlider: View {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var value: String
    let levels: [String]
    let accent: Color
    let onCommit: () -> Void
    /// While dragging, the thumb follows the finger; on release it settles on the level.
    @State private var dragFraction: Double?
    private var index: Int { levels.firstIndex(of: value) ?? 0 }

    private let trackHeight: CGFloat = 56
    private let thumbDiameter: CGFloat = 44

    var body: some View {
        GeometryReader { geometry in
            let inset = (trackHeight - thumbDiameter) / 2
            let start = inset + thumbDiameter / 2
            let travel = max(0, geometry.size.width - start * 2)
            let fraction = dragFraction ?? Double(index) / Double(max(1, levels.count - 1))
            let thumbCenter = start + travel * fraction
            ZStack(alignment: .leading) {
                Capsule().fill(Color(uiColor: .tertiarySystemFill))
                // The fill ends at the thumb centre, so at the lowest level it hides under the thumb.
                UnevenRoundedRectangle(topLeadingRadius: thumbDiameter / 2, bottomLeadingRadius: thumbDiameter / 2)
                    .fill(accent)
                    .frame(width: thumbDiameter / 2 + travel * fraction, height: thumbDiameter)
                    .offset(x: inset)
                    .opacity(levels.contains(value) ? 1 : 0)
                ForEach(Array(levels.enumerated()), id: \.element) { offset, _ in
                    if offset != index {
                        Circle().fill(offset < index ? Color.white.opacity(0.55) : Color.secondary.opacity(0.4))
                            .frame(width: 8, height: 8)
                            .offset(x: start + travel * Double(offset) / Double(max(1, levels.count - 1)) - 4)
                    }
                }
                Circle().fill(Color.white).shadow(color: .black.opacity(0.2), radius: 5, y: 3)
                    .frame(width: thumbDiameter, height: thumbDiameter)
                    .offset(x: thumbCenter - thumbDiameter / 2)
            }
            // Taps and VoiceOver steps glide to the level; a drag tracks the finger directly.
            .animation(reduceMotion || dragFraction != nil ? nil : .easeOut(duration: 0.16), value: value)
            .frame(height: trackHeight).contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                guard isEnabled, levels.count > 1, travel > 0 else { return }
                let position = min(max(0, (gesture.location.x - start) / travel), 1)
                // A tap glides to its level; once the finger moves, the thumb tracks it.
                if dragFraction != nil || abs(gesture.translation.width) > 4 {
                    var transaction = Transaction(animation: nil)
                    transaction.disablesAnimations = true
                    withTransaction(transaction) { dragFraction = position }
                }
                value = levels[Int((position * Double(levels.count - 1)).rounded())]
            }.onEnded { _ in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { dragFraction = nil }
                if isEnabled { onCommit() }
            })
        }
        .frame(height: trackHeight)
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

/// Full-screen picker layer, hosted in a window overlay so it also covers the navigation header.
struct AgentModelPickerOverlay: View {
    let conversation: ConversationSummary
    @Binding var page: AgentModelPickerPage
    /// How far the composer field's top sits above the composer's bottom edge.
    let fieldOffset: CGFloat
    let onDismiss: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    var body: some View {
        // The window host reports no safe area, so read the home-indicator inset from
        // the window. The keyboard is resigned while the picker is open and never moves the panels.
        let bottomInset = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets.bottom }.first ?? 0
        GeometryReader { _ in
            GeometryReader { proxy in
                let height = proxy.size.height
                ZStack {
                    Rectangle().fill(.ultraThinMaterial)
                        .overlay(Color.black.opacity(colorScheme == .dark ? 0.18 : 0.10))
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onDismiss)
                        .accessibilityElement()
                        .accessibilityLabel("Dismiss")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction(.default, onDismiss)
                        .accessibilityIdentifier("agent-model-backdrop")
                    let picker = AgentModelPicker(
                        conversation: conversation,
                        onDismiss: onDismiss,
                        page: $page,
                        maxHeight: page == .effort ? .infinity : height * 0.6
                    )
                    Group {
                        if page == .effort {
                            // The effort panel's bottom sits 24 points above the field.
                            VStack(spacing: 0) {
                                Spacer(minLength: 100)
                                picker
                                Color.clear.frame(height: bottomInset + fieldOffset + 24)
                            }
                        } else {
                            picker.frame(maxHeight: .infinity)
                        }
                    }
                    .scaleEffect(isVisible ? 1 : 0.96, anchor: page == .effort ? .bottom : .center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .ignoresSafeArea()
        }
        .ignoresSafeArea(.keyboard)
        .opacity(isVisible ? 1 : 0)
        .accessibilityAction(.escape, onDismiss)
        .onAppear {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { isVisible = true }
        }
    }
}
