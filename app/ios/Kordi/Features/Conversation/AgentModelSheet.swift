import SwiftUI

struct AgentModelSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary
    @State private var selectedProvider = ""
    @State private var selectedModel = ""
    @State private var selectedThinking = "medium"
    @State private var isSaving = false

    private let modelNamesByProvider = [
        "openai": [
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex-spark",
        ],
        "anthropic": [
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
    private let thinkingLevels = ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]

    private var routing: CloudModelRouting { model.runtimeRouting(for: conversation) }
    private var canEdit: Bool { model.canChangeRuntimeRouting(for: conversation) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    AgentModelMenuRow(
                        title: "Provider",
                        options: providers,
                        selection: $selectedProvider,
                        isEnabled: canEdit && !providers.isEmpty,
                        optionLabel: providerLabel
                    )

                    AgentModelMenuRow(
                        title: "Model",
                        options: routes,
                        selection: $selectedModel,
                        optionLabel: modelLabel
                    )

                    AgentModelMenuRow(
                        title: "Thinking level",
                        options: thinkingLevels,
                        selection: $selectedThinking,
                        optionLabel: thinkingLabel
                    )
                }

                if !canEdit {
                    Section {
                        Label("Only the agent owner can change this model route.", systemImage: "lock")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 12) {
                    Spacer()
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)
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
                    .disabled(!canEdit || isSaving || selectedModel.isEmpty)
                }
                .controlSize(.large)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(16)
            .contentMargins(.top, 12, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Agent model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Close agent model")
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .onAppear { loadSelection() }
        .onChange(of: selectedProvider) { _, provider in
            selectCompatibleModel(for: provider)
        }
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
        let available = model.providerAuthSnapshots.keys.sorted { left, right in
            let leftCreatedAt = model.providerAuthSnapshots[left]?.createdAt ?? ""
            let rightCreatedAt = model.providerAuthSnapshots[right]?.createdAt ?? ""
            if leftCreatedAt == rightCreatedAt { return left < right }
            return leftCreatedAt > rightCreatedAt
        }
        guard let routeProvider = routing.defaultAuthProvider?.nonEmpty.map(
            ProviderAuthenticationDefinition.canonicalID
        ), let index = available.firstIndex(of: routeProvider) else {
            return available
        }
        return [available[index]] + available.enumerated().compactMap {
            $0.offset == index ? nil : $0.element
        }
    }

    private var routes: [String] {
        let provider = selectedProvider.nonEmpty
            ?? routing.defaultAuthProvider?.nonEmpty
            ?? providers.first
        let canonicalProvider = provider.map(ProviderAuthenticationDefinition.canonicalID)
        let names = canonicalProvider.flatMap { modelNamesByProvider[$0] }
            ?? ProviderAuthenticationDefinition.all
                .first(where: { $0.id == canonicalProvider })?
                .defaultModel.map { [$0] }
            ?? []
        let suggested = names.map { name in
            provider.map { "\($0)/\(name)" } ?? name
        }
        let current = routing.defaultModel?.nonEmpty.flatMap { currentModel in
            guard let provider else { return currentModel }
            let currentProvider = currentModel.split(separator: "/", maxSplits: 1)
                .first.map(String.init)
            return ProviderAuthenticationDefinition.canonicalID(currentProvider ?? "")
                == ProviderAuthenticationDefinition.canonicalID(provider)
                ? currentModel
                : nil
        }
        return ([current].compactMap { $0 } + suggested)
            .reduce(into: []) { options, option in
                if !options.contains(option) { options.append(option) }
            }
    }

    private func providerLabel(_ providerID: String) -> String {
        let canonicalID = ProviderAuthenticationDefinition.canonicalID(providerID)
        let provider = ProviderAuthenticationDefinition.all
            .first(where: { $0.id == canonicalID })?
            .name
            ?? providerID.replacingOccurrences(of: "_", with: " ").capitalized
        let routeChoice = ProviderAuthenticationDefinition.canonicalID(
            routing.defaultAuthProvider ?? ""
        ) == canonicalID ? routing.defaultAuthChoice?.nonEmpty : nil
        let choice = routeChoice
            ?? model.authenticationSnapshot(for: providerID)?.authChoice.nonEmpty
        if let choice {
            let choice = choice.replacingOccurrences(of: "_", with: " ")
            return "\(provider) · \(choice)"
        }
        return provider
    }

    private func loadSelection() {
        let routeProvider = routing.defaultAuthProvider?.nonEmpty.map(
            ProviderAuthenticationDefinition.canonicalID
        )
        selectedProvider = routeProvider.flatMap { providers.contains($0) ? $0 : nil }
            ?? providers.first
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
        selectedThinking = routing.thinking?.nonEmpty ?? "medium"
    }

    private func selectCompatibleModel(for provider: String) {
        guard let provider = provider.nonEmpty else { return }
        let currentProvider = selectedModel.split(separator: "/", maxSplits: 1)
            .first.map(String.init)
        guard ProviderAuthenticationDefinition.canonicalID(currentProvider ?? "")
            != ProviderAuthenticationDefinition.canonicalID(provider) else { return }
        selectedModel = routes.first ?? ""
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            let saved = await model.updateRuntimeRouting(
                for: conversation,
                provider: selectedProvider,
                model: selectedModel,
                thinking: selectedThinking
            )
            isSaving = false
            if saved { dismiss() }
        }
    }

    private func modelLabel(_ value: String) -> String {
        guard let separator = value.firstIndex(of: "/") else { return value }
        return String(value[value.index(after: separator)...])
    }

    private func thinkingLabel(_ value: String) -> String {
        value == "xhigh" ? "Extra High" : value.capitalized
    }
}

private struct AgentModelMenuRow: View {
    let title: String
    let options: [String]
    @Binding var selection: String
    var isEnabled = true
    var optionLabel: (String) -> String = { $0 }

    private var selectedLabel: String {
        optionLabel(selection.nonEmpty ?? options.first ?? "")
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .lineLimit(1)
                .layoutPriority(1)

            Menu {
                ForEach(options, id: \.self) { option in
                    Button {
                        selection = option
                    } label: {
                        if selection == option {
                            Label(optionLabel(option), systemImage: "checkmark")
                        } else {
                            Text(optionLabel(option))
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Text(selectedLabel)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(.primary)

                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(KordiTheme.signalBlue)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .contentShape(Rectangle())
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .buttonStyle(.plain)
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(selectedLabel)
        }
    }
}
