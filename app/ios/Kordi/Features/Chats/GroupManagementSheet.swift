import SwiftUI

struct GroupManagementPresentation: Identifiable {
    let id = UUID()
    let space: GroupSpaceSummary
    let startsInInviteMode: Bool
}

/// Row sizes shared by the group Info lists: compact like Settings and Contacts.
private enum GroupInfoMetrics {
    static let avatarSize: CGFloat = 32
    static let rowInsets = EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16)
    static let rowMinHeight: CGFloat = 44
}

struct GroupManagementSheet: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let presentation: GroupManagementPresentation

    @State private var titleDraft: String
    @State private var isEditingName = false
    @FocusState private var isNameFieldFocused: Bool
    @State private var selectedContactIDs = Set<String>()
    @State private var isSaving = false
    @State private var showsManagePage = false
    @State private var confirmsLeave = false
    @State private var isLeaving = false
    @State private var leaveError: String?

    private let inviteSectionID = "group-invite-section"

    init(presentation: GroupManagementPresentation) {
        self.presentation = presentation
        _titleDraft = State(initialValue: presentation.space.displayName)
    }

    private var space: GroupSpaceSummary {
        GroupSpaceCatalog.build(conversations: model.conversations, ownAccountId: model.account?.accountId ?? "")
            .first { $0.id == presentation.space.id } ?? presentation.space
    }

    private var canManage: Bool {
        space.canManage(accountId: model.account?.accountId)
    }

    private var memberIDs: Set<String> {
        space.fullyJoinedParticipantAccountIds
    }

    private var availableContacts: [CloudContact] {
        model.contacts.filter {
            !memberIDs.contains($0.accountId) && isEligibleGroupContact($0)
        }
    }

    private var trimmedTitleDraft: String {
        titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    Section {
                        header
                    }

                    Section {
                        ForEach(space.participants) { participant in
                            participantRow(participant)
                        }
                    } header: {
                        GroupInfoSectionHeader("Participants")
                    }

                    Section {
                        if canManage {
                            GroupInviteLinkRow(space: space)
                                .groupInfoRow()
                        }
                        invitePeopleRows
                    } header: {
                        GroupInfoSectionHeader("Invite people")
                    }
                    .id(inviteSectionID)

                    if canManage {
                        Section {
                            Button {
                                showsManagePage = true
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "slider.horizontal.3")
                                        .frame(width: GroupInfoMetrics.avatarSize)
                                        .foregroundStyle(.secondary)
                                    Text("Manage")
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .groupInfoRow()
                            .accessibilityIdentifier("group-manage-row")
                        }
                    } else {
                        Section {
                            GroupLeaveRow(isLeaving: isLeaving) { confirmsLeave = true }
                        }
                    }
                }
                .listSectionSpacing(.compact)
                .environment(\.defaultMinListRowHeight, GroupInfoMetrics.rowMinHeight)
                .onAppear {
                    if ProcessInfo.processInfo.arguments.contains("--preview-group-manage-page"), canManage {
                        showsManagePage = true
                    }
                    if ProcessInfo.processInfo.arguments.contains("--preview-group-leave"), !canManage {
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(700))
                            confirmsLeave = true
                        }
                    }
                    guard presentation.startsInInviteMode else { return }
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(.easeInOut(duration: 0.25)) {
                            proxy.scrollTo(inviteSectionID, anchor: .top)
                        }
                    }
                }
            }
            .navigationDestination(isPresented: $showsManagePage) {
                GroupManagePage(space: space) { dismiss() }
            }
            .navigationTitle("Group Info")
            .navigationBarTitleDisplayMode(.inline)
            .groupLeaveConfirmation(
                name: space.displayName,
                isPresented: $confirmsLeave,
                error: $leaveError,
                onLeave: leaveGroup
            )
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            if canManage {
                GroupAvatarPicker(participants: space.participants, imageSource: space.avatarSource,
                                  size: 44, disabled: isSaving) { image in
                    guard await model.updateGroupAvatar(space, dataURL: image) else {
                        throw GroupAvatarPickerError(message: model.errorMessage ?? "Could not update the group image.")
                    }
                }
            } else {
                GroupAvatarStack(participants: space.participants, size: 44, imageSource: space.avatarSource)
            }
            VStack(alignment: .leading, spacing: 1) {
                if isEditingName {
                    HStack(spacing: 8) {
                        TextField("Group name", text: $titleDraft)
                            .font(.headline)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.done)
                            .focused($isNameFieldFocused)
                            .onSubmit(renameGroup)
                            .accessibilityIdentifier("group-name-field")
                        Button(action: renameGroup) {
                            if isSaving {
                                ProgressView()
                            } else {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(chatTheme.accent)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(isSaving || trimmedTitleDraft.isEmpty || trimmedTitleDraft == space.displayName)
                        .accessibilityLabel("Save name")
                    }
                } else if canManage {
                    Button {
                        titleDraft = space.displayName
                        isEditingName = true
                        isNameFieldFocused = true
                    } label: {
                        HStack(spacing: 5) {
                            Text(space.displayName)
                                .font(.headline)
                                .foregroundStyle(.primary)
                            Image(systemName: "pencil")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Rename \(space.displayName)")
                } else {
                    Text(space.displayName)
                        .font(.headline)
                }
                Text("\(space.participants.count) participants · \(space.sessions.count) \(space.sessions.count == 1 ? "session" : "sessions")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--preview-group-rename"), canManage {
                isEditingName = true
            }
        }
    }

    private func participantRow(_ participant: CloudGroupParticipant) -> some View {
        HStack(spacing: 12) {
            IdentityAvatar(
                name: participant.displayName,
                imageSource: participant.avatarUrl,
                kind: .person,
                size: GroupInfoMetrics.avatarSize,
                seed: participant.accountId
            )
            VStack(alignment: .leading, spacing: 0) {
                Text(participant.displayName)
                    .font(.body)
                    .lineLimit(1)
                if let role = memberRole(participant) {
                    Text(role)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            Spacer(minLength: 8)
            if participant.accountId == model.account?.accountId {
                Text("You")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .groupInfoRow()
    }

    @ViewBuilder
    private var invitePeopleRows: some View {
        if availableContacts.isEmpty {
            Text("Everyone in your contacts is already here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .groupInfoRow()
        } else {
            ForEach(availableContacts) { contact in
                Button {
                    toggleContact(contact.accountId)
                } label: {
                    HStack(spacing: 12) {
                        IdentityAvatar(
                            name: contact.preferredName,
                            imageSource: contact.avatarUrl,
                            kind: .person,
                            size: GroupInfoMetrics.avatarSize,
                            seed: contact.accountId
                        )
                        Text(contact.preferredName)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                        Spacer(minLength: 8)
                        Image(systemName: selectedContactIDs.contains(contact.accountId) ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(selectedContactIDs.contains(contact.accountId) ? chatTheme.accent : Color(uiColor: .tertiaryLabel))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .groupInfoRow()
            }

            if !selectedContactIDs.isEmpty || isSaving {
                Button {
                    inviteSelectedContacts()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "person.badge.plus")
                            .frame(width: GroupInfoMetrics.avatarSize)
                        Text("Invite \(selectedContactIDs.count) selected")
                            .fontWeight(.semibold)
                        Spacer()
                        if isSaving { ProgressView() }
                    }
                    .foregroundStyle(chatTheme.accent)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isSaving)
                .groupInfoRow()
            }
        }
    }

    /// Ordinary members carry no label; the trailing "You" already marks this account.
    private func memberRole(_ participant: CloudGroupParticipant) -> String? {
        switch participant.role?.lowercased() {
        case "admin", "owner": "Admin"
        default: nil
        }
    }

    private func toggleContact(_ accountID: String) {
        if selectedContactIDs.contains(accountID) {
            selectedContactIDs.remove(accountID)
        } else {
            selectedContactIDs.insert(accountID)
        }
    }

    private func renameGroup() {
        let title = trimmedTitleDraft
        guard !title.isEmpty, title != space.displayName, !isSaving else {
            if title == space.displayName { isEditingName = false }
            return
        }
        isSaving = true
        Task {
            let didRename = await model.renameGroupSpace(space, to: title)
            isSaving = false
            if didRename { isEditingName = false }
        }
    }

    private func leaveGroup() {
        isLeaving = true
        Task {
            let failure = await model.leaveGroupSpace(space)
            isLeaving = false
            if let failure { leaveError = failure } else { dismiss() }
        }
    }

    private func inviteSelectedContacts() {
        let contacts = availableContacts.filter { selectedContactIDs.contains($0.accountId) }
        guard !contacts.isEmpty else { return }
        isSaving = true
        Task {
            let didInvite = await model.inviteContacts(contacts, to: space)
            isSaving = false
            if didInvite { dismiss() }
        }
    }
}

private struct GroupInfoSectionHeader: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .textCase(nil)
    }
}

private extension View {
    func groupInfoRow() -> some View {
        listRowInsets(GroupInfoMetrics.rowInsets)
            .frame(minHeight: GroupInfoMetrics.rowMinHeight - 12)
    }
}

/// The group's one reusable invitation link as a single row: Create link when
/// there is none; otherwise the short link with Copy, Share and a menu
/// holding Reset link.
private struct GroupInviteLinkRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    let space: GroupSpaceSummary

    @State private var link: GroupInviteLinkInfo?
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var copied = false
    @State private var confirmsReset = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "link")
                .font(.body.weight(.medium))
                .foregroundStyle(link == nil ? chatTheme.accent : Color.secondary)
                .frame(width: GroupInfoMetrics.avatarSize)
            if let url = link?.inviteUrl?.nonEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Text(copied ? "Link copied" : Self.shortLink(url))
                        .font(.body)
                        .foregroundStyle(copied ? chatTheme.accent : .primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let expiry = expiryLabel {
                        Text(expiry)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Spacer(minLength: 4)
                Button {
                    UIPasteboard.general.string = url
                    withAnimation(.easeOut(duration: 0.15)) { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation(.easeOut(duration: 0.15)) { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(copied ? "Link copied" : "Copy link")
                if let shareURL = URL(string: url) {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up")
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Share link")
                }
                Menu {
                    Button("Reset link", systemImage: "arrow.counterclockwise", role: .destructive) {
                        confirmsReset = true
                    }
                } label: {
                    Image(systemName: isWorking ? "hourglass" : "ellipsis")
                        .frame(width: 28, height: 32)
                }
                .disabled(isWorking)
                .accessibilityLabel("More link actions")
            } else {
                Button {
                    request(reset: false)
                } label: {
                    HStack {
                        Text("Create link")
                            .foregroundStyle(chatTheme.accent)
                        Spacer()
                        if isLoading || isWorking { ProgressView() }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isLoading || isWorking)
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            }
        }
        .task(id: space.preferenceId) {
            if let active = await model.activeGroupInviteLink(space) { link = active }
            isLoading = false
            if link == nil, ProcessInfo.processInfo.arguments.contains("--preview-group-link") {
                request(reset: false)
            }
        }
        .alert("Reset link?", isPresented: $confirmsReset) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) { request(reset: true) }
        } message: {
            Text("The current link will stop working.")
        }
    }

    /// "kordi.ai/g/…AbC4": the host and the end of the token.
    static func shortLink(_ url: String) -> String {
        guard let components = URLComponents(string: url), let host = components.host else { return url }
        let parts = components.path.split(separator: "/")
        guard parts.count == 2, let token = parts.last, token.count > 6 else {
            return host + components.path
        }
        return "\(host)/\(parts[0])/…\(token.suffix(4))"
    }

    private var expiryLabel: String? {
        guard let date = link?.expiryDate else { return nil }
        return "Expires \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    private func request(reset: Bool) {
        isWorking = true
        Task {
            if let next = await model.groupInviteLink(space, reset: reset) {
                link = next
                copied = false
            }
            isWorking = false
        }
    }
}

/// The admin-only second level of group Info.
private struct GroupManagePage: View {
    @EnvironmentObject private var model: AppModel
    let space: GroupSpaceSummary
    let onDissolved: () -> Void

    @State private var confirmsDissolve = false
    @State private var isDissolving = false
    @State private var confirmsLeave = false
    @State private var isLeaving = false
    @State private var leaveError: String?

    var body: some View {
        List {
            Section {
                Button(role: .destructive) {
                    confirmsDissolve = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "circle.slash")
                            .frame(width: GroupInfoMetrics.avatarSize)
                        Text("Dissolve group")
                        Spacer()
                        if isDissolving { ProgressView() }
                    }
                    .contentShape(Rectangle())
                }
                .disabled(isDissolving)
                .groupInfoRow()
                .accessibilityIdentifier("group-dissolve-row")
            } footer: {
                Text("Removes everyone and deletes every channel.")
            }
            Section {
                GroupLeaveRow(isLeaving: isLeaving) { confirmsLeave = true }
            } footer: {
                Text("Another admin has to stay in the group.")
            }
        }
        .groupLeaveConfirmation(
            name: space.displayName,
            isPresented: $confirmsLeave,
            error: $leaveError,
            onLeave: leave
        )
        .listSectionSpacing(.compact)
        .environment(\.defaultMinListRowHeight, GroupInfoMetrics.rowMinHeight)
        .navigationTitle("Manage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard ProcessInfo.processInfo.arguments.contains("--preview-group-dissolve") else { return }
            try? await Task.sleep(for: .milliseconds(900))
            confirmsDissolve = true
        }
        .confirmationDialog(
            "Dissolve \(space.displayName)?",
            isPresented: $confirmsDissolve,
            titleVisibility: .visible
        ) {
            Button("Dissolve group", role: .destructive) { dissolve() }
        } message: {
            Text("Everyone is removed and its messages are deleted.")
        }
    }

    private func leave() {
        isLeaving = true
        Task {
            let failure = await model.leaveGroupSpace(space)
            isLeaving = false
            if let failure { leaveError = failure } else { onDissolved() }
        }
    }

    private func dissolve() {
        isDissolving = true
        Task {
            let didDissolve = await model.dissolveGroupSpace(space)
            isDissolving = false
            if didDissolve { onDissolved() }
        }
    }
}

/// "Leave group": the caller leaves every channel of the group.
private struct GroupLeaveRow: View {
    let isLeaving: Bool
    let action: () -> Void

    var body: some View {
        Button(role: .destructive, action: action) {
            HStack(spacing: 12) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .frame(width: GroupInfoMetrics.avatarSize)
                Text("Leave group")
                Spacer()
                if isLeaving { ProgressView() }
            }
            .contentShape(Rectangle())
        }
        .disabled(isLeaving)
        .groupInfoRow()
        .accessibilityIdentifier("group-leave-row")
    }
}

private extension View {
    func groupLeaveConfirmation(
        name: String,
        isPresented: Binding<Bool>,
        error: Binding<String?>,
        onLeave: @escaping () -> Void
    ) -> some View {
        confirmationDialog("Leave \(name)?", isPresented: isPresented, titleVisibility: .visible) {
            Button("Leave group", role: .destructive, action: onLeave)
        } message: {
            Text("You'll stop getting its messages.")
        }
        .alert(
            "Could not leave",
            isPresented: Binding(get: { error.wrappedValue != nil }, set: { if !$0 { error.wrappedValue = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error.wrappedValue ?? "")
        }
    }
}
