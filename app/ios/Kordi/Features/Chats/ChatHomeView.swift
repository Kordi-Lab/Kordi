import SwiftUI

enum ChatChannel: String, CaseIterable, Identifiable {
    case contact = "Contact"
    case agent = "Agent"

    var id: Self { self }
}

struct ChatHomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var channel: ChatChannel
    @State private var searchText = ""
    @State private var showNewChat = false
    @State private var composedConversation: ConversationSummary?
    @State private var expandedGroupSpaceIds = Set<String>()
    @State private var collapsedAgentForkParentIds = Set<String>()
    @State private var renameTarget: ConversationSummary?
    @State private var renameDraft = ""
    @State private var deleteTarget: ConversationSummary?
    @State private var groupManagementPresentation: GroupManagementPresentation?
    @State private var pullRefreshState: ChatPullRefreshVisualState = .idle
    private let onOpenConversation: ((ConversationSummary) -> Void)?

    init(
        initialChannel: ChatChannel? = nil,
        onOpenConversation: ((ConversationSummary) -> Void)? = nil
    ) {
        let previewChannel: ChatChannel = ProcessInfo.processInfo.arguments.contains("--preview-agent-page") ? .agent : .contact
        _channel = State(initialValue: initialChannel ?? previewChannel)
        _showNewChat = State(initialValue: ProcessInfo.processInfo.arguments.contains("--preview-new-chat"))
        self.onOpenConversation = onOpenConversation
    }

    private var searchQuery: String {
        ChatHomeSearch.normalized(searchText)
    }

    private var agentSessions: [AgentSessionListItem] {
        AgentSessionTimelineCatalog.build(
            conversations: model.conversations,
            searchText: searchQuery,
            collapsedForkParentIds: collapsedAgentForkParentIds
        )
    }

    private var groupSpaces: [GroupSpaceSummary] {
        let spaces = GroupSpaceCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? ""
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
                $0.lastActivityAt > $1.lastActivityAt || (
                    $0.lastActivityAt == $1.lastActivityAt
                        && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
                )
            }
    }

    var body: some View {
        VStack(spacing: 0) {
            chatPageHeader

            TabView(selection: $channel) {
                contactPage
                    .tag(ChatChannel.contact)

                agentPage
                    .tag(ChatChannel.agent)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
        }
        .background(Color(uiColor: .systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--preview-agent-page") {
                channel = .agent
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
        .sheet(isPresented: $showNewChat) {
            NewChatSheet { selected in
                openConversation(selected)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
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
        .confirmationDialog(
            "Delete this session?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete session", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { _ = await model.deleteConversation(target) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("This removes the session from Kordi Cloud and all synced devices.")
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
        Button { showNewChat = true } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel("Start a chat")
    }

    private var chatPageHeader: some View {
        KordiPageSearchHeader(
            text: $searchText,
            prompt: channel == .contact ? "Search chats" : "Search agent sessions",
            accessibilityLabel: channel == .contact
                ? "Search contact and group chats"
                : "Search agents, sessions, owners, and messages"
        ) {
            Picker("Chat channel", selection: $channel) {
                ForEach(ChatChannel.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .controlSize(.large)
            .frame(minHeight: 44)
        }
    }

    private var contactPage: some View {
        ChatPullToRefreshScrollView(
            coordinateSpaceName: "contact-chat-refresh",
            visualState: $pullRefreshState,
            onRefresh: { await model.refreshWorkspace() }
        ) {
            if contactItems.isEmpty {
                ContentUnavailableView(
                    searchQuery.isEmpty ? "No contact conversations yet" : "No chats found",
                    systemImage: searchQuery.isEmpty ? "person.2" : "magnifyingglass",
                    description: Text(searchQuery.isEmpty ? "Start a chat with a contact to see it here." : "Try another name, Kordi ID, or message.")
                )
                .frame(maxWidth: .infinity, minHeight: 360)
            } else {
                ForEach(contactItems) { item in
                    contactItemRow(item)
                }
            }
        }
        .accessibilityLabel("Contact chats")
    }

    @ViewBuilder
    private func contactItemRow(_ item: ContactListItem) -> some View {
        switch item {
        case let .conversation(conversation):
            destination(for: conversation)
        case let .group(space):
            let isExpanded = groupIsExpanded(space)
            Button {
                toggleGroupSpace(space)
            } label: {
                GroupSpaceRow(space: space, isExpanded: isExpanded)
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
            }
            .accessibilityHint("Double-tap to show sessions. Touch and hold to manage or invite people.")
            .chatHomeRow(separatorLeading: 71)

            if isExpanded {
                ForEach(space.sessions) { session in
                    sessionActionRow(for: session) {
                        GroupSessionRow(session: session)
                    }
                }
            }
        }
    }

    private var agentPage: some View {
        ChatPullToRefreshScrollView(
            coordinateSpaceName: "agent-chat-refresh",
            visualState: $pullRefreshState,
            onRefresh: { await model.refreshWorkspace() }
        ) {
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
        .accessibilityLabel("Agent chats")
    }

    private func destination(for conversation: ConversationSummary) -> some View {
        sessionActionRow(for: conversation) {
            ConversationRow(conversation: conversation)
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
            Button {
                renameDraft = conversation.displayName
                renameTarget = conversation
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button {
                Task { await model.markConversationRead(conversation) }
            } label: {
                Label("Mark as read", systemImage: "checkmark.circle")
            }
            Divider()
            Button(role: .destructive) {
                deleteTarget = conversation
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .accessibilityHint("Double-tap to open. Touch and hold for session actions.")
        .chatHomeRow(separatorLeading: 71)
    }

    private func agentSessionActionRow(_ item: AgentSessionListItem) -> some View {
        HStack(spacing: 0) {
            Button {
                openConversation(item.conversation)
            } label: {
                AgentSessionRow(conversation: item.conversation, isFork: item.isFork)
                    .padding(.leading, CGFloat(item.depth) * 16)
            }
            .buttonStyle(.plain)

            if item.childCount > 0 {
                Button {
                    toggleAgentForks(for: item.conversation)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.branch")
                        Text(String(item.childCount))
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(collapsedAgentForkParentIds.contains(item.conversation.sessionId) ? -90 : 0))
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 56, height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(collapsedAgentForkParentIds.contains(item.conversation.sessionId) ? "Show forks" : "Hide forks")
            }
        }
        .contextMenu {
            sessionContextMenu(for: item.conversation)
        }
        .accessibilityHint("Double-tap to open. Touch and hold for session actions.")
        .chatHomeRow(separatorLeading: 16)
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
            Task { await model.markConversationRead(conversation) }
        } label: {
            Label("Mark as read", systemImage: "checkmark.circle")
        }
        Divider()
        Button(role: .destructive) {
            deleteTarget = conversation
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    private func groupIsExpanded(_ space: GroupSpaceSummary) -> Bool {
        ProcessInfo.processInfo.arguments.contains("--preview-expanded-groups")
            || !searchQuery.isEmpty
            || expandedGroupSpaceIds.contains(space.id)
    }

    private func toggleGroupSpace(_ space: GroupSpaceSummary) {
        let willExpand = !expandedGroupSpaceIds.contains(space.id)
        withAnimation(.snappy(duration: 0.22)) {
            if willExpand {
                expandedGroupSpaceIds.insert(space.id)
            } else {
                expandedGroupSpaceIds.remove(space.id)
            }
        }
        guard willExpand else { return }
        Task { await model.markGroupSpaceRead(space) }
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
        model.prepareConversationForPresentation(conversation)
        if let onOpenConversation {
            onOpenConversation(conversation)
        } else {
            composedConversation = conversation
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
            scrollView(includeLegacyOffsetProbe: false)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    ChatPullToRefreshBehavior.pullDistance(
                        contentOffsetY: geometry.contentOffset.y,
                        contentInsetTop: geometry.contentInsets.top
                    )
                } action: { _, distance in
                    updatePullDistance(distance)
                }
                .onScrollPhaseChange { oldPhase, newPhase in
                    if newPhase == .interacting { return }
                    guard oldPhase == .interacting, newPhase != .interacting else { return }
                    finishPullGesture()
                }
        } else {
            scrollView(includeLegacyOffsetProbe: true)
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

    private func scrollView(includeLegacyOffsetProbe: Bool) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                if includeLegacyOffsetProbe {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: ChatPullOffsetPreferenceKey.self,
                            value: proxy.frame(in: .named(coordinateSpaceName)).minY
                        )
                    }
                    .frame(height: 0)
                }

                LazyVStack(spacing: 0) {
                    content
                }
            }
        }
        .scrollBounceBehavior(.always)
        .scrollDismissesKeyboard(.interactively)
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
    NavigationStack { ChatHomeView() }
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}
