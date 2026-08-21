import SwiftUI

struct ContactsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var showAddContact = false

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
                            ContactRequestRow(request: request)
                        }
                        ForEach(outgoingRequests) { request in
                            ContactRequestRow(request: request)
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
                        if let conversation = model.conversations.first(where: { $0.kind == .person && $0.peerAccountId == contact.accountId }) {
                            NavigationLink(value: conversation) {
                                ContactIdentityRow(contact: contact)
                            }
                            .kordiListRow()
                        }
                    }
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

private struct ContactRequestRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let request: CloudContactRequest
    @State private var isWorking = false

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
                    requestActions(using: actionLayout)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.top, 5)
                } else if !request.isIncoming && dynamicTypeSize.isAccessibilitySize {
                    pendingLabel
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

            if !profile.isSelf && !profile.isContact {
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
