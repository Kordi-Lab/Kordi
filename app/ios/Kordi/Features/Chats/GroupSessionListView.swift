import SwiftUI

/// Contacts opens the group first, so every channel remains reachable.
struct GroupSessionListView: View {
    @EnvironmentObject private var model: AppModel
    let space: GroupSpaceSummary
    var onOpenConversation: ((ConversationSummary) -> Void)? = nil

    private var currentSpace: GroupSpaceSummary {
        GroupSpaceCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? "",
            pinnedSessionIds: model.pinnedSessionIds
        ).first { $0.id == space.id } ?? space
    }

    var body: some View {
        let group = currentSpace
        List {
            Section {
                ForEach(group.sessions) { session in
                    Group {
                        if let onOpenConversation {
                            Button { onOpenConversation(session) } label: { row(session) }
                                .buttonStyle(.plain)
                        } else {
                            NavigationLink(value: session) { row(session) }
                        }
                    }
                    .kordiListRow()
                    .accessibilityIdentifier("group-channel-\(session.sessionId)")
                }
            } header: {
                Text(group.sessions.count == 1 ? "1 channel" : "\(group.sessions.count) channels")
            }
        }
        .listStyle(.plain)
        .navigationTitle(group.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refreshWorkspace() }
        .navigationDestination(for: ConversationSummary.self) { conversation in
            ConversationView(conversation: conversation)
                .task { _ = await model.restoreConversationIfNeeded(conversation) }
        }
    }

    private func row(_ session: ConversationSummary) -> some View {
        GroupSessionRow(
            session: session,
            isPinned: model.pinnedSessionIds.contains(session.sessionId),
            isMuted: model.mutedSessionIds.contains(session.sessionId)
        )
    }
}
