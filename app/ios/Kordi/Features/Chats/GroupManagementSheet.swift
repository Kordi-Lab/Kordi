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

    private var memberIDs: Set<String> {
        presentation.space.fullyJoinedParticipantAccountIds
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
                            GroupAvatarStack(participants: presentation.space.participants, size: 50)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(presentation.space.displayName)
                                    .font(.headline)
                                Text("\(presentation.space.participants.count) participants · \(presentation.space.sessions.count) \(presentation.space.sessions.count == 1 ? "session" : "sessions")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    Section("Group name") {
                        HStack(spacing: 10) {
                            TextField("Group name", text: $titleDraft)
                                .disabled(!presentation.space.canManage(accountId: model.account?.accountId))
                            Button("Rename") { renameGroup() }
                                .fontWeight(.semibold)
                                .disabled(
                                    isSaving
                                    || titleDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    || titleDraft.trimmingCharacters(in: .whitespacesAndNewlines) == presentation.space.displayName
                                    || !presentation.space.canManage(accountId: model.account?.accountId)
                                )
                        }
                    }

                    Section("Participants") {
                        ForEach(presentation.space.participants) { participant in
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
            let didRename = await model.renameGroupSpace(presentation.space, to: titleDraft)
            isSaving = false
            if didRename { dismiss() }
        }
    }

    private func inviteSelectedContacts() {
        let contacts = availableContacts.filter { selectedContactIDs.contains($0.accountId) }
        guard !contacts.isEmpty else { return }
        isSaving = true
        Task {
            let didInvite = await model.inviteContacts(contacts, to: presentation.space)
            isSaving = false
            if didInvite { dismiss() }
        }
    }
}

struct GroupMemberInviteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var model: AppModel
    let space: GroupSpaceSummary

    @State private var selectedContactIDs = Set<String>()
    @State private var isSaving = false
    @State private var searchText = ""
    @State private var completedMemberCount: Int?

    private var memberIDs: Set<String> {
        space.fullyJoinedParticipantAccountIds
    }

    private var eligibleContactItems: [GroupInviteContactItem] {
        model.contacts
            .filter {
                !memberIDs.contains($0.accountId) && isEligibleGroupContact($0)
            }
            .map(GroupInviteContactItem.init)
            .sorted {
                $0.sortKey.localizedCaseInsensitiveCompare($1.sortKey) == .orderedAscending
            }
    }

    private var filteredContactItems: [GroupInviteContactItem] {
        guard !searchText.isEmpty else { return eligibleContactItems }
        return eligibleContactItems.filter {
            $0.contact.preferredName.localizedCaseInsensitiveContains(searchText)
                || $0.contact.kordiId?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    private var contactSections: [GroupInviteContactSection] {
        Dictionary(grouping: filteredContactItems, by: \.sectionTitle)
            .map { GroupInviteContactSection(title: $0.key, contacts: $0.value) }
            .sorted { lhs, rhs in
                if lhs.title == "#" { return false }
                if rhs.title == "#" { return true }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
    }

    private var listRows: [GroupInviteListRow] {
        contactSections.flatMap { section in
            [.section(section.title)] + section.contacts.map(GroupInviteListRow.contact)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    if contactSections.isEmpty {
                        ContentUnavailableView(
                            searchText.isEmpty ? "No contacts to add" : "No contacts found",
                            systemImage: searchText.isEmpty ? "person.badge.plus" : "magnifyingglass",
                            description: Text(
                                searchText.isEmpty
                                    ? "All eligible contacts are already in this group."
                                    : "Try another name or Kordi ID."
                            )
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    } else {
                        ForEach(listRows) { row in
                            GroupInviteListRowContent(
                                row: row,
                                selectedContactIDs: selectedContactIDs,
                                onToggle: toggleContact
                            )
                            .listRowInsets(row.insets)
                            .listRowSeparator(row.showsSeparator ? .visible : .hidden, edges: .bottom)
                            .id(row.id)
                        }
                    }
                }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, 1)
                .scrollContentBackground(.hidden)
                .background(Color(uiColor: .systemBackground))
                .scrollDismissesKeyboard(.interactively)
                .overlay(alignment: .topTrailing) {
                    if searchText.isEmpty, contactSections.count > 1 {
                        GroupInviteAlphabetIndex(sections: contactSections) { sectionID in
                            withAnimation(.snappy(duration: 0.2)) {
                                proxy.scrollTo(sectionID, anchor: .top)
                            }
                        }
                        .padding(.top, 12)
                    }
                }
            }
            .searchable(
                text: $searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search contacts or Kordi IDs"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Add members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .disabled(isSaving)
                    .accessibilityLabel("Cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        inviteSelectedContacts()
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Image(systemName: "checkmark")
                        }
                    }
                    .disabled(selectedContactIDs.isEmpty || isSaving)
                    .accessibilityLabel(
                        selectedContactIDs.isEmpty
                            ? "Add members"
                            : "Add \(selectedContactIDs.count) members"
                    )
                }
            }
        }
        .disabled(completedMemberCount != nil)
        .overlay {
            if let completedMemberCount {
                GroupInviteCompletionView(
                    memberCount: completedMemberCount,
                    reduceMotion: reduceMotion
                )
                .transition(
                    reduceMotion
                        ? .opacity
                        : .scale(scale: 0.9).combined(with: .opacity)
                )
            }
        }
        .animation(
            reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.34, dampingFraction: 0.84),
            value: completedMemberCount
        )
        .sensoryFeedback(.selection, trigger: selectedContactIDs)
        .sensoryFeedback(.success, trigger: completedMemberCount)
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .interactiveDismissDisabled(isSaving || completedMemberCount != nil)
    }

    private func toggleContact(_ accountID: String) {
        let animation: Animation = reduceMotion
            ? .easeOut(duration: 0.1)
            : .snappy(duration: 0.2)
        withAnimation(animation) {
            if selectedContactIDs.contains(accountID) {
                selectedContactIDs.remove(accountID)
            } else {
                selectedContactIDs.insert(accountID)
            }
        }
    }

    private func inviteSelectedContacts() {
        let contacts = eligibleContactItems
            .map(\.contact)
            .filter { selectedContactIDs.contains($0.accountId) }
        guard !contacts.isEmpty else { return }
        isSaving = true
        Task {
            let didInvite = await model.inviteContacts(contacts, to: space)
            guard didInvite else {
                isSaving = false
                return
            }

            withAnimation(
                reduceMotion
                    ? .easeOut(duration: 0.12)
                    : .spring(response: 0.34, dampingFraction: 0.84)
            ) {
                isSaving = false
                completedMemberCount = contacts.count
            }
            try? await Task.sleep(for: reduceMotion ? .milliseconds(250) : .milliseconds(700))
            dismiss()
        }
    }

}

private struct GroupInviteContactItem: Identifiable {
    let contact: CloudContact
    let sortKey: String
    let sectionTitle: String

    var id: CloudContact.ID { contact.id }

    init(_ contact: CloudContact) {
        self.contact = contact
        let transliteratedName = contact.preferredName
            .applyingTransform(.toLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false)
        let sortKey = transliteratedName?.nonEmpty ?? contact.preferredName
        self.sortKey = sortKey

        if let scalar = sortKey.uppercased().unicodeScalars.first,
           (65 ... 90).contains(scalar.value) {
            sectionTitle = String(scalar)
        } else {
            sectionTitle = "#"
        }
    }
}

private struct GroupInviteContactSection: Identifiable {
    let title: String
    let contacts: [GroupInviteContactItem]

    var id: String { title }

    var scrollID: String { "section:\(title)" }
}

private enum GroupInviteListRow: Identifiable {
    case section(String)
    case contact(GroupInviteContactItem)

    var id: String {
        switch self {
        case let .section(title):
            "section:\(title)"
        case let .contact(item):
            "contact:\(item.id)"
        }
    }

    var insets: EdgeInsets {
        switch self {
        case .section:
            EdgeInsets(top: 7, leading: 16, bottom: 2, trailing: 28)
        case .contact:
            EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 28)
        }
    }

    var showsSeparator: Bool {
        if case .contact = self { return true }
        return false
    }
}

private struct GroupInviteListRowContent: View {
    let row: GroupInviteListRow
    let selectedContactIDs: Set<String>
    let onToggle: (String) -> Void

    var body: some View {
        Group {
            switch row {
            case let .section(title):
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 18)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case let .contact(item):
                contactButton(item.contact)
            }
        }
    }

    private func contactButton(_ contact: CloudContact) -> some View {
        let isSelected = selectedContactIDs.contains(contact.accountId)
        return Button {
            onToggle(contact.accountId)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? KordiTheme.signalBlue : Color.secondary)
                    .contentTransition(.symbolEffect(.replace))
                IdentityAvatar(
                    name: contact.preferredName,
                    imageSource: contact.avatarUrl.nonEmpty,
                    kind: .person,
                    size: 38,
                    seed: contact.accountId
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(contact.preferredName)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let kordiID = contact.kordiId.nonEmpty {
                        Text("@\(kordiID)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(contact.preferredName)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct GroupInviteCompletionView: View {
    let memberCount: Int
    let reduceMotion: Bool

    @State private var isSettled = false

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .opacity(0.96)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                Image(systemName: "checkmark")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(KordiTheme.signalBlue, in: Circle())
                    .scaleEffect(reduceMotion || isSettled ? 1 : 0.78)
                    .opacity(reduceMotion || isSettled ? 1 : 0.25)

                Text(memberCount == 1 ? "Member added" : "\(memberCount) members added")
                    .font(.title3.weight(.semibold))

                Text("The group is ready for everyone.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
            .padding(24)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(memberCount == 1 ? "Member added" : "\(memberCount) members added")
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) {
                isSettled = true
            }
        }
    }
}

private struct GroupInviteAlphabetIndex: View {
    let sections: [GroupInviteContactSection]
    let onSelect: (GroupInviteContactSection.ID) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(sections) { section in
                Button {
                    onSelect(section.scrollID)
                } label: {
                    Text(section.title)
                        .font(.caption2.weight(.bold))
                        .frame(width: 24)
                        .frame(minHeight: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Jump to \(section.title)")
            }
        }
        .foregroundStyle(KordiTheme.signalBlue)
        .padding(.vertical, 6)
        .padding(.trailing, 2)
    }
}

private func isEligibleGroupContact(_ contact: CloudContact) -> Bool {
    !KordiSupportIdentity.matches(name: contact.preferredName, seed: contact.accountId)
}
