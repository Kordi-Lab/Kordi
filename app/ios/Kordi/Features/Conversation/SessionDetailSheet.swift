import Foundation
import QuickLook
import SwiftUI
import UIKit

private struct SessionFeatureNotice {
    let title: String
    let message: String

    static let search = SessionFeatureNotice(
        title: "Search unavailable",
        message: "Message search is not available in this Kordi build."
    )
}

struct SessionDetailView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary
    private let onBack: (() -> Void)?
    private let presentationContext: SessionDetailPresentationContext
    /// Shows one tab as its own page, opened from a contact profile row.
    private let focusedTab: SessionDetailTab?
    @State private var tab: SessionDetailTab
    @State private var previewURL: URL?
    @State private var mediaPreview: MediaPreviewPresentation?
    @State private var shareItem: SharedFileItem?
    @State private var documentReader: DocumentReaderRequest?
    @State private var loadingAttachmentId: String?
    @State private var featureNotice: SessionFeatureNotice?
    @State private var groupManagementPresentation: GroupManagementPresentation?
    @State private var groupInviteSpace: GroupSpaceSummary?
    @State private var relatedConversation: ConversationSummary?
    @State private var participantProfileConversation: ConversationSummary?
    @State private var chatConversation: ConversationSummary?
    @State private var callStartTask: Task<Void, Never>?
    @State private var agentThreads: [CloudAgentSubsessionTask] = []
    @State private var agentThreadError = false
    @State private var selectedAgentThread: CloudAgentSubsessionTask?

    init(
        conversation: ConversationSummary,
        presentationContext: SessionDetailPresentationContext = .conversation,
        opensMemory: Bool = false,
        focusedTab: SessionDetailTab? = nil,
        onBack: (() -> Void)? = nil
    ) {
        self.conversation = conversation
        self.presentationContext = presentationContext
        self.focusedTab = focusedTab
        self.onBack = onBack
        _tab = State(initialValue: focusedTab ?? (opensMemory ? .memory : conversation.kind == .group ? .members : .media))
    }

    private var currentConversation: ConversationSummary {
        model.conversations.first { $0.id == conversation.id } ?? conversation
    }

    private var notificationsMuted: Bool {
        model.mutedSessionIds.contains(currentConversation.sessionId)
    }

    private var activity: CloudSessionActivity? {
        model.sessionActivityByID[currentConversation.sessionId]
    }

    private var legacyTasks: [CloudSessionTaskActivity] {
        let linked = Set(agentThreads.flatMap { [$0.sessionId, $0.parentRequestId] })
        return (activity?.tasks ?? []).filter { !linked.contains($0.taskId) && !linked.contains($0.responseMessageId ?? "") }
    }

    private var contact: CloudContact? {
        model.contacts.first { $0.accountId == currentConversation.peerAccountId }
    }

    private var attachmentArtifacts: [SessionDetailAttachment] {
        model.messages(for: currentConversation)
            .flatMap { message in
                message.attachments.map { SessionDetailAttachment(message: message, attachment: $0) }
            }
            .sorted { $0.message.createdAt > $1.message.createdAt }
    }

    private var mediaAttachments: [SessionDetailAttachment] {
        attachmentArtifacts.filter { $0.attachment.kind == .image }
    }

    private var fileAttachments: [SessionDetailAttachment] {
        attachmentArtifacts.filter { $0.attachment.kind != .image }
    }

    private var messageCount: Int {
        max(currentConversation.messageCount ?? 0, model.messages(for: currentConversation).count)
    }

    private var heroTint: Color {
        currentConversation.kind == .agent ? KordiTheme.agentViolet : chatTheme.accent
    }

    private var statusText: String {
        switch currentConversation.kind {
        case .person:
            return currentConversation.representsKordiSupport
                ? "Official Kordi support"
                : ContactPresencePresentation.label(
                    for: model.contactPresenceByAccountID[currentConversation.peerAccountId]
                )
        case .agent:
            return model.agentStatusText(for: currentConversation)
        case .group:
            let count = profileParticipants.count
            return "\(count) \(count == 1 ? "participant" : "participants")"
        }
    }

    private var groupSpaces: [GroupSpaceSummary] {
        GroupSpaceCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? ""
        )
    }

    private var groupSpace: GroupSpaceSummary? {
        guard currentConversation.kind == .group else { return nil }
        if let existing = groupSpaces.first(where: { space in
            space.membershipSessions.contains { $0.id == currentConversation.id }
        }) {
            return existing
        }
        return GroupSpaceSummary(
            id: currentConversation.groupSpaceId?.nonEmpty ?? currentConversation.sessionId,
            displayName: currentConversation.ownerDisplayName?.nonEmpty
                ?? currentConversation.displayName,
            lastMessage: currentConversation.lastMessage,
            lastActivityAt: currentConversation.lastActivityAt,
            unreadCount: currentConversation.unreadCount,
            unreadMentionCount: currentConversation.unreadMentionCount,
            participants: currentConversation.groupParticipants,
            sessions: [currentConversation],
            membershipSessions: [currentConversation]
        )
    }

    private var profileDisplayName: String {
        groupSpace?.displayName.nonEmpty ?? currentConversation.displayName
    }

    private var profileParticipants: [CloudGroupParticipant] {
        guard let groupSpace else { return currentConversation.groupParticipants }
        let existingIDs = Set(currentConversation.groupParticipants.map(\.accountId))
        return currentConversation.groupParticipants
            + groupSpace.participants.filter { !existingIDs.contains($0.accountId) }
    }

    private var availableTabs: [SessionDetailTab] {
        // Reads the published capabilities so the picker re-renders when they load.
        SessionDetailTab.tabs(for: currentConversation.kind, capabilities: model.memoryCapabilities)
    }

    private var mutualGroupSpaces: [GroupSpaceSummary] {
        SessionRelatedGroupCatalog.mutualSpaces(
            conversations: model.conversations,
            ownAccountID: model.account?.accountId ?? "",
            peerAccountID: currentConversation.peerAccountId
        )
    }

    private var facts: [SessionDetailFact] {
        guard currentConversation.kind != .group else { return [] }
        var items: [SessionDetailFact] = []

        if currentConversation.kind == .person,
           let kordiId = contact?.kordiId?.nonEmpty {
            items.append(SessionDetailFact(id: "kordi-id", label: "Kordi ID", value: kordiId))
        }
        if currentConversation.kind == .agent,
           let owner = currentConversation.ownerDisplayName.nonEmpty {
            items.append(SessionDetailFact(id: "owner", label: "Owner", value: owner))
        }
        items.append(SessionDetailFact(id: "messages", label: "Messages", value: String(messageCount)))
        items.append(
            SessionDetailFact(
                id: "activity",
                label: "Recent activity",
                value: currentConversation.lastActivityAt.formatted(date: .abbreviated, time: .shortened)
            )
        )
        return items
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                if focusedTab == nil { profileHeader }
                VStack(spacing: 16) {
                    if focusedTab == nil {
                        Picker("Session content", selection: $tab) {
                            ForEach(availableTabs) { item in Text(item.rawValue).tag(item) }
                        }
                        .pickerStyle(.segmented)
                    }
                    tabContent
                }
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 28)
            }
        }
        .background {
            SessionDetailBackground(tint: heroTint)
                .ignoresSafeArea()
        }
        .navigationTitle(focusedTab?.rawValue ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(focusedTab == nil ? .hidden : .visible, for: .navigationBar)
        .overlay(alignment: .topLeading) {
            if focusedTab == nil { SessionDetailBackButton(action: closeDetails) }
        }
        .tint(heroTint)
        .sensoryFeedback(.selection, trigger: notificationsMuted)
        .task {
            guard !Task.isCancelled else { return }
            await model.loadConversation(currentConversation)
            guard !Task.isCancelled else { return }
            await model.loadSessionActivity(currentConversation)
            guard !Task.isCancelled else { return }
            await model.refreshActiveCall(in: currentConversation)
        }
        .quickLookPreview($previewURL)
        .task { await model.refreshMemoryCapabilities() }
        .task(id: "\(currentConversation.sessionId):\(model.account?.accountId ?? ""):\(tab.rawValue)") {
            agentThreads = []
            agentThreadError = false
            selectedAgentThread = nil
            guard tab == .todo, currentConversation.kind != .agent else { return }
            while !Task.isCancelled {
                do {
                    let next = try await model.agentSubsessionTasks(parentSessionId: currentConversation.sessionId)
                    try Task.checkCancellation()
                    agentThreads = next
                    agentThreadError = false
                } catch {
                    if Task.isCancelled { return }
                    agentThreads = []
                    agentThreadError = true
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
        .navigationDestination(item: $documentReader) { DocumentReaderScreen(request: $0) }
        .navigationDestination(item: $selectedAgentThread) { task in
            AgentSubsessionView(sessionId: task.sessionId)
        }
        .fullScreenCover(item: $mediaPreview) { presentation in
            MediaPreviewView(presentation: presentation)
        }
        .sheet(item: $shareItem) { item in ActivityShareSheet(items: [item.url]) }
        .sheet(item: $groupManagementPresentation) { presentation in
            GroupManagementSheet(presentation: presentation)
        }
        .sheet(item: $groupInviteSpace) { space in
            GroupMemberInviteSheet(space: space)
        }
        .navigationDestination(item: $relatedConversation) { destination in
            ConversationView(conversation: destination)
        }
        .navigationDestination(item: $participantProfileConversation) { destination in
            SessionDetailView(
                conversation: destination,
                presentationContext: .groupParticipantProfile
            )
        }
        .navigationDestination(item: $chatConversation) { destination in
            ConversationView(conversation: destination)
        }
        .onDisappear {
            callStartTask?.cancel()
            callStartTask = nil
            callCoordinator.cancelUnadmittedStart()
        }
        .alert(
            featureNotice?.title ?? "Feature unavailable",
            isPresented: Binding(
                get: { featureNotice != nil },
                set: { if !$0 { featureNotice = nil } }
            )
        ) {
            Button("OK") { featureNotice = nil }
        } message: {
            Text(featureNotice?.message ?? "This feature is not available in this Kordi build.")
        }
    }

    @ViewBuilder
    private var profileHeader: some View {
        SessionProfileHero(
            conversation: currentConversation,
            displayName: profileDisplayName,
            participants: profileParticipants,
            statusText: statusText,
            tint: heroTint
        ) {
            SessionHeroActions(
                kind: currentConversation.kind,
                tint: heroTint,
                notificationsMuted: notificationsMuted,
                isCallStarting: callCoordinator.isStartingCall,
                onChat: openChat,
                onCall: { startOrJoinCall(kind: .voice) },
                onVideo: { startOrJoinCall(kind: .video) },
                onMute: toggleNotificationsMuted,
                onSearch: { showFeatureNotice(.search) },
                moreActions: moreActionItems,
                onMoreAction: handleMoreAction
            )
        }
        profileSummary
    }

    @ViewBuilder
    private var profileSummary: some View {
        if currentConversation.kind == .group {
            SessionDetailSection {
                SessionSettingsRow(title: "Group settings", systemImage: "slider.horizontal.3", action: openGroupSettings)
            }
            .accessibilityHint("Opens group name and membership settings")
            .padding(.horizontal, 16)
        } else if !facts.isEmpty {
            SessionFactsSection(facts: facts)
                .padding(.horizontal, 16)
        }
    }

    @ViewBuilder
    private var tabContent: some View {
        switch tab {
        case .members:
            membersPage
        case .memory:
            SessionMemoryPage(conversation: currentConversation, account: model.account, service: model.makeMemoryService())
        case .media:
            mediaPage
        case .files:
            filesPage
        case .todo:
            todoPage
        case .groups:
            groupsPage
        }
    }

    @ViewBuilder
    private var membersPage: some View {
        SessionParticipantsSection(
            participants: profileParticipants,
            selfAccountId: model.account?.accountId,
            onAddMember: openAddMembers,
            onOpenParticipant: openParticipantProfile
        )
    }

    @ViewBuilder
    private var mediaPage: some View {
        if mediaAttachments.isEmpty {
            SessionDetailEmptyState(title: "No media yet", symbol: "photo.on.rectangle.angled")
        } else {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3),
                spacing: 3
            ) {
                ForEach(mediaAttachments) { item in
                    SessionMediaThumbnail(item: item) {
                        openMedia(item)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: SessionDetailMetrics.sectionCornerRadius, style: .continuous))
        }
    }

    @ViewBuilder
    private var filesPage: some View {
        if fileAttachments.isEmpty && (activity?.artifacts.isEmpty ?? true) {
            SessionDetailEmptyState(title: "No files yet", symbol: "folder")
        } else {
            VStack(spacing: 16) {
                if let artifacts = activity?.artifacts, !artifacts.isEmpty {
                    SessionDetailSection(title: "Generated") {
                        ForEach(Array(artifacts.enumerated()), id: \.element.id) { index, artifact in
                            CloudArtifactRow(artifact: artifact, onOpen: documentOpener(for: artifact))
                            if index < artifacts.count - 1 { SessionDetailSeparator(leading: SessionFileRowMetrics.textInset) }
                        }
                    }
                }

                if !fileAttachments.isEmpty {
                    SessionDetailSection {
                        ForEach(Array(fileAttachments.enumerated()), id: \.element.id) { index, item in
                            SessionDetailFileRow(
                                item: item,
                                isLoading: loadingAttachmentId == item.attachment.id,
                                onReview: { review(item) },
                                onDownload: { prepare(item.attachment, forSharing: true) }
                            )
                            if index < fileAttachments.count - 1 { SessionDetailSeparator(leading: SessionFileRowMetrics.textInset) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var todoPage: some View {
        if agentThreadError {
            Text("Could not refresh Agent threads. Check access or try again.")
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
        }
        if !agentThreads.isEmpty {
            SessionDetailSection(title: "Agent threads") {
                ForEach(Array(agentThreads.enumerated()), id: \.element.id) { index, task in
                    SessionAgentThreadRow(task: task) { selectedAgentThread = task }
                    if index < agentThreads.count - 1 { SessionDetailSeparator(leading: 56) }
                }
            }
        }
        if legacyTasks.isEmpty && agentThreads.isEmpty && !agentThreadError {
            SessionDetailEmptyState(title: "No task activity yet", symbol: "checkmark.circle")
        } else if !legacyTasks.isEmpty {
            SessionDetailSection {
                let tasks = legacyTasks
                ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                    SessionTaskRow(task: task)
                    if index < tasks.count - 1 { SessionDetailSeparator(leading: 56) }
                }
            }
        }
    }

    @ViewBuilder
    private var groupsPage: some View {
        if mutualGroupSpaces.isEmpty {
            SessionDetailEmptyState(title: "No shared groups", symbol: "person.2")
        } else {
            SessionRelatedGroupsSection(
                spaces: mutualGroupSpaces,
                onOpen: openRelatedGroup
            )
        }
    }

    private var moreActionItems: [SessionMoreAction] {
        switch currentConversation.kind {
        case .group:
            [.addMembers, .groupSettings, .copyGroupName]
        case .person:
            contact?.kordiId?.nonEmpty == nil
                ? [.backToChat]
                : [.copyKordiID, .backToChat]
        case .agent:
            [.backToChat]
        }
    }

    private func handleMoreAction(_ action: SessionMoreAction) {
        switch action {
        case .addMembers:
            openAddMembers()
        case .groupSettings:
            openGroupSettings()
        case .copyGroupName:
            UIPasteboard.general.string = profileDisplayName
        case .copyKordiID:
            UIPasteboard.general.string = contact?.kordiId?.nonEmpty
        case .backToChat:
            closeDetails()
        }
    }

    private func closeDetails() {
        if let onBack { onBack() } else { dismiss() }
    }

    private func showFeatureNotice(_ notice: SessionFeatureNotice) {
        featureNotice = notice
    }

    private func openChat() {
        if presentationContext.opensConversationOnChat {
            chatConversation = currentConversation
        } else {
            closeDetails()
        }
    }

    private func openParticipantProfile(_ participant: CloudGroupParticipant) {
        participantProfileConversation = ConversationAuthorProfileResolver.destination(
            currentConversation: currentConversation,
            participant: participant,
            selfAccountID: model.account?.accountId,
            contacts: model.contacts,
            conversations: model.conversations
        )
    }

    private func startOrJoinCall(kind: CloudCallKind) {
        callStartTask?.cancel()
        callStartTask = Task {
            if let call = model.activeCall(for: currentConversation) {
                await callCoordinator.join(call, in: currentConversation)
            } else {
                await callCoordinator.start(conversation: currentConversation, kind: kind)
            }
            if case .failed(let message) = callCoordinator.phase,
               callCoordinator.activeCall == nil {
                featureNotice = SessionFeatureNotice(
                    title: "Call unavailable",
                    message: message
                )
            }
        }
    }

    private func toggleNotificationsMuted() {
        let muted = !notificationsMuted
        Task { _ = await model.setConversationMuted(currentConversation, muted: muted) }
    }

    private func openGroupSettings() {
        guard let groupSpace else { return }
        groupManagementPresentation = GroupManagementPresentation(
            space: groupSpace,
            startsInInviteMode: false
        )
    }

    private func openAddMembers() {
        guard let groupSpace else { return }
        groupInviteSpace = groupSpace
    }

    private func openRelatedGroup(_ space: GroupSpaceSummary) {
        relatedConversation = space.sessions.first
    }

    private func openMedia(_ item: SessionDetailAttachment) {
        mediaPreview = MediaPreviewPresentation.make(
            opening: item.attachment,
            from: item.message,
            in: model.messages(for: currentConversation),
            initialImage: nil
        )
    }

    /// Markdown and HTML files open in the document reader; others in Quick Look.
    private func review(_ item: SessionDetailAttachment) {
        if let request = DocumentReaderRequest(attachment: item.attachment, message: item.message, conversation: currentConversation) {
            documentReader = request
        } else {
            prepare(item.attachment, forSharing: false)
        }
    }

    /// Nil for artifacts that stay on the Mac or are not documents.
    private func documentOpener(for artifact: CloudSessionArtifactActivity) -> (() -> Void)? {
        let messages = model.messages(for: currentConversation)
        guard let request = DocumentReaderRequest(artifact: artifact, messages: messages, conversation: currentConversation) else { return nil }
        return { documentReader = request }
    }

    private func prepare(_ attachment: ChatAttachment, forSharing: Bool) {
        guard loadingAttachmentId == nil else { return }
        loadingAttachmentId = attachment.id
        Task {
            defer { loadingAttachmentId = nil }
            guard let url = await model.prepareAttachmentForPresentation(attachment) else { return }
            if forSharing { shareItem = SharedFileItem(url: url) } else { previewURL = url }
        }
    }
}

private struct SessionHeroActions: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let kind: ConversationKind
    let tint: Color
    let notificationsMuted: Bool
    let isCallStarting: Bool
    let onChat: () -> Void
    let onCall: () -> Void
    let onVideo: () -> Void
    let onMute: () -> Void
    let onSearch: () -> Void
    let moreActions: [SessionMoreAction]
    let onMoreAction: (SessionMoreAction) -> Void

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    actionButtons
                }
            } else {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4),
                    spacing: 10
                ) {
                    actionButtons
                }
            }
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        ForEach(actionItems) { item in
            if item == .more {
                Menu {
                    ForEach(moreActions) { action in
                        Button {
                            onMoreAction(action)
                        } label: {
                            Label(action.title, systemImage: action.symbol)
                        }
                    }
                } label: {
                    SessionProfileActionLabel(
                        title: title(for: item),
                        symbol: symbol(for: item),
                        tint: tint,
                        isSelected: false
                    )
                }
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .accessibilityLabel("More actions")
            } else {
                SessionProfileActionButton(
                    title: title(for: item),
                    symbol: symbol(for: item),
                    tint: tint,
                    isSelected: item == .mute && notificationsMuted,
                    action: { perform(item) }
                )
                .disabled(isCallStarting && (item == .call || item == .video))
            }
        }
    }

    private var actionItems: [SessionHeroAction] {
        switch kind {
        case .person: [.call, .video, .mute, .chat]
        case .group: [.video, .mute, .search, .more]
        case .agent: [.chat, .mute, .search, .more]
        }
    }

    private func title(for item: SessionHeroAction) -> String {
        switch item {
        case .chat: "Chat"
        case .call: isCallStarting ? "Starting…" : "Call"
        case .video: isCallStarting ? "Starting…" : kind == .group ? "Video chat" : "Video"
        case .mute: notificationsMuted ? "Unmute" : "Mute"
        case .search: "Search"
        case .more: "More"
        }
    }

    private func symbol(for item: SessionHeroAction) -> String {
        switch item {
        case .chat: "bubble.left.fill"
        case .call: "phone.fill"
        case .video: "video.fill"
        case .mute: notificationsMuted ? "bell.fill" : "bell.slash.fill"
        case .search: "magnifyingglass"
        case .more: "ellipsis"
        }
    }

    private func perform(_ item: SessionHeroAction) {
        switch item {
        case .chat: onChat()
        case .call: onCall()
        case .video: onVideo()
        case .mute: onMute()
        case .search: onSearch()
        case .more: break
        }
    }
}

struct SessionDetailAttachment: Identifiable {
    let message: ChatMessage
    let attachment: ChatAttachment
    var id: String { "\(message.id):\(attachment.id)" }
}

enum SessionRelatedGroupCatalog {
    static func mutualSpaces(
        conversations: [ConversationSummary],
        ownAccountID: String,
        peerAccountID: String
    ) -> [GroupSpaceSummary] {
        guard !ownAccountID.isEmpty, !peerAccountID.isEmpty else { return [] }
        return GroupSpaceCatalog.build(
            conversations: conversations,
            ownAccountId: ownAccountID
        ).filter { space in
            let participantIDs = Set(space.participants.map(\.accountId))
            return participantIDs.contains(ownAccountID)
                && participantIDs.contains(peerAccountID)
        }
    }
}
