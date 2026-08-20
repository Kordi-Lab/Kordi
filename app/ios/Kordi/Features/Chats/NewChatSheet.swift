import SwiftUI

enum NewChatMode: CaseIterable, Hashable, Identifiable {
    case contact
    case agent
    case group
    case addContact

    var id: Self { self }

    var menuTitle: String {
        switch self {
        case .contact: "Chat with contact"
        case .agent: "Chat with agent"
        case .group: "Start group"
        case .addContact: "Add contacts"
        }
    }

    var navigationTitle: String {
        self == .addContact ? "Add contact" : menuTitle
    }

    var systemImage: String {
        switch self {
        case .contact: "message.fill"
        case .agent: "sparkles"
        case .group: "person.3.fill"
        case .addContact: "person.badge.plus"
        }
    }

    static func previewMode(arguments: [String]) -> Self? {
        if arguments.contains("--preview-add-contact") { return .addContact }
        if arguments.contains("--preview-new-group") { return .group }
        if arguments.contains("--preview-new-chat") { return .contact }
        return nil
    }
}

struct NewChatView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var groupName = ""
    @State private var selectedGroupContactIDs = Set<String>()
    @State private var isCreatingGroup = false
    @State private var showsProviderAuthentication = false

    private let mode: NewChatMode
    private let onSelect: (ConversationSummary) -> Void

    init(mode: NewChatMode, onSelect: @escaping (ConversationSummary) -> Void) {
        self.mode = mode
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
        Group {
            switch mode {
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
        .navigationTitle(mode.navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if mode == .group {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCreatingGroup ? "Creating…" : "Create") {
                        createGroup()
                    }
                    .disabled(selectedGroupContactIDs.count < 2 || isCreatingGroup)
                }
            }
        }
        .sheet(isPresented: $showsProviderAuthentication) {
            AccountSheet(openingAuthentication: true)
        }
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
                        .kordiListRow()
                    }
                } header: {
                    Text("Choose an agent")
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

    private func startAgentSession(from template: ConversationSummary) {
        guard model.hasConfiguredProviderAuthentication else {
            showsProviderAuthentication = true
            return
        }
        select(model.makeAgentSession(from: template))
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
    }

    private func matchesSearch(_ conversation: ConversationSummary) -> Bool {
        conversation.displayName.localizedCaseInsensitiveContains(searchText)
            || conversation.lastMessage.localizedCaseInsensitiveContains(searchText)
            || conversation.ownerDisplayName?.localizedCaseInsensitiveContains(searchText) == true
    }
}

private struct AgentLaunchRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let section: AgentSessionSection

    var body: some View {
        HStack(spacing: 11) {
            IdentityAvatar(
                name: section.displayName,
                imageSource: section.avatarSource,
                kind: .agent,
                size: dynamicTypeSize.isAccessibilitySize ? 52 : 44,
                seed: section.agentId ?? section.id
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(section.displayName)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                Text(section.sessions.count == 1 ? "1 existing session" : "\(section.sessions.count) existing sessions")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)
        }
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 64 : 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Starts a new session")
    }
}
