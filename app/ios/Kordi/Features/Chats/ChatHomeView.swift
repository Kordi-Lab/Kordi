import SwiftUI

enum ChatChannel: Hashable {
    case contact
    case agent
}

struct ArchivedChatsRoute: Hashable {
    let channel: ChatChannel
}

struct ChatHomeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let channel: ChatChannel
    @State private var searchText = ""
    @State private var newChatMode: NewChatMode?
    @State private var composedConversation: ConversationSummary?
    @State private var expandedGroupSpaceIds = Set<String>()
    @State private var collapsedAgentForkParentIds = Set<String>()
    @State private var renameTarget: ConversationSummary?
    @State private var renameDraft = ""
    @State private var deleteTarget: ConversationSummary?
    @State private var showingArchivedChats = false
    @State private var groupManagementPresentation: GroupManagementPresentation?
    @State private var pullRefreshState: ChatPullRefreshVisualState = .idle
    private let onOpenConversation: ((ConversationSummary) -> Void)?
    private let onOpenNewChat: ((NewChatMode) -> Void)?
    private let onOpenArchivedChats: (() -> Void)?

    init(
        channel: ChatChannel,
        onOpenConversation: ((ConversationSummary) -> Void)? = nil,
        onOpenNewChat: ((NewChatMode) -> Void)? = nil,
        onOpenArchivedChats: (() -> Void)? = nil
    ) {
        self.channel = channel
        _newChatMode = State(initialValue: NewChatMode.previewMode(arguments: ProcessInfo.processInfo.arguments))
        self.onOpenConversation = onOpenConversation
        self.onOpenNewChat = onOpenNewChat
        self.onOpenArchivedChats = onOpenArchivedChats
    }

    private var searchQuery: String {
        ChatHomeSearch.normalized(searchText)
    }

    private var pinLayoutIdentity: [String] {
        (model.pinnedSessionIds.map { "session:\($0)" }
            + model.pinnedGroupSpaceIds.map { "group:\($0)" }
        ).sorted()
    }

    private var agentSessions: [AgentSessionListItem] {
        AgentSessionTimelineCatalog.build(
            conversations: model.conversations,
            searchText: searchQuery,
            collapsedForkParentIds: collapsedAgentForkParentIds,
            pinnedSessionIds: model.pinnedSessionIds
        )
    }

    private var groupSpaces: [GroupSpaceSummary] {
        let spaces = GroupSpaceCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? "",
            pinnedSessionIds: model.pinnedSessionIds
        )
        guard !searchQuery.isEmpty else { return spaces }
        return spaces.filter { space in
            ChatHomeSearch.matches(space, query: searchQuery)
        }
    }

    private var contactItems: [ContactListItem] {
        let contactsByAccountID = Dictionary(
            uniqueKeysWithValues: model.contacts.map { ($0.accountId, $0) }
        )
        let people: [ContactListItem] = ProcessInfo.processInfo.arguments.contains("--preview-group-only")
            ? []
            : model.conversations
                .filter { conversation in
                    guard conversation.kind == .person else { return false }
                    guard !searchQuery.isEmpty else { return true }
                    let contact = contactsByAccountID[conversation.peerAccountId]
                    return ChatHomeSearch.matches(
                        conversation,
                        contact: contact,
                        query: searchQuery
                    )
                }
                .map(ContactListItem.conversation)
        return (people + groupSpaces.map(ContactListItem.group))
            .sorted {
                let leftPinned = $0.isPinned(
                    sessionIds: model.pinnedSessionIds,
                    groupSpaceIds: model.pinnedGroupSpaceIds
                )
                let rightPinned = $1.isPinned(
                    sessionIds: model.pinnedSessionIds,
                    groupSpaceIds: model.pinnedGroupSpaceIds
                )
                if leftPinned != rightPinned { return leftPinned }
                return ChatListOrdering.precedes(
                    id: $0.id,
                    displayName: $0.displayName,
                    lastActivityAt: $0.lastActivityAt,
                    before: $1.id,
                    displayName: $1.displayName,
                    lastActivityAt: $1.lastActivityAt
                )
            }
    }

    private var archivedForChannelCount: Int {
        if channel == .agent {
            return model.archivedConversations.count { $0.kind == .agent }
        }
        let people = model.archivedConversations.count { $0.kind == .person }
        let groups = GroupSpaceCatalog.build(
            conversations: model.archivedConversations,
            ownAccountId: model.account?.accountId ?? ""
        ).count
        return people + groups
    }

    private var contactRows: [ContactListRow] {
        contactItems.flatMap { item -> [ContactListRow] in
            switch item {
            case let .conversation(conversation):
                return [.conversation(conversation)]
            case let .group(space):
                return [.group(space)] + (groupIsExpanded(space)
                    ? space.sessions.map { .groupSession($0) }
                    : [])
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            chatPageHeader

            if channel == .contact {
                contactPage
            } else {
                agentPage
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let previewNewChatMode = newChatMode {
                newChatMode = nil
                if let onOpenNewChat {
                    onOpenNewChat(previewNewChatMode)
                } else {
                    Task { @MainActor in
                        await Task.yield()
                        newChatMode = previewNewChatMode
                    }
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-group-management"),
               groupManagementPresentation == nil,
               let space = groupSpaces.first {
                groupManagementPresentation = GroupManagementPresentation(
                    space: space,
                    startsInInviteMode: ProcessInfo.processInfo.arguments.contains("--preview-group-invite")
                )
            }
        }
        .navigationDestination(for: ConversationSummary.self) { selected in
            ConversationView(conversation: selected)
        }
        .navigationDestination(for: KordiMessageNotificationRoute.self) { route in
            ConversationView(
                conversation: route.conversation,
                initialMessageID: route.messageID
            )
        }
        .navigationDestination(item: $composedConversation) { selected in
            ConversationView(conversation: selected)
        }
        .navigationDestination(isPresented: $showingArchivedChats) {
            ArchivedChatsView(channel: channel)
        }
        .navigationDestination(for: ArchivedChatsRoute.self) { route in
            ArchivedChatsView(
                channel: route.channel,
                onOpenConversation: onOpenConversation
            )
        }
        .toolbar {
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .principal) {
                    MessageSyncStatusView(pullState: pullRefreshState)
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .principal) {
                    MessageSyncStatusView(pullState: pullRefreshState)
                }
            }
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarTrailing) {
                    newChatButton
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    newChatButton
                }
            }
        }
        .navigationDestination(item: $newChatMode) { mode in
            newChatDestination(for: mode)
        }
        .navigationDestination(for: NewChatMode.self) { mode in
            newChatDestination(for: mode)
        }
        .sheet(item: $groupManagementPresentation) { presentation in
            GroupManagementSheet(presentation: presentation)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .alert("Rename session", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField("Session name", text: $renameDraft)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") {
                guard let target = renameTarget else { return }
                renameTarget = nil
                Task { _ = await model.renameConversation(target, to: renameDraft) }
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("This name is used for the session, matching Kordi on macOS.")
        }
        .alert(
            "Delete this chat from your list?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button("Delete chat", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { _ = await model.deleteConversation(target) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("This does not delete it for other participants. It will return only when a new visible message arrives.")
        }
        .overlay(alignment: .bottom) {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
                    .padding()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }

    private var newChatButton: some View {
        Menu {
            ForEach(NewChatMode.allCases) { mode in
                Button {
                    if let onOpenNewChat {
                        onOpenNewChat(mode)
                    } else {
                        newChatMode = mode
                    }
                } label: {
                    Label(mode.menuTitle, systemImage: mode.systemImage)
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .contentShape(Rectangle())
        .accessibilityLabel("Start a chat")
    }

    private func newChatDestination(for mode: NewChatMode) -> some View {
        NewChatView(mode: mode) { selected in
            openConversation(selected)
        }
    }

    private var chatPageHeader: some View {
        KordiPageSearchHeader(
            text: $searchText,
            prompt: channel == .contact ? "Search chats" : "Search agent sessions",
            accessibilityLabel: channel == .contact
                ? "Search contact and group chats"
                : "Search agents, sessions, owners, and messages"
        ) { EmptyView() }
    }

    @ViewBuilder
    private var archivedChatsEntry: some View {
        if archivedForChannelCount > 0 {
            Button {
                if let onOpenArchivedChats {
                    onOpenArchivedChats()
                } else {
                    showingArchivedChats = true
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "archivebox")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                    Text("Archived Chats")
                        .font(.headline)
                    Spacer()
                    Text(archivedForChannelCount, format: .number)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows archived chats")
            .chatHomeRow(separatorLeading: 71)
        }
    }

    private var contactPage: some View {
        ChatPullToRefreshScrollView(
            coordinateSpaceName: "contact-chat-refresh",
            visualState: $pullRefreshState,
            onRefresh: { await model.refreshWorkspace() }
        ) {
            archivedChatsEntry
            if contactItems.isEmpty {
                ContentUnavailableView(
                    searchQuery.isEmpty ? "No contact conversations yet" : "No chats found",
                    systemImage: searchQuery.isEmpty ? "person.2" : "magnifyingglass",
                    description: Text(searchQuery.isEmpty ? "Start a chat with a contact to see it here." : "Try another name, Kordi ID, or message.")
                )
                .frame(maxWidth: .infinity, minHeight: 360)
            } else {
                ForEach(contactRows) { row in
                    contactRow(row)
                }
            }
        }
        .id(pinLayoutIdentity)
        .accessibilityLabel("Contact chats")
    }

    @ViewBuilder
    private func contactRow(_ row: ContactListRow) -> some View {
        switch row {
        case let .conversation(conversation):
            destination(for: conversation)
        case let .group(space):
            let isExpanded = groupIsExpanded(space)
            Button {
                toggleGroupSpace(space)
            } label: {
                GroupSpaceRow(
                    space: space,
                    isExpanded: isExpanded,
                    mutedSessionIds: model.mutedSessionIds,
                    isPinned: groupIsPinned(space),
                    isMuted: groupIsMuted(space)
                )
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button {
                    groupManagementPresentation = GroupManagementPresentation(
                        space: space,
                        startsInInviteMode: false
                    )
                } label: {
                    Label("Manage group", systemImage: "person.2")
                }
                Button {
                    groupManagementPresentation = GroupManagementPresentation(
                        space: space,
                        startsInInviteMode: true
                    )
                } label: {
                    Label("Invite people", systemImage: "person.badge.plus")
                }
                Button {
                    Task { await model.markGroupSpaceRead(space) }
                } label: {
                    Label("Mark as read", systemImage: "checkmark.circle")
                }
                Divider()
                Button {
                    toggleGroupPinned(space)
                } label: {
                    Label(
                        groupIsPinned(space) ? "Unpin group" : "Pin group",
                        systemImage: groupIsPinned(space) ? "pin.slash" : "pin"
                    )
                }
                Button {
                    toggleGroupMuted(space)
                } label: {
                    Label(
                        groupIsMuted(space) ? "Unmute group" : "Mute group",
                        systemImage: groupIsMuted(space) ? "bell" : "bell.slash"
                    )
                }
                Button {
                    Task { _ = await model.archiveGroupSpace(space) }
                } label: {
                    Label("Archive group", systemImage: "archivebox")
                }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                groupLeadingSwipeActions(for: space)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                groupTrailingSwipeActions(for: space)
            }
            .accessibilityAction(named: groupIsPinned(space) ? "Unpin group" : "Pin group") {
                toggleGroupPinned(space)
            }
            .accessibilityAction(named: "Mark group as read") {
                Task { await model.markGroupSpaceRead(space) }
            }
            .accessibilityAction(named: groupIsMuted(space) ? "Unmute group" : "Mute group") {
                toggleGroupMuted(space)
            }
            .accessibilityAction(named: "Archive group") {
                Task { _ = await model.archiveGroupSpace(space) }
            }
            .accessibilityHint("Double-tap to show sessions. Touch and hold to manage or invite people.")
            .chatHomeRow(separatorLeading: 71)
        case let .groupSession(session):
            sessionActionRow(for: session) {
                GroupSessionRow(
                    session: session,
                    isPinned: model.pinnedSessionIds.contains(session.sessionId),
                    isMuted: model.mutedSessionIds.contains(session.sessionId)
                )
            }
        }
    }

    private var agentPage: some View {
        ChatPullToRefreshScrollView(
            coordinateSpaceName: "agent-chat-refresh",
            visualState: $pullRefreshState,
            onRefresh: { await model.refreshWorkspace() }
        ) {
            archivedChatsEntry
            if agentSessions.isEmpty {
                ContentUnavailableView(
                    searchQuery.isEmpty ? "No agent sessions yet" : "No chats found",
                    systemImage: searchQuery.isEmpty ? "sparkles" : "magnifyingglass",
                    description: Text(searchQuery.isEmpty ? "Use + to start a session with an available agent." : "Try another agent, session, owner, or message.")
                )
                .frame(maxWidth: .infinity, minHeight: 360)
            } else {
                ForEach(agentSessions) { item in
                    agentSessionActionRow(item)
                }
            }
        }
        .id(pinLayoutIdentity)
        .accessibilityLabel("Agent chats")
    }

    private func destination(for conversation: ConversationSummary) -> some View {
        sessionActionRow(for: conversation) {
            ConversationRow(
                conversation: conversation,
                isPinned: model.pinnedSessionIds.contains(conversation.sessionId),
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        }
    }

    private func sessionActionRow<Content: View>(
        for conversation: ConversationSummary,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Button {
            openConversation(conversation)
        } label: {
            content()
        }
        .buttonStyle(.plain)
        .contextMenu {
            sessionContextMenu(for: conversation)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            sessionLeadingSwipeActions(for: conversation)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            sessionTrailingSwipeActions(for: conversation)
        }
        .accessibilityAction(named: model.pinnedSessionIds.contains(conversation.sessionId) ? "Unpin" : "Pin") {
            togglePinned(conversation)
        }
        .accessibilityAction(named: model.mutedSessionIds.contains(conversation.sessionId) ? "Unmute" : "Mute notifications") {
            toggleMuted(conversation)
        }
        .accessibilityAction(named: conversation.hasUnreadAttention ? "Mark as read" : "Mark as unread") {
            toggleUnread(conversation)
        }
        .accessibilityAction(named: "Archive") {
            Task { _ = await model.archiveConversation(conversation) }
        }
        .accessibilityAction(named: "Delete chat") {
            requestDelete(conversation)
        }
        .accessibilityHint("Double-tap to open. Swipe right to pin. Swipe left to mute, delete, or archive.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func agentSessionActionRow(_ item: AgentSessionListItem) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 0) {
                    agentSessionButton(item)
                    if item.childCount > 0 {
                        agentForkButton(item)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            } else {
                HStack(spacing: 0) {
                    agentSessionButton(item)
                    if item.childCount > 0 {
                        agentForkButton(item)
                    }
                }
            }
        }
        .contextMenu {
            sessionContextMenu(for: item.conversation)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            sessionLeadingSwipeActions(for: item.conversation)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            sessionTrailingSwipeActions(for: item.conversation)
        }
        .accessibilityAction(named: model.pinnedSessionIds.contains(item.conversation.sessionId) ? "Unpin" : "Pin") {
            togglePinned(item.conversation)
        }
        .accessibilityAction(named: model.mutedSessionIds.contains(item.conversation.sessionId) ? "Unmute" : "Mute notifications") {
            toggleMuted(item.conversation)
        }
        .accessibilityAction(named: item.conversation.hasUnreadAttention ? "Mark as read" : "Mark as unread") {
            toggleUnread(item.conversation)
        }
        .accessibilityAction(named: "Archive") {
            Task { _ = await model.archiveConversation(item.conversation) }
        }
        .accessibilityAction(named: "Delete chat") {
            requestDelete(item.conversation)
        }
        .accessibilityHint("Double-tap to open. Swipe right to pin. Swipe left to mute, delete, or archive.")
        .chatHomeRow(separatorLeading: 16)
    }

    private func agentSessionButton(_ item: AgentSessionListItem) -> some View {
        Button {
            openConversation(item.conversation)
        } label: {
            AgentSessionRow(
                conversation: item.conversation,
                isFork: item.isFork,
                isPinned: model.pinnedSessionIds.contains(item.conversation.sessionId),
                isMuted: model.mutedSessionIds.contains(item.conversation.sessionId)
            )
                .padding(.leading, CGFloat(item.depth) * 16)
        }
        .buttonStyle(.plain)
    }

    private func agentForkButton(_ item: AgentSessionListItem) -> some View {
        Button {
            toggleAgentForks(for: item.conversation)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                Text(dynamicTypeSize.isAccessibilitySize
                    ? (item.childCount == 1 ? "1 fork" : "\(item.childCount) forks")
                    : String(item.childCount))
                Image(systemName: "chevron.down")
                    .rotationEffect(.degrees(collapsedAgentForkParentIds.contains(item.conversation.sessionId) ? -90 : 0))
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 56)
            .frame(minHeight: 44)
            .padding(.horizontal, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(collapsedAgentForkParentIds.contains(item.conversation.sessionId) ? "Show forks" : "Hide forks")
    }

    @ViewBuilder
    private func sessionContextMenu(for conversation: ConversationSummary) -> some View {
        Button {
            renameDraft = conversation.displayName
            renameTarget = conversation
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button {
            toggleUnread(conversation)
        } label: {
            Label(
                conversation.hasUnreadAttention ? "Mark as read" : "Mark as unread",
                systemImage: conversation.hasUnreadAttention ? "checkmark.circle" : "envelope.badge"
            )
        }
        Divider()
        Button {
            togglePinned(conversation)
        } label: {
            Label(
                model.pinnedSessionIds.contains(conversation.sessionId) ? "Unpin" : "Pin",
                systemImage: "pin"
            )
        }
        Button {
            toggleMuted(conversation)
        } label: {
            Label(
                model.mutedSessionIds.contains(conversation.sessionId) ? "Unmute" : "Mute notifications",
                systemImage: model.mutedSessionIds.contains(conversation.sessionId) ? "bell" : "bell.slash"
            )
        }
        Button {
            Task { _ = await model.archiveConversation(conversation) }
        } label: {
            Label("Archive", systemImage: "archivebox")
        }
        Divider()
        Button(role: .destructive) {
            requestDelete(conversation)
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    @ViewBuilder
    private func sessionLeadingSwipeActions(for conversation: ConversationSummary) -> some View {
        let isPinned = model.pinnedSessionIds.contains(conversation.sessionId)
        let isUnread = conversation.hasUnreadAttention
        Button {
            togglePinned(conversation)
        } label: {
            Image(systemName: isPinned ? "pin.slash" : "pin")
        }
        .tint(.green)
        .accessibilityLabel(isPinned ? "Unpin" : "Pin")

        Button {
            toggleUnread(conversation)
        } label: {
            Image(systemName: isUnread ? "checkmark.message" : "envelope.badge")
        }
        .tint(KordiTheme.signalBlue)
        .accessibilityLabel(isUnread ? "Mark as read" : "Mark as unread")
    }

    @ViewBuilder
    private func sessionTrailingSwipeActions(for conversation: ConversationSummary) -> some View {
        let isMuted = model.mutedSessionIds.contains(conversation.sessionId)
        Button {
            toggleMuted(conversation)
        } label: {
            Image(systemName: isMuted ? "bell" : "bell.slash")
        }
        .tint(.orange)
        .accessibilityLabel(isMuted ? "Unmute" : "Mute")

        Button {
            requestDelete(conversation)
        } label: {
            Image(systemName: "trash")
        }
        .tint(.red)
        .accessibilityLabel("Delete")

        Button {
            Task { _ = await model.archiveConversation(conversation) }
        } label: {
            Image(systemName: "archivebox")
        }
        .tint(.gray)
        .accessibilityLabel("Archive")
    }

    private func togglePinned(_ conversation: ConversationSummary) {
        let pinned = !model.pinnedSessionIds.contains(conversation.sessionId)
        Task { _ = await model.setConversationPinned(conversation, pinned: pinned) }
    }

    private func toggleMuted(_ conversation: ConversationSummary) {
        let muted = !model.mutedSessionIds.contains(conversation.sessionId)
        Task { _ = await model.setConversationMuted(conversation, muted: muted) }
    }

    private func toggleUnread(_ conversation: ConversationSummary) {
        Task {
            if conversation.hasUnreadAttention {
                await model.markConversationRead(conversation)
            } else {
                _ = await model.setConversationUnread(conversation, unread: true)
            }
        }
    }

    private func requestDelete(_ conversation: ConversationSummary) {
        guard deleteTarget == nil else { return }
        deleteTarget = conversation
    }

    @ViewBuilder
    private func groupLeadingSwipeActions(for space: GroupSpaceSummary) -> some View {
        Button {
            toggleGroupPinned(space)
        } label: {
            Image(systemName: groupIsPinned(space) ? "pin.slash" : "pin")
        }
        .tint(.green)
        .accessibilityLabel(groupIsPinned(space) ? "Unpin group" : "Pin group")

        Button {
            Task { await model.markGroupSpaceRead(space) }
        } label: {
            Image(systemName: "checkmark.message")
        }
        .tint(KordiTheme.signalBlue)
        .accessibilityLabel("Mark group as read")
    }

    @ViewBuilder
    private func groupTrailingSwipeActions(for space: GroupSpaceSummary) -> some View {
        Button {
            toggleGroupMuted(space)
        } label: {
            Image(systemName: groupIsMuted(space) ? "bell" : "bell.slash")
        }
        .tint(.orange)
        .accessibilityLabel(groupIsMuted(space) ? "Unmute group" : "Mute group")

        Button {
            Task { _ = await model.archiveGroupSpace(space) }
        } label: {
            Image(systemName: "archivebox")
        }
        .tint(.gray)
        .accessibilityLabel("Archive group")
    }

    private func toggleGroupPinned(_ space: GroupSpaceSummary) {
        Task { _ = await model.setGroupSpacePinned(space, pinned: !groupIsPinned(space)) }
    }

    private func toggleGroupMuted(_ space: GroupSpaceSummary) {
        Task { _ = await model.setGroupSpaceMuted(space, muted: !groupIsMuted(space)) }
    }

    private func groupIsPinned(_ space: GroupSpaceSummary) -> Bool {
        model.pinnedGroupSpaceIds.contains(space.preferenceId)
    }

    private func groupIsMuted(_ space: GroupSpaceSummary) -> Bool {
        !space.sessions.isEmpty
            && space.sessions.allSatisfy { model.mutedSessionIds.contains($0.sessionId) }
    }

    private func groupIsExpanded(_ space: GroupSpaceSummary) -> Bool {
        ProcessInfo.processInfo.arguments.contains("--preview-expanded-groups")
            || !searchQuery.isEmpty
            || expandedGroupSpaceIds.contains(space.id)
    }

    private func toggleGroupSpace(_ space: GroupSpaceSummary) {
        let willExpand = !expandedGroupSpaceIds.contains(space.id)
        if willExpand {
            expandedGroupSpaceIds.insert(space.id)
        } else {
            expandedGroupSpaceIds.remove(space.id)
        }
    }

    private func toggleAgentForks(for conversation: ConversationSummary) {
        withAnimation(.snappy(duration: 0.22)) {
            if collapsedAgentForkParentIds.contains(conversation.sessionId) {
                collapsedAgentForkParentIds.remove(conversation.sessionId)
            } else {
                collapsedAgentForkParentIds.insert(conversation.sessionId)
            }
        }
    }

    private func openConversation(_ conversation: ConversationSummary) {
        if let onOpenConversation {
            onOpenConversation(conversation)
        } else {
            composedConversation = conversation
        }
    }

}

private struct ArchivedChatsView: View {
    @EnvironmentObject private var model: AppModel
    let channel: ChatChannel
    private let onOpenConversation: ((ConversationSummary) -> Void)?
    @State private var deleteTarget: ConversationSummary?
    @State private var selectedConversation: ConversationSummary?
    @State private var expandedGroupSpaceIds = Set<String>()

    init(
        channel: ChatChannel,
        onOpenConversation: ((ConversationSummary) -> Void)? = nil
    ) {
        self.channel = channel
        self.onOpenConversation = onOpenConversation
    }

    private var conversations: [ConversationSummary] {
        model.archivedConversations.filter {
            channel == .agent ? $0.kind == .agent : $0.kind != .agent
        }
    }

    private var groupSpaces: [GroupSpaceSummary] {
        GroupSpaceCatalog.build(
            conversations: conversations,
            ownAccountId: model.account?.accountId ?? ""
        )
    }

    private var items: [ContactListItem] {
        let individualConversations = conversations
            .filter { channel == .agent ? $0.kind == .agent : $0.kind == .person }
            .map(ContactListItem.conversation)
        let groups = channel == .agent ? [] : groupSpaces.map(ContactListItem.group)
        return (individualConversations + groups).sorted {
            ChatListOrdering.precedes(
                id: $0.id,
                displayName: $0.displayName,
                lastActivityAt: $0.lastActivityAt,
                before: $1.id,
                displayName: $1.displayName,
                lastActivityAt: $1.lastActivityAt
            )
        }
    }

    private var rows: [ContactListRow] {
        items.flatMap { item -> [ContactListRow] in
            switch item {
            case let .conversation(conversation):
                return [.conversation(conversation)]
            case let .group(space):
                return [.group(space)] + (groupIsExpanded(space)
                    ? space.sessions.map { .groupSession($0) }
                    : [])
            }
        }
    }

    var body: some View {
        List {
            ForEach(rows) { row in
                archivedRow(row)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Archived Chats")
        .navigationDestination(item: $selectedConversation) { conversation in
            ConversationView(conversation: conversation)
        }
        .overlay {
            if conversations.isEmpty {
                ContentUnavailableView(
                    "No Archived Chats",
                    systemImage: "archivebox",
                    description: Text("Chats you archive appear here.")
                )
            }
        }
        .alert(
            "Delete this chat from your list?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button("Delete chat", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { _ = await model.deleteConversation(target) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("This does not delete it for other participants. It will return only when a new visible message arrives.")
        }
    }

    @ViewBuilder
    private func archivedRow(_ row: ContactListRow) -> some View {
        switch row {
        case let .conversation(conversation), let .groupSession(conversation):
            archivedSessionActionRow(conversation)
        case let .group(space):
            archivedGroupActionRow(space)
        }
    }

    private func archivedSessionActionRow(_ conversation: ConversationSummary) -> some View {
        Button {
            if let onOpenConversation {
                onOpenConversation(conversation)
            } else {
                selectedConversation = conversation
            }
        } label: {
            archivedConversationRow(conversation)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                Task { _ = await model.restoreConversation(conversation) }
            } label: {
                Label("Restore", systemImage: "archivebox.fill")
            }
            Button {
                let muted = !model.mutedSessionIds.contains(conversation.sessionId)
                Task { _ = await model.setConversationMuted(conversation, muted: muted) }
            } label: {
                Label(
                    model.mutedSessionIds.contains(conversation.sessionId) ? "Unmute" : "Mute notifications",
                    systemImage: model.mutedSessionIds.contains(conversation.sessionId) ? "bell" : "bell.slash"
                )
            }
            Button(role: .destructive) {
                requestDelete(conversation)
            } label: {
                Label("Delete chat", systemImage: "trash")
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                requestDelete(conversation)
            } label: {
                Image(systemName: "trash")
            }
            .tint(.red)
            .accessibilityLabel("Delete")
            Button {
                Task { _ = await model.restoreConversation(conversation) }
            } label: {
                Image(systemName: "archivebox.fill")
            }
            .tint(.blue)
            .accessibilityLabel("Restore")
        }
        .accessibilityAction(named: "Restore") {
            Task { _ = await model.restoreConversation(conversation) }
        }
        .accessibilityAction(named: "Delete chat") {
            requestDelete(conversation)
        }
        .accessibilityHint("Double-tap to open this archived chat.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func archivedGroupActionRow(_ space: GroupSpaceSummary) -> some View {
        Button {
            toggleGroupSpace(space)
        } label: {
            GroupSpaceRow(
                space: space,
                isExpanded: groupIsExpanded(space),
                mutedSessionIds: model.mutedSessionIds,
                isPinned: false,
                isMuted: groupIsMuted(space)
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                Task { _ = await model.restoreGroupSpace(space) }
            } label: {
                Label("Restore group", systemImage: "archivebox.fill")
            }
            Button {
                Task { _ = await model.setGroupSpaceMuted(space, muted: !groupIsMuted(space)) }
            } label: {
                Label(
                    groupIsMuted(space) ? "Unmute group" : "Mute group",
                    systemImage: groupIsMuted(space) ? "bell" : "bell.slash"
                )
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                Task { _ = await model.restoreGroupSpace(space) }
            } label: {
                Image(systemName: "archivebox.fill")
            }
            .tint(.blue)
            .accessibilityLabel("Restore group")
        }
        .accessibilityAction(named: "Restore group") {
            Task { _ = await model.restoreGroupSpace(space) }
        }
        .accessibilityHint("Double-tap to show archived sessions.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func requestDelete(_ conversation: ConversationSummary) {
        guard deleteTarget == nil else { return }
        deleteTarget = conversation
    }

    private func groupIsMuted(_ space: GroupSpaceSummary) -> Bool {
        !space.sessions.isEmpty
            && space.sessions.allSatisfy { model.mutedSessionIds.contains($0.sessionId) }
    }

    private func groupIsExpanded(_ space: GroupSpaceSummary) -> Bool {
        expandedGroupSpaceIds.contains(space.id)
    }

    private func toggleGroupSpace(_ space: GroupSpaceSummary) {
        if groupIsExpanded(space) {
            expandedGroupSpaceIds.remove(space.id)
        } else {
            expandedGroupSpaceIds.insert(space.id)
        }
    }

    @ViewBuilder
    private func archivedConversationRow(_ conversation: ConversationSummary) -> some View {
        switch conversation.kind {
        case .person:
            ConversationRow(
                conversation: conversation,
                isPinned: false,
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        case .group:
            GroupSessionRow(
                session: conversation,
                isPinned: false,
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        case .agent:
            AgentSessionRow(
                conversation: conversation,
                isPinned: false,
                isMuted: model.mutedSessionIds.contains(conversation.sessionId)
            )
        }
    }
}

enum ChatHomeSearch {
    static func normalized(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func matches(
        _ conversation: ConversationSummary,
        contact: CloudContact? = nil,
        query: String
    ) -> Bool {
        let query = normalized(query)
        guard !query.isEmpty else { return true }
        return [
            conversation.displayName,
            conversation.lastMessage,
            conversation.ownerDisplayName,
            conversation.agentDisplayName,
            contact?.preferredName,
            contact?.kordiId
        ]
        .compactMap { $0?.nonEmpty }
        .contains { $0.localizedCaseInsensitiveContains(query) }
    }

    static func matches(_ space: GroupSpaceSummary, query: String) -> Bool {
        let query = normalized(query)
        guard !query.isEmpty else { return true }
        if space.displayName.localizedCaseInsensitiveContains(query)
            || space.lastMessage.localizedCaseInsensitiveContains(query)
            || space.participants.contains(where: {
                $0.displayName.localizedCaseInsensitiveContains(query)
            }) {
            return true
        }
        return space.sessions.contains {
            matches($0, query: query)
        }
    }
}

enum ChatPullToRefreshBehavior {
    static let triggerDistance: CGFloat = 68

    static func pullDistance(contentOffsetY: CGFloat, contentInsetTop: CGFloat) -> CGFloat {
        max(0, -(contentOffsetY + contentInsetTop))
    }

    static func shouldStart(distance: CGFloat, isRefreshing: Bool) -> Bool {
        !isRefreshing && distance >= triggerDistance
    }
}

private struct ChatPullToRefreshScrollView<Content: View>: View {
    let coordinateSpaceName: String
    let onRefresh: () async -> Void
    let content: Content
    @Binding var visualState: ChatPullRefreshVisualState
    @State private var pullDistance: CGFloat = 0
    @State private var isRefreshing = false

    init(
        coordinateSpaceName: String,
        visualState: Binding<ChatPullRefreshVisualState>,
        onRefresh: @escaping () async -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.coordinateSpaceName = coordinateSpaceName
        _visualState = visualState
        self.onRefresh = onRefresh
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 18.0, *) {
            list(includeLegacyOffsetProbe: false)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    ChatPullToRefreshBehavior.pullDistance(
                        contentOffsetY: geometry.contentOffset.y,
                        contentInsetTop: geometry.contentInsets.top
                    )
                } action: { _, distance in
                    updatePullDistance(distance)
                }
                .onScrollPhaseChange { oldPhase, newPhase in
                    guard oldPhase == .interacting, newPhase != .interacting else { return }
                    finishPullGesture()
                }
        } else {
            list(includeLegacyOffsetProbe: true)
                .coordinateSpace(.named(coordinateSpaceName))
                .onPreferenceChange(ChatPullOffsetPreferenceKey.self) { offset in
                    updatePullDistance(max(0, offset))
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 8).onEnded { _ in
                        finishPullGesture()
                    }
                )
        }
    }

    private func list(includeLegacyOffsetProbe: Bool) -> some View {
        List {
            if includeLegacyOffsetProbe {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: ChatPullOffsetPreferenceKey.self,
                        value: proxy.frame(in: .named(coordinateSpaceName)).minY
                    )
                }
                .frame(height: 0)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .accessibilityHidden(true)
            }

            content
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollBounceBehavior(.always)
        .scrollDismissesKeyboard(.interactively)
        .environment(\.defaultMinListRowHeight, 0)
    }

    private func updatePullDistance(_ distance: CGFloat) {
        guard !isRefreshing else { return }
        pullDistance = distance
        if distance > 0.5 {
            visualState = .pulling(progress: KordiSyncMarkGeometry.pullProgress(
                for: distance,
                triggerDistance: ChatPullToRefreshBehavior.triggerDistance
            ))
        } else if visualState != .idle {
            visualState = .idle
        }
    }

    private func finishPullGesture() {
        guard ChatPullToRefreshBehavior.shouldStart(
            distance: pullDistance,
            isRefreshing: isRefreshing
        ) else { return }
        beginRefresh()
    }

    private func beginRefresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        pullDistance = 0
        visualState = .refreshing
        Task {
            await onRefresh()
            withAnimation(.smooth(duration: 0.24)) {
                isRefreshing = false
                visualState = .idle
            }
        }
    }
}

private struct ChatPullOffsetPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private extension View {
    func chatHomeRow(separatorLeading: CGFloat) -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color(uiColor: .separator).opacity(0.45))
                    .frame(height: 0.5)
                    .padding(.leading, separatorLeading)
            }
    }
}

private enum ContactListItem: Identifiable {
    case conversation(ConversationSummary)
    case group(GroupSpaceSummary)

    var id: String {
        switch self {
        case let .conversation(conversation): "conversation:\(conversation.id)"
        case let .group(space): "space:\(space.id)"
        }
    }

    var displayName: String {
        switch self {
        case let .conversation(conversation): conversation.displayName
        case let .group(space): space.displayName
        }
    }

    var lastActivityAt: Date {
        switch self {
        case let .conversation(conversation): conversation.lastActivityAt
        case let .group(space): space.lastActivityAt
        }
    }

    func isPinned(
        sessionIds: Set<String>,
        groupSpaceIds: Set<String>
    ) -> Bool {
        switch self {
        case let .conversation(conversation):
            sessionIds.contains(conversation.sessionId)
        case let .group(space):
            groupSpaceIds.contains(space.preferenceId)
        }
    }
}

private enum ContactListRow: Identifiable {
    case conversation(ConversationSummary)
    case group(GroupSpaceSummary)
    case groupSession(ConversationSummary)

    var id: String {
        switch self {
        case let .conversation(conversation): "conversation:\(conversation.id)"
        case let .group(space): "space:\(space.id)"
        case let .groupSession(session): "group-session:\(session.sessionId)"
        }
    }
}

private struct ErrorBanner: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "wifi.exclamationmark")
            .font(.subheadline)
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
            .accessibilityLabel("Connection error: \(message)")
    }
}

#Preview("Chats · Contact page") {
    NavigationStack { ChatHomeView(channel: .contact) }
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}
