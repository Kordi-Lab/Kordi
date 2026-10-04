import SwiftUI

struct GroupManagementPresentation: Identifiable {
    let id = UUID()
    let space: GroupSpaceSummary
    let startsInInviteMode: Bool
}

struct GroupManagementSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let presentation: GroupManagementPresentation

    @State private var titleDraft: String
    @State private var selectedContactIDs = Set<String>()
    @State private var isSaving = false

    private let inviteSectionID = "group-invite-section"

    init(presentation: GroupManagementPresentation) {
        self.presentation = presentation
        _titleDraft = State(initialValue: presentation.space.displayName)
    }

    private var space: GroupSpaceSummary {
        GroupSpaceCatalog.build(conversations: model.conversations, ownAccountId: model.account?.accountId ?? "")
            .first { $0.id == presentation.space.id } ?? presentation.space
    }

    private var memberIDs: Set<String> {
        space.fullyJoinedParticipantAccountIds
    }

    private var availableContacts: [CloudContact] {
        model.contacts.filter {
            !memberIDs.contains($0.accountId) && isEligibleGroupContact($0)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    Section {
                        HStack(spacing: 13) {
                            if space.canManage(accountId: model.account?.accountId) {
                                GroupAvatarPicker(participants: space.participants, imageSource: space.avatarSource,
                                                  size: 50, disabled: isSaving) { image in
                                    guard await model.updateGroupAvatar(space, dataURL: image) else {
                                        throw GroupAvatarPickerError(message: model.errorMessage ?? "Could not update the group image.")
                                    }
                                }
                            } else {
                                GroupAvatarStack(participants: space.participants, size: 50, imageSource: space.avatarSource)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(space.displayName)
                                    .font(.headline)
                                Text("\(space.participants.count) participants · \(space.sessions.count) \(space.sessions.count == 1 ? "session" : "sessions")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    Section("Group name") {
                        HStack(spacing: 10) {
                            TextField("Group name", text: $titleDraft)
                                .disabled(!space.canManage(accountId: model.account?.accountId))
                            Button("Rename") { renameGroup() }
                                .fontWeight(.semibold)
                                .disabled(
                                    isSaving
                                    || titleDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    || titleDraft.trimmingCharacters(in: .whitespacesAndNewlines) == space.displayName
                                    || !space.canManage(accountId: model.account?.accountId)
                                )
                        }
                    }

                    Section("Participants") {
                        ForEach(space.participants) { participant in
                            HStack(spacing: 11) {
                                IdentityAvatar(
                                    name: participant.displayName,
                                    imageSource: participant.avatarUrl,
                                    kind: .person,
                                    size: 38,
                                    seed: participant.accountId
                                )
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(participant.displayName)
                                        .font(.body.weight(.medium))
                                    Text(memberRole(participant))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 8)
                                if participant.accountId == model.account?.accountId {
                                    Text("You")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }

                    Section("Invite people") {
                        if availableContacts.isEmpty {
                            ContentUnavailableView(
                                "No contacts to invite",
                                systemImage: "person.badge.plus",
                                description: Text("Everyone in your approved contacts is already in this group.")
                            )
                        } else {
                            ForEach(availableContacts) { contact in
                                Button {
                                    toggleContact(contact.accountId)
                                } label: {
                                    HStack(spacing: 11) {
                                        IdentityAvatar(
                                            name: contact.preferredName,
                                            imageSource: contact.avatarUrl,
                                            kind: .person,
                                            size: 38,
                                            seed: contact.accountId
                                        )
                                        Text(contact.preferredName)
                                            .font(.body.weight(.medium))
                                            .foregroundStyle(.primary)
                                        Spacer(minLength: 8)
                                        Image(systemName: selectedContactIDs.contains(contact.accountId) ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selectedContactIDs.contains(contact.accountId) ? KordiTheme.signalBlue : Color.secondary)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }

                            Button {
                                inviteSelectedContacts()
                            } label: {
                                HStack {
                                    Spacer()
                                    if isSaving {
                                        ProgressView()
                                    } else {
                                        Label(
                                            selectedContactIDs.isEmpty
                                                ? "Select people to invite"
                                                : "Invite \(selectedContactIDs.count) selected",
                                            systemImage: "person.badge.plus"
                                        )
                                        .fontWeight(.semibold)
                                    }
                                    Spacer()
                                }
                                .frame(minHeight: 44)
                            }
                            .disabled(selectedContactIDs.isEmpty || isSaving)
                        }
                    }
                    .id(inviteSectionID)
                }
                .onAppear {
                    guard presentation.startsInInviteMode else { return }
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(.easeInOut(duration: 0.25)) {
                            proxy.scrollTo(inviteSectionID, anchor: .top)
                        }
                    }
                }
            }
            .navigationTitle("Group management")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func memberRole(_ participant: CloudGroupParticipant) -> String {
        switch participant.role?.lowercased() {
        case "self": "Member · this account"
        case "admin", "owner": "Admin"
        default: "Member"
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
        isSaving = true
        Task {
            let didRename = await model.renameGroupSpace(space, to: titleDraft)
            isSaving = false
            if didRename { dismiss() }
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
