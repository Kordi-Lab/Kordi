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

    private var routing: CloudModelRouting { model.runtimeRouting(for: conversation) }
    private var canEdit: Bool { model.canChangeRuntimeRouting(for: conversation) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    AgentModelMenuRow(
                        title: "Provider",
                        options: [providerSummary],
                        selection: $selectedProvider,
                        isEnabled: model.providerAuthSnapshot != nil
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
