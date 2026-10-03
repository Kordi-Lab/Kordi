import SwiftUI

struct ContactsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var showAddContact = false
    @State private var safetyAction: SafetyAction?
    @State private var reportTarget: ReportTarget?
    var onOpenConversation: ((ConversationSummary) -> Void)? = nil

    private var contacts: [CloudContact] {
        guard !searchText.isEmpty else { return model.contacts }
        return model.contacts.filter {
            $0.preferredName.localizedCaseInsensitiveContains(searchText)
                || $0.kordiId?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    private var incomingRequests: [CloudContactRequest] {
        model.contactRequests.filter(\.isIncoming)
    }

    private var outgoingRequests: [CloudContactRequest] {
        model.contactRequests.filter { !$0.isIncoming }
    }

    var body: some View {
        VStack(spacing: 0) {
            KordiPageSearchHeader(
                text: $searchText,
                prompt: "Name or Kordi ID",
                accessibilityLabel: "Search contacts by name or Kordi ID"
            ) {
                EmptyView()
            }

            List {
                if !incomingRequests.isEmpty || !outgoingRequests.isEmpty {
                    Section("Requests") {
                        ForEach(incomingRequests) { request in
                            ContactRequestRow(
                                request: request,
                                onSafetyAction: { safetyAction = $0 },
                                onReport: { reportTarget = $0 }
                            )
                        }
                        ForEach(outgoingRequests) { request in
                            ContactRequestRow(
                                request: request,
                                onSafetyAction: { safetyAction = $0 },
                                onReport: { reportTarget = $0 }
                            )
                        }
                    }
                }

                if contacts.isEmpty {
                    ContentUnavailableView(
                        searchText.isEmpty ? "No contacts yet" : "No contacts found",
                        systemImage: searchText.isEmpty ? "person.crop.circle.badge.plus" : "magnifyingglass",
                        description: Text(searchText.isEmpty ? "Add someone with their nine-digit Kordi ID." : "Try another name or Kordi ID.")
                    )
                    .listRowSeparator(.hidden)
                } else {
                    ForEach(contacts) { contact in
                        if let conversation = model.conversationForContact(contact) {
                            if let onOpenConversation {
                                Button { onOpenConversation(conversation) } label: {
                                    ContactIdentityRow(contact: contact)
                                }
                                .buttonStyle(.plain)
                                .kordiListRow()
                                .contactSafetyActions(for: contact, action: $safetyAction, report: $reportTarget)
                            } else {
                                NavigationLink(value: conversation) {
                                    ContactIdentityRow(contact: contact)
                                }
                                .kordiListRow()
                                .contactSafetyActions(for: contact, action: $safetyAction, report: $reportTarget)
                            }
                        }
                    }
                }

                if model.safetyFeaturesAvailable && searchText.isEmpty {
                    NavigationLink {
                        BlockedAccountsView()
                    } label: {
                        Label(SafetyCopy.blockedAccountsTitle, systemImage: "hand.raised")
                            .frame(minHeight: 44)
                    }
                    .kordiListRow()
                }
            }
            .listStyle(.plain)
            .scrollBounceBehavior(.always)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refreshWorkspace() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: ConversationSummary.self) { conversation in
            ConversationView(conversation: conversation)
                .task { _ = await model.restoreConversationIfNeeded(conversation) }
        }
        .toolbar {
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarTrailing) {
                    addContactButton
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    addContactButton
                }
            }
        }
        .sheet(isPresented: $showAddContact) { AddContactSheet() }
        .task { await model.refreshContactRequests() }
        .safetyActions($safetyAction, report: $reportTarget)
    }

    private var addContactButton: some View {
        Button { showAddContact = true } label: {
            Image(systemName: "person.badge.plus")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel("Add contact")
    }
}

private struct ContactIdentityRow: View {
    let contact: CloudContact

    var body: some View {
        HStack(spacing: 11) {
            IdentityAvatar(
                name: contact.preferredName,
                imageSource: contact.avatarUrl.nonEmpty,
                kind: .person,
                size: 44,
                seed: contact.accountId
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(contact.preferredName).font(.headline)
                if let kordiId = contact.kordiId.nonEmpty {
                    Text("@\(kordiId)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private extension View {
    /// Remove, block, and report for a contact row, each confirmed. Hidden
    /// for Kordi service accounts and on servers without these actions.
    func contactSafetyActions(
        for contact: CloudContact,
        action: Binding<SafetyAction?>,
        report: Binding<ReportTarget?>
    ) -> some View {
        modifier(ContactSafetyActions(contact: contact, action: action, report: report))
    }
}

private struct ContactSafetyActions: ViewModifier {
    @EnvironmentObject private var model: AppModel
    let contact: CloudContact
    @Binding var action: SafetyAction?
    @Binding var report: ReportTarget?

    private var account: SafetyAccount {
        SafetyAccount(accountId: contact.accountId, name: contact.preferredName)
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        if model.safetyActionsAllowed(for: contact.accountId) {
            content
                .contextMenu {
                    Button(role: .destructive) { action = .removeContact(account) } label: {
                        Label("Remove contact", systemImage: "person.badge.minus")
                    }
                    Button(role: .destructive) { action = .block(account) } label: {
                        Label("Block…", systemImage: "hand.raised")
                    }
                    .accessibilityLabel("Block \(contact.preferredName)")
                    Button { report = .account(accountId: contact.accountId, name: contact.preferredName) } label: {
                        Label("Report…", systemImage: "flag")
                    }
                    .accessibilityLabel("Report \(contact.preferredName)")
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    // Not a destructive role: the row stays until the removal
                    // is confirmed.
                    Button { action = .removeContact(account) } label: {
                        Label("Remove contact", systemImage: "person.badge.minus")
                    }
                    .tint(.red)
                    Button { action = .block(account) } label: {
                        Label("Block…", systemImage: "hand.raised")
                    }
                    .tint(.orange)
                    Button { report = .account(accountId: contact.accountId, name: contact.preferredName) } label: {
                        Label("Report…", systemImage: "flag")
                    }
                    .tint(.gray)
                }
                .accessibilityAction(named: "Remove contact") { action = .removeContact(account) }
                .accessibilityAction(named: "Block \(contact.preferredName)") { action = .block(account) }
                .accessibilityAction(named: "Report \(contact.preferredName)") {
                    report = .account(accountId: contact.accountId, name: contact.preferredName)
                }
        } else {
            content
        }
    }
}

private struct ContactRequestRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let request: CloudContactRequest
    var onSafetyAction: (SafetyAction) -> Void = { _ in }
    var onReport: (ReportTarget) -> Void = { _ in }
    @State private var isWorking = false

    private var counterpartName: String {
        request.counterpart?.preferredName ?? "Kordi user"
    }

    private var counterpartAccountId: String {
        request.isIncoming ? request.fromAccountId : request.toAccountId
    }

    private var canUseSafetyActions: Bool {
        model.safetyActionsAllowed(for: counterpartAccountId)
    }

    var body: some View {
        let actionLayout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 10))
            : AnyLayout(HStackLayout(spacing: 10))

        HStack(alignment: .top, spacing: 12) {
            IdentityAvatar(
                name: request.counterpart?.preferredName ?? "Kordi user",
                imageSource: request.counterpart?.avatarUrl.nonEmpty,
                kind: .person,
                size: 46,
                seed: request.counterpart?.accountId
            )
            .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(request.counterpart?.preferredName ?? "Kordi user")
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if !request.isIncoming && !dynamicTypeSize.isAccessibilitySize {
                        pendingLabel
                    }
                }
                requestMessage.lineLimit(2)
                if request.isIncoming {
                    Text(SafetyCopy.requestDisclosure(counterpartName))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    requestActions(using: actionLayout)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.top, 5)
                } else {
                    if dynamicTypeSize.isAccessibilitySize {
                        pendingLabel
                    }
                    if canUseSafetyActions {
                        Button("Withdraw") {
                            onSafetyAction(.withdraw(request))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(dynamicTypeSize.isAccessibilitySize ? .large : .small)
                        .frame(minHeight: 44)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .accessibilityLabel("Withdraw request to \(counterpartName)")
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
    }

    private var requestMessage: some View {
        Text(request.isIncoming ? (request.message.nonEmpty ?? "Wants to connect") : "Request sent")
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    private func requestActions(using layout: AnyLayout) -> some View {
        layout {
            if canUseSafetyActions {
                Menu {
                    Button(role: .destructive) {
                        onSafetyAction(.block(SafetyAccount(accountId: counterpartAccountId, name: counterpartName)))
                    } label: {
                        Label("Block…", systemImage: "hand.raised")
                    }
                    .accessibilityLabel("Block \(counterpartName)")
                    Button {
                        onReport(.account(
                            accountId: counterpartAccountId,
                            name: counterpartName,
                            contactRequestId: request.requestId
                        ))
                    } label: {
                        Label("Report…", systemImage: "flag")
                    }
                    .accessibilityLabel("Report \(counterpartName)")
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More actions for \(counterpartName)")
            }
            Button(role: .destructive, action: decline) {
                Text("Decline")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.red)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            Button(action: accept) {
                Text("Accept")
            }
            .buttonStyle(.borderedProminent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .controlSize(dynamicTypeSize.isAccessibilitySize ? .large : .small)
        .disabled(isWorking)
    }

    private var pendingLabel: some View {
        Text("Pending")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func accept() {
        isWorking = true
        Task {
            await model.acceptContactRequest(request)
            isWorking = false
        }
    }

    private func decline() {
        isWorking = true
        Task {
            await model.rejectContactRequest(request)
            isWorking = false
        }
    }
}

private struct AddContactSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AddContactSearchView(onRequestSent: { dismiss() })
                .navigationTitle("Add contact")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

struct AddContactSearchView: View {
    @EnvironmentObject private var model: AppModel
    let onRequestSent: () -> Void
    @State private var kordiId = ""
    @State private var message = ""
    @State private var result: CloudPublicProfile?
    @State private var isWorking = false

    private var normalizedKordiID: String {
        String(kordiId.filter(\.isNumber).prefix(9))
    }

    private var canSearch: Bool {
        normalizedKordiID.count == 9 && !isWorking
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    searchField
                    Text("Enter the nine-digit ID shown on their profile.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 2)
                }

                if let result {
                    resultCard(result)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                if let error = model.errorMessage.nonEmpty {
                    Label(error, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(uiColor: .systemGroupedBackground))
        .onAppear { model.errorMessage = nil }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Nine-digit Kordi ID", text: $kordiId)
                .keyboardType(.numberPad)
                .textContentType(.username)
                .textFieldStyle(.plain)
                .font(.body.monospacedDigit())
                .onChange(of: kordiId) { _, newValue in
                    let digits = String(newValue.filter(\.isNumber).prefix(9))
                    if digits != newValue { kordiId = digits }
                    result = nil
                    model.errorMessage = nil
                }

            if !kordiId.isEmpty && !isWorking {
                Button {
                    kordiId = ""
                    result = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                        .frame(width: 28, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear Kordi ID")
            }

            Group {
                if isWorking {
                    ProgressView().controlSize(.small)
                } else {
                    Button(action: search) {
                        Image(systemName: "arrow.right.circle.fill")
                            .font(.title3)
                            .foregroundStyle(canSearch ? KordiTheme.signalBlue : Color(uiColor: .tertiaryLabel))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSearch)
                    .accessibilityLabel("Search Kordi ID")
                }
            }
            .frame(width: 44, height: 44)
        }
        .padding(.leading, 12)
        .padding(.trailing, 2)
        .frame(height: 44)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.32), lineWidth: 0.5)
        }
    }

    private func resultCard(_ profile: CloudPublicProfile) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                IdentityAvatar(
                    name: profile.preferredName,
                    imageSource: profile.avatarUrl.nonEmpty,
                    kind: .person,
                    size: 40,
                    seed: profile.accountId
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(profile.preferredName)
                        .font(.body.weight(.semibold))
                    Text("@\(profile.kordiId)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

            if profile.isBlocked == true && !profile.isSelf {
                Divider()
                Label("You blocked this account. Unblock it before sending a contact request.", systemImage: "hand.raised")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !profile.isSelf && !profile.isContact {
                Divider()
                TextField("", text: $message, axis: .vertical)
                    .lineLimit(1...2)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 42)
                    .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Optional contact request message")

                Button(action: sendRequest) {
                    HStack(spacing: 8) {
                        if isWorking { ProgressView().tint(.white).controlSize(.small) }
                        Text(isWorking ? "Sending…" : "Send contact request")
                            .font(.body.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 10))
                .disabled(isWorking)
            } else {
                Divider()
                Label(profile.isSelf ? "This is your Kordi ID" : "Already in contacts", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func search() {
        guard canSearch else { return }
        isWorking = true
        Task {
            result = await model.lookupContact(kordiId: normalizedKordiID)
            isWorking = false
        }
    }

    private func sendRequest() {
        guard let result, !isWorking else { return }
        isWorking = true
        Task {
            if await model.sendContactRequest(to: result, message: message) {
                onRequestSent()
            }
            isWorking = false
        }
    }
}
