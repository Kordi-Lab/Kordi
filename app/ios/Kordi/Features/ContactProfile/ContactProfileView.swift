import SwiftUI
import UIKit

/// Where the profile appears: a sheet from Contacts and avatars, or a page
/// pushed from the header of the direct chat with that person.
enum ContactProfileStyle {
    case sheet
    case page(conversation: ConversationSummary, onBack: (() -> Void)?)
}

/// The contact profile sheet (issue #1945): header and tiles from the contact
/// row right away, sections once `GET /v1/cloud/contacts/{id}/profile` answers.
struct ContactProfileView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @Environment(\.dismiss) private var dismiss
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale
    let subject: ContactProfileSubject
    /// Opens a chat behind the sheet; the presenter dismisses the sheet first.
    let onOpenConversation: (ConversationSummary) -> Void
    let style: ContactProfileStyle
    @StateObject private var profileModel: ContactProfileModel
    @State private var route: ContactProfileRoute?
    @State private var callStartTask: Task<Void, Never>?
    @State private var callError: String?
    @State private var showsShare = false
    @State private var ownerSubject: ContactProfileSubject?
    @State private var isMuting = false
    @State private var confirmsDelete = false
    @State private var deleteError: String?

    init(
        subject: ContactProfileSubject,
        profileModel: @autoclosure @escaping () -> ContactProfileModel,
        style: ContactProfileStyle = .sheet,
        onOpenConversation: @escaping (ConversationSummary) -> Void
    ) {
        self.subject = subject
        self.style = style
        self.onOpenConversation = onOpenConversation
        _profileModel = StateObject(wrappedValue: profileModel())
    }

    private var presentation: ContactProfilePresentation {
        ContactProfilePresentation(
            subject: subject,
            profile: profileModel.profile,
            isFallback: profileModel.isFallback,
            selfAccountId: model.account?.accountId,
            presence: model.contactPresenceByAccountID[subject.accountId],
            canDelete: profileModel.canDelete,
            isPage: pageConversation != nil,
            memoryAvailable: MemoryPresentation.isAvailable(model.memoryCapabilities),
            localShared: sharedConversation.flatMap(model.contactProfileSharedItems(for:))?.counts
        )
    }

    private var pageConversation: ConversationSummary? {
        if case let .page(conversation, _) = style { return conversation }
        return nil
    }

    private var directConversation: ConversationSummary? {
        pageConversation ?? model.directConversation(withAccountId: subject.accountId)
    }

    /// The chat whose photos, files and links the rows count.
    private var sharedConversation: ConversationSummary? {
        pageConversation ?? model.contactProfileSharedConversation(for: subject)
    }

    private var isMuted: Bool {
        directConversation.map { model.mutedSessionIds.contains($0.sessionId) } ?? false
    }

    private var tint: Color {
        switch presentation.kind {
        case .person: chatTheme.accent
        case .agent: KordiTheme.agentViolet
        case .system: Color(uiColor: .systemGray)
        }
    }

    var body: some View {
        Group {
            if let pageConversation {
                routedContent
                    .modifier(ContactProfilePageBar())
                    .navigationTitle("")
                    .navigationBarTitleDisplayMode(.inline)
                    .task(id: pageConversation.sessionId) { await model.refreshActiveCall(in: pageConversation) }
            } else {
                NavigationStack {
                    routedContent.toolbar(.hidden, for: .navigationBar)
                }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
        }
        .task(id: subject.accountId) { await profileModel.load() }
        .task(id: sharedConversation?.id) {
            if let sharedConversation { await model.loadContactProfileHistory(for: sharedConversation) }
        }
        .onDisappear { callStartTask?.cancel() }
        .alert(
            "Call unavailable",
            isPresented: Binding(get: { callError != nil }, set: { if !$0 { callError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(callError ?? "")
        }
        .confirmationDialog("Delete contact?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Delete contact", role: .destructive, action: deleteContact)
        } message: {
            Text("They will need approval before messages can reach you again.")
        }
        .alert(
            "Could not delete contact",
            isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(deleteError ?? "")
        }
        .sheet(isPresented: $showsShare) {
            ContactProfileShareSheet(name: presentation.name, kordiId: presentation.kordiId ?? "")
        }
        .sheet(item: $ownerSubject) { owner in
            ContactProfileView(subject: owner, profileModel: model.makeContactProfileModel(for: owner)) { conversation in
                ownerSubject = nil
                open(conversation)
            }
            .id(owner.id)
        }
    }

    private var routedContent: some View {
        content.navigationDestination(item: $route) { route in
            switch route {
            case .groups:
                ContactProfileGroupsList(groups: presentation.shared?.groups ?? [], onOpen: openGroup)
            case let .details(conversation):
                SessionDetailView(conversation: conversation)
            case let .focused(conversation, tab):
                SessionDetailView(conversation: conversation, focusedTab: tab)
            case let .shared(page, conversation):
                ContactProfileSharedPageView(page: page, conversation: conversation)
            case let .chat(conversation):
                ConversationView(conversation: conversation)
                    .task { _ = await model.restoreConversationIfNeeded(conversation) }
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                tiles
                    .padding(.horizontal, ContactProfileMetrics.gutter)
                    .padding(.top, 24)
                infoRows
                    .padding(.top, 24)
                if presentation.showsSharedSection {
                    ContactProfileSharedSection(presentation: presentation, onOpen: openSharedRow)
                }
                if let ground = presentation.commonGround {
                    ContactProfileCommonGroundSection(ground: ground)
                }
                if presentation.showsDelete {
                    ContactProfileDeleteRow { confirmsDelete = true }
                        .disabled(profileModel.isDeleting)
                }
            }
            .padding(.top, pageConversation == nil ? 52 : 12)
            .padding(.bottom, 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Inside the scroll content, so it scrolls away with the header
            // and no row can pass underneath it.
            .overlay(alignment: .topTrailing) {
                if pageConversation == nil { closeButton }
            }
            .animation(.easeOut(duration: 0.2), value: profileModel.profile)
        }
        .id(subject.accountId)
        .background(alignment: .top) { wash }
        .background(Color(uiColor: .systemBackground))
    }

    private var wash: some View {
        RadialGradient(
            colors: [tint.opacity(0.2), tint.opacity(0.09), .clear],
            center: .top,
            startRadius: 0,
            endRadius: 380
        )
        .frame(height: 380)
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private var closeButton: some View {
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
        .padding(.trailing, 10)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("contact-profile-close")
    }

    private var header: some View {
        VStack(spacing: 0) {
            IdentityAvatar(
                name: presentation.name,
                imageSource: presentation.avatarUrl,
                kind: presentation.kind == .agent ? .agent : .person,
                size: 96,
                seed: subject.accountId,
                cornerRadius: 48
            )
            .overlay(alignment: .bottomTrailing) {
                if presentation.isOnline {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 16, height: 16)
                        .overlay { Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2.5) }
                        .offset(x: -4, y: -4)
                        .accessibilityHidden(true)
                }
            }
            Text(presentation.name)
                .font(.title2.weight(.semibold))
                .lineLimit(1)
                .padding(.top, 14)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(presentation.statusLine(now: context.date, calendar: calendar, locale: locale))
                    .font(.subheadline)
                    .foregroundStyle(presentation.statusTone == .online ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, ContactProfileMetrics.gutter)
        .accessibilityElement(children: .combine)
    }

    private var tiles: some View {
        HStack(spacing: 8) {
            ForEach(presentation.tiles) { tile in
                tileView(tile)
            }
        }
    }

    @ViewBuilder
    private func tileView(_ tile: ContactProfileTile) -> some View {
        switch tile {
        case .message:
            ContactProfileTileButton(title: "Message", systemImage: "message", action: openDirectOrAgentChat)
        case .mute:
            ContactProfileTileButton(
                title: isMuted ? "Unmute" : "Mute",
                systemImage: isMuted ? "bell.slash" : "bell",
                action: toggleMute
            )
            .disabled(directConversation == nil || isMuting)
        case .share:
            ContactProfileTileButton(title: "Share", systemImage: "square.and.arrow.up") { showsShare = true }
                .disabled(presentation.kordiId == nil)
        case .call:
            ContactProfileTileButton(title: "Call", systemImage: "phone") { startOrJoinCall(kind: .voice) }
                .disabled(callCoordinator.isStartingCall)
        case .video:
            ContactProfileTileButton(title: "Video", systemImage: "video") { startOrJoinCall(kind: .video) }
                .disabled(callCoordinator.isStartingCall)
        case .settings:
            ContactProfileTileButton(title: "Settings", systemImage: "gearshape", action: openOwnAgentSettings)
                .disabled(ownAgentConversation == nil)
        case .more:
            Menu {
                if presentation.isOwnAgent {
                    Button("Share", systemImage: "square.and.arrow.up") {}.disabled(true)
                } else {
                    if presentation.isPage {
                        Button("Share", systemImage: "square.and.arrow.up") { showsShare = true }
                            .disabled(presentation.kordiId == nil)
                    }
                    Button("Block", systemImage: "nosign") {}.disabled(true)
                    Button("Report", systemImage: "flag") {}.disabled(true)
                    Divider()
                    if presentation.offersDelete {
                        Button("Delete contact", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                            .disabled(!presentation.canDelete || profileModel.isDeleting)
                    }
                }
            } label: {
                ContactProfileTileLabel(title: "More", systemImage: "ellipsis")
            }
            .accessibilityLabel("More")
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(infoRowItems.enumerated()), id: \.element) { index, item in
                VStack(alignment: .leading, spacing: 0) {
                    if index > 0 { ContactProfileDivider() }
                    infoRow(item)
                }
            }
        }
    }

    private enum InfoRow: Hashable { case kordiId, about, type, theirAgent, owner, since }

    private var infoRowItems: [InfoRow] {
        var rows: [InfoRow] = []
        if presentation.showsKordiId { rows.append(.kordiId) }
        if presentation.about != nil { rows.append(.about) }
        if presentation.showsType { rows.append(.type) }
        if presentation.theirAgent != nil { rows.append(.theirAgent) }
        if presentation.owner != nil { rows.append(.owner) }
        if presentation.contactSince != nil { rows.append(.since) }
        return rows
    }

    @ViewBuilder
    private func infoRow(_ row: InfoRow) -> some View {
        switch row {
        case .kordiId:
            ContactProfileKordiIdRow(kordiId: presentation.kordiId ?? "")
        case .about:
            ContactProfileInfoRow(value: presentation.about ?? "", caption: "About")
        case .type:
            ContactProfileInfoRow(value: "Agent", caption: "Type")
        case .theirAgent:
            if let agent = presentation.theirAgent {
                let conversation = model.agentConversation(agentId: agent.agentId, accountId: agent.accountId)
                ContactProfilePersonRow(
                    name: CloudDefaultAgentProfile.displayName(agent.displayName, ownerName: presentation.name),
                    caption: "Their agent",
                    avatarUrl: agent.avatarUrl,
                    kind: .agent,
                    seed: agent.agentId,
                    action: conversation.map { target in { open(target) } }
                )
            }
        case .owner:
            if let owner = presentation.owner {
                let name = owner.displayName?.nonEmpty ?? owner.kordiId ?? "Kordi user"
                ContactProfilePersonRow(name: name, caption: "Owner", avatarUrl: owner.avatarUrl, kind: .person, seed: owner.accountId) {
                    ownerSubject = ContactProfileSubject(accountId: owner.accountId, name: name, avatarUrl: owner.avatarUrl, kordiId: owner.kordiId)
                }
            }
        case .since:
            if let since = presentation.contactSince {
                ContactProfileInfoRow(
                    value: ContactProfilePresentation.formattedDay(since, locale: locale, calendar: calendar),
                    caption: "Contact since"
                )
            }
        }
    }

    // MARK: Actions

    private var ownAgentConversation: ConversationSummary? {
        guard presentation.isOwnAgent else { return nil }
        return model.agentConversation(accountId: subject.accountId)
    }

    private func openDirectOrAgentChat() {
        if presentation.kind == .agent {
            if let conversation = model.agentConversation(accountId: subject.accountId) {
                open(conversation)
            }
            return
        }
        openDirectChat()
    }

    private func openDirectChat() {
        if let directConversation { open(directConversation) }
    }

    /// The sheet hands chats to its presenter; the page is already inside the
    /// direct chat, so that chat pops back and any other one is pushed.
    private func open(_ conversation: ConversationSummary) {
        guard case let .page(current, onBack) = style else {
            onOpenConversation(conversation)
            return
        }
        if conversation.id == current.id {
            if let onBack { onBack() } else { dismiss() }
        } else {
            route = .chat(conversation)
        }
    }

    private func openSharedRow(_ row: ContactProfileSharedRow) {
        if let page = row.page {
            if let sharedConversation { route = .shared(page, sharedConversation) }
            return
        }
        switch row {
        case .todo:
            if let pageConversation { route = .focused(pageConversation, .todo) }
        case .memory:
            if let pageConversation { route = .focused(pageConversation, .memory) }
        case .groups:
            if presentation.shared == nil, let pageConversation {
                route = .focused(pageConversation, .groups)
            } else {
                openGroups()
            }
        case .photos, .files, .links:
            break
        }
    }

    /// The same call path as the session details page.
    private func startOrJoinCall(kind: CloudCallKind) {
        guard let conversation = directConversation else { return }
        callStartTask?.cancel()
        callStartTask = Task {
            if let call = model.activeCall(for: conversation) {
                await callCoordinator.join(call, in: conversation)
            } else {
                await callCoordinator.start(conversation: conversation, kind: kind)
            }
            if case .failed(let message) = callCoordinator.phase, callCoordinator.activeCall == nil {
                callError = message
            }
        }
    }

    private func openGroups() {
        let groups = presentation.shared?.groups ?? []
        if groups.count == 1, let group = groups.first {
            openGroup(group)
        } else if groups.count > 1 {
            route = .groups
        }
    }

    private func openGroup(_ group: CloudContactProfile.SharedGroup) {
        Task {
            if let conversation = model.groupConversation(groupSpaceId: group.groupId) {
                open(conversation)
            } else if let conversation = await model.commonGroundConversation(groupSpaceId: group.groupId) {
                open(conversation)
            }
        }
    }

    private func openOwnAgentSettings() {
        if let ownAgentConversation { route = .details(ownAgentConversation) }
    }

    private func deleteContact() {
        Task {
            do {
                try await profileModel.removeContact()
                dismiss()
            } catch {
                deleteError = (error as? CloudAPIError)?.message.nonEmpty ?? "Could not delete this contact."
            }
        }
    }

    private func toggleMute() {
        guard let directConversation, !isMuting else { return }
        isMuting = true
        let muted = !isMuted
        Task {
            _ = await model.setConversationMuted(directConversation, muted: muted)
            isMuting = false
        }
    }
}
