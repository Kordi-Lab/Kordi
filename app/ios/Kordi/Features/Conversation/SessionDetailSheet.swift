import Foundation
import QuickLook
import SwiftUI
import UIKit

private enum SessionDetailTab: String, Identifiable {
    case members = "Members"
    case media = "Media"
    case files = "Files"
    case todo = "Todo"
    case groups = "Groups"

    var id: Self { self }
}

private struct SessionFeatureNotice {
    let title: String
    let message: String

    static let search = SessionFeatureNotice(
        title: "Search unavailable",
        message: "Message search is not available in this Kordi build."
    )
}

struct SessionDetailView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary
    @State private var tab: SessionDetailTab
    @State private var previewURL: URL?
    @State private var mediaPreview: MediaPreviewPresentation?
    @State private var shareItem: SharedFileItem?
    @State private var loadingAttachmentId: String?
    @State private var featureNotice: SessionFeatureNotice?
    @State private var groupManagementPresentation: GroupManagementPresentation?
    @State private var groupInviteSpace: GroupSpaceSummary?
    @State private var relatedConversation: ConversationSummary?
    @State private var participantProfileConversation: ConversationSummary?
    @State private var callStartTask: Task<Void, Never>?

    init(conversation: ConversationSummary) {
        self.conversation = conversation
        _tab = State(initialValue: conversation.kind == .group ? .members : .media)
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
        currentConversation.kind == .agent ? KordiTheme.agentViolet : KordiTheme.signalBlue
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
        switch currentConversation.kind {
        case .group:
            [.members, .media, .files, .todo]
        case .person:
            [.media, .files, .todo, .groups]
        case .agent:
            [.media, .files, .todo]
        }
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
            LazyVStack(spacing: 20) {
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
                        onChat: dismiss.callAsFunction,
                        onCall: { startOrJoinCall(kind: .voice) },
                        onVideo: { startOrJoinCall(kind: .video) },
                        onMute: toggleNotificationsMuted,
                        onSearch: { showFeatureNotice(.search) },
                        moreActions: moreActionItems,
                        onMoreAction: handleMoreAction
                    )
                }

                profileSummary

                VStack(spacing: 14) {
                    Picker("Session content", selection: $tab) {
                        ForEach(availableTabs) { item in
                            Text(item.rawValue).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)

                    tabContent
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
        }
        .background {
            SessionDetailBackground(tint: heroTint)
                .ignoresSafeArea()
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) {
            Button(action: dismiss.callAsFunction) {
                Image(systemName: "chevron.left")
                    .font(.title3.weight(.semibold))
                    .frame(width: 50, height: 50)
                    .background(.thinMaterial, in: Circle())
                    .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .padding(.leading, 18)
            .safeAreaPadding(.top, 8)
            .accessibilityLabel("Back")
        }
        .tint(heroTint)
        .sensoryFeedback(.selection, trigger: notificationsMuted)
        .task {
            await model.loadConversation(currentConversation)
            await model.loadSessionActivity(currentConversation)
            await model.refreshActiveCall(in: currentConversation)
        }
        .quickLookPreview($previewURL)
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
            SessionDetailView(conversation: destination)
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
    private var profileSummary: some View {
        if currentConversation.kind == .group {
            SessionGroupSettingsButton(action: openGroupSettings)
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
            SessionDetailEmptyState(
                title: "No media yet",
                symbol: "photo.on.rectangle.angled",
                description: "Images shared in this conversation will appear here."
            )
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
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    @ViewBuilder
    private var filesPage: some View {
        if fileAttachments.isEmpty && (activity?.artifacts.isEmpty ?? true) {
            SessionDetailEmptyState(
                title: "No files yet",
                symbol: "folder",
                description: "Generated documents and shared files will appear here."
            )
        } else {
            VStack(spacing: 16) {
                if let artifacts = activity?.artifacts, !artifacts.isEmpty {
                    SessionDetailCard(title: "Generated") {
                        ForEach(Array(artifacts.enumerated()), id: \.element.id) { index, artifact in
                            CloudArtifactRow(artifact: artifact)
                            if index < artifacts.count - 1 { Divider() }
                        }
                    }
                }

                if !fileAttachments.isEmpty {
                    SessionDetailCard(title: "Shared files") {
                        ForEach(Array(fileAttachments.enumerated()), id: \.element.id) { index, item in
                            SessionDetailFileRow(
                                item: item,
                                isLoading: loadingAttachmentId == item.attachment.id,
                                onReview: { prepare(item.attachment, forSharing: false) },
                                onDownload: { prepare(item.attachment, forSharing: true) }
                            )
                            if index < fileAttachments.count - 1 { Divider() }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var todoPage: some View {
        if activity?.tasks.isEmpty ?? true {
            SessionDetailEmptyState(
                title: "No task activity yet",
                symbol: "checkmark.circle",
                description: "Planning and execution tasks for this session will appear here."
            )
        } else {
            SessionDetailCard(title: "Session tasks") {
                let tasks = activity?.tasks ?? []
                ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                    SessionTaskRow(task: task)
                    if index < tasks.count - 1 { Divider() }
                }
            }
        }
    }

    @ViewBuilder
    private var groupsPage: some View {
        if mutualGroupSpaces.isEmpty {
            SessionDetailEmptyState(
                title: "No shared groups",
                symbol: "person.2",
                description: "Groups that include both of you will appear here."
            )
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
            dismiss()
        }
    }

    private func showFeatureNotice(_ notice: SessionFeatureNotice) {
        featureNotice = notice
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

private struct SessionProfileHero<Actions: View>: View {
    let conversation: ConversationSummary
    let displayName: String
    let participants: [CloudGroupParticipant]
    let statusText: String
    let tint: Color
    private let actions: Actions
    @ScaledMetric(relativeTo: .largeTitle) private var avatarSize = 108.0

    init(
        conversation: ConversationSummary,
        displayName: String,
        participants: [CloudGroupParticipant],
        statusText: String,
        tint: Color,
        @ViewBuilder actions: () -> Actions
    ) {
        self.conversation = conversation
        self.displayName = displayName
        self.participants = participants
        self.statusText = statusText
        self.tint = tint
        self.actions = actions()
    }

    var body: some View {
        VStack(spacing: 18) {
            avatar
                .shadow(color: .black.opacity(0.1), radius: 12, y: 5)

            VStack(spacing: 4) {
                Text(displayName)
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)

                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(Color.primary.opacity(0.62))
                    .multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(displayName), \(statusText)")

            actions
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
        .padding(.bottom, 24)
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private var avatar: some View {
        if conversation.kind == .group {
            GroupAvatarStack(participants: participants, size: avatarSize)
        } else {
            IdentityAvatar(
                name: conversation.displayName,
                imageSource: conversation.avatarSource,
                kind: conversation.kind,
                size: avatarSize,
                seed: conversation.agentId ?? conversation.peerAccountId
            )
        }
    }
}

private struct SessionDetailBackground: View {
    let tint: Color

    var body: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)

            LinearGradient(
                stops: [
                    .init(color: tint.opacity(0.25), location: 0),
                    .init(color: tint.opacity(0.18), location: 0.28),
                    .init(color: tint.opacity(0.07), location: 0.52),
                    .init(color: .clear, location: 0.70)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
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
                    columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4),
                    spacing: 8
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
        case .person: [.call, .video, .mute, .more]
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

private enum SessionHeroAction: String, Identifiable {
    case chat
    case call
    case video
    case mute
    case search
    case more

    var id: Self { self }
}

private enum SessionMoreAction: String, Identifiable {
    case addMembers
    case groupSettings
    case copyGroupName
    case copyKordiID
    case backToChat

    var id: Self { self }

    var title: String {
        switch self {
        case .addMembers: "Add members"
        case .groupSettings: "Group settings"
        case .copyGroupName: "Copy group name"
        case .copyKordiID: "Copy Kordi ID"
        case .backToChat: "Back to chat"
        }
    }

    var symbol: String {
        switch self {
        case .addMembers: "person.badge.plus"
        case .groupSettings: "slider.horizontal.3"
        case .copyGroupName, .copyKordiID: "doc.on.doc"
        case .backToChat: "bubble.left"
        }
    }
}

private struct SessionProfileActionLabel: View {
    let title: String
    let symbol: String
    let tint: Color
    let isSelected: Bool

    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.title3.weight(.semibold))
            Text(title)
                .font(.caption.weight(.medium))
                .lineLimit(2)
                .minimumScaleFactor(0.82)
        }
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity, minHeight: 72)
        .background(
            isSelected
                ? tint.opacity(0.18)
                : Color(uiColor: .secondarySystemGroupedBackground).opacity(0.90),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .contentShape(Rectangle())
    }
}

private struct SessionProfileActionButton: View {
    let title: String
    let symbol: String
    let tint: Color
    var isSelected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SessionProfileActionLabel(
                title: title,
                symbol: symbol,
                tint: tint,
                isSelected: isSelected
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct SessionDetailFact: Identifiable {
    let id: String
    let label: String
    let value: String
}

private struct SessionGroupSettingsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "slider.horizontal.3")
                    .font(.headline)
                    .foregroundStyle(KordiTheme.signalBlue)
                    .frame(width: 40, height: 40)
                    .background(
                        KordiTheme.signalBlue.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                    )

                Text("Group settings")
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 62)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens group name and membership settings")
    }
}

private struct SessionFactsSection: View {
    let facts: [SessionDetailFact]

    var body: some View {
        SessionDetailCard(title: "About") {
            ForEach(Array(facts.enumerated()), id: \.element.id) { index, fact in
                LabeledContent(fact.label) {
                    Text(fact.value)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                .font(.body)
                .padding(.vertical, 2)

                if index < facts.count - 1 { Divider() }
            }
        }
    }
}

private struct SessionParticipantsSection: View {
    let participants: [CloudGroupParticipant]
    let selfAccountId: String?
    let onAddMember: () -> Void
    let onOpenParticipant: (CloudGroupParticipant) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onAddMember) {
                Label("Add members", systemImage: "person.badge.plus")
                    .font(.body.weight(.medium))
                    .foregroundStyle(KordiTheme.signalBlue)
                    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !participants.isEmpty {
                Divider().padding(.leading, 52)
            }

            ForEach(Array(participants.enumerated()), id: \.element.id) { index, participant in
                HStack(spacing: 12) {
                    if selfAccountId == nil || participant.accountId == selfAccountId {
                        participantAvatar(participant)
                    } else {
                        Button { onOpenParticipant(participant) } label: {
                            participantAvatar(participant)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open profile for \(participant.displayName)")
                    }
                    Text(participant.displayName)
                        .font(.body)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(roleLabel(participant))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 56)

                if index < participants.count - 1 { Divider().padding(.leading, 52) }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    private func participantAvatar(_ participant: CloudGroupParticipant) -> some View {
        IdentityAvatar(
            name: participant.displayName,
            imageSource: participant.avatarUrl.nonEmpty,
            kind: .person,
            size: 40,
            seed: participant.accountId
        )
        .frame(width: 44, height: 44)
    }

    private func roleLabel(_ participant: CloudGroupParticipant) -> String {
        if participant.accountId == selfAccountId { return "You" }
        if let role = participant.role?.lowercased(), ["owner", "admin"].contains(role) {
            return "Admin"
        }
        return "Member"
    }
}

private struct SessionRelatedGroupsSection: View {
    let spaces: [GroupSpaceSummary]
    let onOpen: (GroupSpaceSummary) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(spaces.enumerated()), id: \.element.id) { index, space in
                Button { onOpen(space) } label: {
                    HStack(spacing: 12) {
                        GroupAvatarStack(participants: space.participants, size: 44)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(space.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(groupDetail(space))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }

                        Spacer(minLength: 8)

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(minHeight: 60)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(space.displayName), \(groupDetail(space))")

                if index < spaces.count - 1 { Divider().padding(.leading, 56) }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    private func groupDetail(_ space: GroupSpaceSummary) -> String {
        let participantCount = space.participants.count
        let sessionCount = space.sessions.count
        return "\(participantCount) members · \(sessionCount) \(sessionCount == 1 ? "session" : "sessions")"
    }
}

private struct SessionDetailCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)

            VStack(spacing: 10) {
                content
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SessionDetailEmptyState: View {
    let title: String
    let symbol: String
    let description: String

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: symbol,
            description: Text(description)
        )
        .frame(maxWidth: .infinity, minHeight: 210)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct SessionDetailAttachment: Identifiable {
    let message: ChatMessage
    let attachment: ChatAttachment
    var id: String { "\(message.id):\(attachment.id)" }
}

private struct SessionMediaThumbnail: View {
    @EnvironmentObject private var model: AppModel
    let item: SessionDetailAttachment
    let onOpen: () -> Void
    @State private var image: UIImage?
    @State private var hasFailed = false

    var body: some View {
        Button(action: onOpen) {
            Color(uiColor: .secondarySystemGroupedBackground)
                .overlay {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else if hasFailed {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .clipped()
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .task(id: item.attachment.id) { await loadImage() }
        .accessibilityLabel("Review \(item.attachment.name)")
    }

    private func loadImage() async {
        if let source = item.attachment.previewURL,
           let preview = await AvatarImageLoader.image(from: source) {
            guard !Task.isCancelled else { return }
            image = preview
            return
        }

        guard let url = await model.prepareAttachmentForPresentation(item.attachment) else {
            guard !Task.isCancelled else { return }
            hasFailed = true
            return
        }
        let loaded = await Task.detached(priority: .utility) {
            UIImage(contentsOfFile: url.path)
        }.value
        guard !Task.isCancelled else { return }
        image = loaded
        hasFailed = loaded == nil
    }
}

private struct CloudArtifactRow: View {
    let artifact: CloudSessionArtifactActivity

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: artifact.kind == "document" ? "doc.text.fill" : "shippingbox.fill")
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(width: 38, height: 38)
                .background(KordiTheme.signalBlue.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(artifact.name).font(.headline)
                Text(artifact.summary.nonEmpty ?? artifact.path)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
    }
}

private struct SessionDetailFileRow: View {
    let item: SessionDetailAttachment
    let isLoading: Bool
    let onReview: () -> Void
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.attachment.kind == .image ? "photo.fill" : "doc.text.fill")
                .foregroundStyle(item.attachment.kind == .image ? KordiTheme.signalBlue : .secondary)
                .frame(width: 38, height: 38)
                .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.attachment.name).font(.headline).lineLimit(1)
                Text([item.attachment.formatLabel, item.attachment.sizeLabel].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                Text("Shared by \(item.message.authorName)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            if isLoading {
                ProgressView().frame(width: 44, height: 44)
            } else {
                Menu {
                    Button(action: onReview) { Label("Review", systemImage: "eye") }
                    Button(action: onDownload) { Label("Download / Save to Files", systemImage: "arrow.down.circle") }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .contentShape(Rectangle())
                .accessibilityLabel("More actions for \(item.attachment.name)")
            }
        }
        .padding(.vertical, 3)
    }
}

private struct SessionTaskRow: View {
    let task: CloudSessionTaskActivity

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(task.title).font(.headline)
                if let summary = task.summary.nonEmpty {
                    Text(summary).font(.subheadline).foregroundStyle(.secondary)
                }
                Text(task.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
            }
        }
        .padding(.vertical, 4)
    }

    private var symbol: String {
        switch task.status.lowercased() {
        case "completed", "done": "checkmark.circle.fill"
        case "failed", "blocked": "exclamationmark.triangle.fill"
        default: "circle.dotted"
        }
    }

    private var tint: Color {
        switch task.status.lowercased() {
        case "completed", "done": .green
        case "failed", "blocked": .orange
        default: KordiTheme.signalBlue
        }
    }
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
