import SwiftUI

struct AgentModelSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary
    @State private var selectedProvider = ""
    @State private var selectedModel = ""
    @State private var selectedThinking = "medium"
    @State private var isSaving = false

    private let modelNames = [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4-mini",
        "gpt-5.4",
        "gpt-5.3-codex-spark",
    ]
    private let thinkingLevels = ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]

    private var agent: CloudAgent? { model.ownedAgent(for: conversation) }
    private var routing: CloudModelRouting { model.runtimeRouting(for: conversation) }
    private var canEdit: Bool { model.canChangeRuntimeRouting(for: conversation) }
    private var isSessionScoped: Bool { model.runtimeRoutingIsSessionScoped(for: conversation) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Provider", selection: $selectedProvider) {
                        Text(providerSummary).tag(providerSummary)
                    }
                    .disabled(model.providerAuthSnapshot == nil)

                    Picker("Model", selection: $selectedModel) {
                        ForEach(routes, id: \.self) { route in
                            Text(modelLabel(route)).tag(route)
                        }
                    }

                    Picker("Thinking level", selection: $selectedThinking) {
                        ForEach(thinkingLevels, id: \.self) { level in
                            Text(thinkingLabel(level)).tag(level)
                        }
                    }
                }

                Section {
                    if !canEdit {
                        Label("Only the agent owner can change this model route.", systemImage: "lock")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if isSessionScoped {
                        Label(
                            "This route belongs to this session. Agent work still runs in Kordi Cloud or on an available Mac—not on this iPhone.",
                            systemImage: "rectangle.connected.to.line.below"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    } else {
                        Label(
                            "This route belongs to \(agent?.name ?? "this agent") and follows it across sessions.",
                            systemImage: "sparkles"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
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
            .safeAreaInset(edge: .bottom, spacing: 0) {
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
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.bar)
            }
        }
        .interactiveDismissDisabled(isSaving)
        .onAppear { loadSelection() }
    }

    private var routes: [String] {
        let provider = model.providerAuthSnapshot?.provider.nonEmpty
        let suggested = modelNames.map { name in
            provider.map { "\($0)/\(name)" } ?? name
        }
        return ([routing.defaultModel].compactMap { $0?.nonEmpty } + suggested)
            .reduce(into: []) { options, option in
                if !options.contains(option) { options.append(option) }
            }
    }

    private var providerSummary: String {
        if let snapshot = model.providerAuthSnapshot {
            let provider = snapshot.provider.replacingOccurrences(of: "_", with: " ").capitalized
            let choice = snapshot.authChoice.replacingOccurrences(of: "_", with: " ")
            let suffix = String(snapshot.snapshotId.suffix(6))
            return "\(provider) · \(choice) · \(suffix)"
        }
        if let provider = routing.defaultAuthProvider?.nonEmpty {
            return provider.capitalized
        }
        return "Not connected"
    }

    private func loadSelection() {
        selectedProvider = providerSummary
        selectedModel = routing.defaultModel?.nonEmpty ?? routes.first ?? "gpt-5.6-sol"
        selectedThinking = routing.thinking?.nonEmpty ?? "medium"
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            let saved = await model.updateRuntimeRouting(
                for: conversation,
                model: selectedModel,
                thinking: selectedThinking
            )
            isSaving = false
            if saved { dismiss() }
        }
    }

    private func modelLabel(_ value: String) -> String {
        value.split(separator: "/").last.map(String.init) ?? value
    }

    private func thinkingLabel(_ value: String) -> String {
        value == "xhigh" ? "Extra High" : value.capitalized
    }
}
