import SwiftUI

private enum NewChatMode: Equatable {
    case menu
    case contact
    case agent
    case group
    case addContact
}

struct NewChatSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var mode: NewChatMode
    @State private var groupName = ""
    @State private var selectedGroupContactIDs = Set<String>()
    @State private var isCreatingGroup = false

    private let onSelect: (ConversationSummary) -> Void

    init(onSelect: @escaping (ConversationSummary) -> Void) {
        let arguments = ProcessInfo.processInfo.arguments
        let initialMode: NewChatMode = if arguments.contains("--preview-add-contact") {
            .addContact
        } else if arguments.contains("--preview-new-group") {
            .group
        } else {
            .menu
        }
        _mode = State(initialValue: initialMode)
        self.onSelect = onSelect
    }

    private var agentChoices: [AgentSessionSection] {
        AgentSessionPresentationCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? "",
            searchText: searchText
        )
    }

    private var contacts: [ConversationSummary] {
        model.conversations
            .filter { $0.kind == .person && (searchText.isEmpty || matchesSearch($0)) }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    private var groupContacts: [CloudContact] {
        model.contacts
            .filter {
                !KordiSupportIdentity.matches(name: $0.preferredName, seed: $0.accountId)
                    && (
                        searchText.isEmpty
                            || $0.preferredName.localizedCaseInsensitiveContains(searchText)
                            || $0.kordiId?.localizedCaseInsensitiveContains(searchText) == true
                    )
            }
            .sorted { $0.preferredName.localizedCaseInsensitiveCompare($1.preferredName) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch mode {
                case .menu:
                    menuPage
                case .contact:
                    contactPage
                case .agent:
                    agentPage
                case .group:
                    groupPage
                case .addContact:
                    AddContactSearchView(onRequestSent: { dismiss() })
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if mode != .menu {
                        Button {
                            move(to: .menu)
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                    } else {
                        Button("Cancel") { dismiss() }
                    }
                }
                if mode == .group {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isCreatingGroup ? "Creating…" : "Create") {
                            createGroup()
                        }
                        .disabled(selectedGroupContactIDs.count < 2 || isCreatingGroup)
                    }
                }
            }
        }
    }

    private var menuPage: some View {
        List {
            Section {
                Button { move(to: .contact) } label: {
                    NewChatActionRow(
                        symbol: "message.fill",
                        tint: KordiTheme.signalBlue,
                        title: "Chat with contact",
                        detail: "Direct contact conversation"
                    )
                }
                .buttonStyle(.plain)

                Button { move(to: .agent) } label: {
                    NewChatActionRow(
                        symbol: "sparkles",
                        tint: KordiTheme.agentViolet,
                        title: "Chat with agent",
                        detail: "Start with one Kordi agent"
                    )
                }
                .buttonStyle(.plain)

                Button { move(to: .group) } label: {
                    NewChatActionRow(
                        symbol: "person.3.fill",
                        tint: .indigo,
                        title: "Start group",
                        detail: "Stable group with people only"
                    )
                }
                .buttonStyle(.plain)

                Button { move(to: .addContact) } label: {
                    NewChatActionRow(
                        symbol: "person.badge.plus",
                        tint: .green,
                        title: "Add contacts",
                        detail: "Request a private Kordi contact"
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.insetGrouped)
    }

    private var contactPage: some View {
        List {
            if contacts.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No contacts available" : "No contacts found",
                    systemImage: searchText.isEmpty ? "person.2" : "magnifyingglass",
                    description: Text(searchText.isEmpty ? "Add a contact before starting a direct chat." : "Try another name.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                Section("People") {
                    ForEach(contacts) { contact in
                        conversationButton(contact)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Contacts"
        )
    }

    private var agentPage: some View {
        List {
            if agentChoices.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No agents available" : "No agents found",
                    systemImage: searchText.isEmpty ? "sparkles" : "magnifyingglass",
                    description: Text(searchText.isEmpty ? "Your agents will appear here when they are available." : "Try another agent or session name.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(agentChoices) { section in
                        Button {
                            startAgentSession(from: section.template)
                        } label: {
                            AgentLaunchRow(section: section)
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("Choose an agent")
                } footer: {
                    Text("Each new session keeps its own messages and syncs with the macOS app.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Agents and existing sessions"
        )
    }

    private var groupPage: some View {
        List {
            Section("Group name") {
                TextField("Optional", text: $groupName)
                    .textInputAutocapitalization(.words)
            }

            if groupContacts.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No contacts available" : "No contacts found",
                    systemImage: searchText.isEmpty ? "person.3" : "magnifyingglass",
                    description: Text(searchText.isEmpty ? "Add contacts before starting a group." : "Try another name or Kordi ID.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(groupContacts) { contact in
                        Button {
                            toggleGroupContact(contact)
                        } label: {
                            HStack(spacing: 12) {
                                IdentityAvatar(
                                    name: contact.preferredName,
                                    imageSource: contact.avatarUrl.nonEmpty,
                                    kind: .person,
                                    size: 42,
                                    seed: contact.accountId
                                )
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(contact.preferredName)
                                        .font(.headline)
                                        .foregroundStyle(.primary)
                                    if let kordiID = contact.kordiId.nonEmpty {
                                        Text("@\(kordiID)")
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 8)
                                Image(systemName: selectedGroupContactIDs.contains(contact.accountId) ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(selectedGroupContactIDs.contains(contact.accountId) ? KordiTheme.signalBlue : Color.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("People")
                } footer: {
                    Text("Select at least 2 people. Agents can be invited from the session later.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Contacts"
        )
    }

    private var title: String {
        switch mode {
        case .menu: "Start a chat"
        case .contact: "Chat with contact"
        case .agent: "Chat with agent"
        case .group: "Start group"
        case .addContact: "Add contact"
        }
    }

    private func move(to nextMode: NewChatMode) {
        searchText = ""
        withAnimation(.snappy(duration: 0.24)) {
            mode = nextMode
        }
    }

    private func startAgentSession(from template: ConversationSummary) {
        let accountId = model.account?.accountId ?? template.peerAccountId
        select(AgentSessionFactory.make(from: template, ownAccountId: accountId))
    }

    private func toggleGroupContact(_ contact: CloudContact) {
        if selectedGroupContactIDs.contains(contact.accountId) {
            selectedGroupContactIDs.remove(contact.accountId)
        } else {
            selectedGroupContactIDs.insert(contact.accountId)
        }
    }

    private func createGroup() {
        guard !isCreatingGroup else { return }
        let selected = model.contacts.filter { selectedGroupContactIDs.contains($0.accountId) }
        guard selected.count >= 2 else { return }
        isCreatingGroup = true
        Task {
            if let conversation = await model.createGroup(with: selected, title: groupName) {
                select(conversation)
            }
            isCreatingGroup = false
        }
    }

    private func conversationButton(_ conversation: ConversationSummary) -> some View {
        Button {
            select(conversation)
        } label: {
            ConversationRow(conversation: conversation)
        }
        .buttonStyle(.plain)
        .kordiListRow()
    }

    private func select(_ conversation: ConversationSummary) {
        onSelect(conversation)
        dismiss()
    }

    private func matchesSearch(_ conversation: ConversationSummary) -> Bool {
        conversation.displayName.localizedCaseInsensitiveContains(searchText)
            || conversation.lastMessage.localizedCaseInsensitiveContains(searchText)
            || conversation.ownerDisplayName?.localizedCaseInsensitiveContains(searchText) == true
    }
}

private struct NewChatActionRow: View {
    let symbol: String
    let tint: Color
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 42, height: 42)
                .background(tint.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct AgentLaunchRow: View {
    let section: AgentSessionSection

    var body: some View {
        HStack(spacing: 13) {
            IdentityAvatar(
                name: section.displayName,
                imageSource: section.avatarSource,
                kind: .agent,
                size: 46,
                seed: section.agentId ?? section.id
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(section.displayName)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(section.sessions.count == 1 ? "1 existing session" : "\(section.sessions.count) existing sessions")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Image(systemName: "plus.circle.fill")
                .font(.title3)
                .foregroundStyle(KordiTheme.agentViolet)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Starts a new session")
    }
}
