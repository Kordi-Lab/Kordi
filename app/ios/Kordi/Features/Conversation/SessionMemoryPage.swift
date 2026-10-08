import SwiftUI

/// The Memory tab on a group's info page: the memories Kordi saved in this group.
struct SessionMemoryPage: View {
    let conversation: ConversationSummary
    @StateObject private var model: MemorySettingsModel

    init(conversation: ConversationSummary, service: @autoclosure @escaping () -> any MemoryService) {
        self.conversation = conversation
        _model = StateObject(wrappedValue: MemorySettingsModel(service: service(), accountLabel: nil))
    }

    private var memories: [CloudMemory] {
        model.memories(forGroup: MemoryPresentation.groupMemoryScopeIds(for: conversation))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What Kordi remembers in this group. Only you can see your own memories.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)

            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 4)
            }

            if !model.hasLoaded {
                if model.errorMessage == nil {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading memory…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .accessibilityElement(children: .combine)
                } else {
                    Button("Try again") { Task { await model.load() } }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 32)
                        .padding(.horizontal, 4)
                        .disabled(model.isLoading)
                }
            } else if memories.isEmpty {
                SessionDetailEmptyState(
                    title: "No memories yet",
                    symbol: "brain",
                    description: "Memories Kordi saves in this group will appear here."
                )
            } else {
                MemoryRowsView(model: model, memories: memories, separated: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
                    .background(
                        Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                    )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await model.load() }
        .accessibilityIdentifier("session-memory-page")
    }
}
