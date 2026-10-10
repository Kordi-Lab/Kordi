import SwiftUI

/// A conversation's Memory tab: the memories Kordi saved for this conversation
/// or its group, matched with the same scope id rules as the desktop tab.
struct SessionMemoryPage: View {
    let conversation: ConversationSummary
    @StateObject private var model: MemorySettingsModel

    init(conversation: ConversationSummary, account: CloudAccount?, service: @autoclosure @escaping () -> any MemoryService) {
        self.conversation = conversation
        let accountLabel = MemoryPresentation.accountLabel(email: account?.primaryEmail, kordiId: account?.kordiId)
        _model = StateObject(wrappedValue: MemorySettingsModel(service: service(), accountLabel: accountLabel))
    }

    private var memories: [CloudMemory] {
        model.memories(for: MemoryPresentation.conversationScopes(for: conversation))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.vertical, 6)
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
                        .disabled(model.isLoading)
                }
            } else {
                if model.accountLabel != nil {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        if let caption = model.syncCaption(now: context.date) {
                            SettingsCaption(caption)
                        }
                    }
                }
                if memories.isEmpty {
                    SettingsCaption("No memories yet.")
                } else {
                    MemoryRowsView(model: model, memories: memories)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .task { await model.load() }
        .accessibilityIdentifier("session-memory-page")
    }
}

extension SessionDetailTab {
    /// Tabs on a conversation's info page. Every conversation gets a Memory tab
    /// when the server advertises memory support: after Members in a group,
    /// last otherwise.
    static func tabs(for kind: ConversationKind, memoryAvailable: Bool) -> [SessionDetailTab] {
        let memory: [SessionDetailTab] = memoryAvailable ? [.memory] : []
        switch kind {
        case .group: return [.members] + memory + [.media, .files, .todo]
        case .person: return [.media, .files, .todo, .groups] + memory
        case .agent: return [.media, .files, .todo] + memory
        }
    }

    static func tabs(for kind: ConversationKind, capabilities: CloudAuthCapabilities?) -> [SessionDetailTab] {
        tabs(for: kind, memoryAvailable: MemoryPresentation.isAvailable(capabilities))
    }
}
