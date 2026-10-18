import SwiftUI

struct ContactsView<PinnedRows: View>: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var showAddContact = false
    var onOpenConversation: ((ConversationSummary) -> Void)? = nil
    /// Rows shown above requests and contacts, for entries that live outside this screen.
    private let pinnedRows: PinnedRows

    init(
        onOpenConversation: ((ConversationSummary) -> Void)? = nil,
        @ViewBuilder pinnedRows: () -> PinnedRows
    ) {
        self.onOpenConversation = onOpenConversation
        self.pinnedRows = pinnedRows()
    }

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

    private var showsRequests: Bool {
        !incomingRequests.isEmpty || !outgoingRequests.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            KordiPullDownSearchField(
                text: $searchText,
                prompt: "Name or Kordi ID",
                accessibilityLabel: "Search contacts by name or Kordi ID"
            )
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 8)

            List {
                if searchText.isEmpty {
                    Section {
                        pinnedRows
                    }
                    .listSectionSeparator(.hidden)
                }

                if showsRequests {
                    Section {
                        ForEach(incomingRequests) { request in
                            ContactRequestRow(request: request)
                                .contactsListRow()
                        }
                        ForEach(outgoingRequests) { request in
                            ContactRequestRow(request: request)
                                .contactsListRow()
                        }
                    } header: {
                        ContactsSectionHeader(title: "Requests")
                    }
                    .listSectionSeparator(.hidden)
                }

                Section {
                    if contacts.isEmpty {
                        ContentUnavailableView(
                            searchText.isEmpty ? "No contacts yet" : "No contacts found",
                            systemImage: searchText.isEmpty ? "person.crop.circle.badge.plus" : "magnifyingglass",
                            description: Text(searchText.isEmpty ? "Add someone with their nine-digit Kordi ID." : "Try another name or Kordi ID.")
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    } else {
                        ForEach(contacts) { contact in
                            if let conversation = model.conversationForContact(contact) {
                                if let onOpenConversation {
                                    Button { onOpenConversation(conversation) } label: {
                                        ContactIdentityRow(contact: contact)
                                    }
                                    .buttonStyle(.plain)
                                    .contactsListRow()
                                } else {
                                    NavigationLink(value: conversation) {
                                        ContactIdentityRow(contact: contact)
                                    }
                                    .contactsListRow()
                                }
                            }
                        }
                    }
                } header: {
                    if showsRequests {
                        ContactsSectionHeader(title: "Contacts")
                    }
                }
                .listSectionSeparator(.hidden)
            }
            .listStyle(.plain)
            .environment(\.defaultMinListHeaderHeight, 0)
            .listSectionSpacing(0)
            .scrollBounceBehavior(.always)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refreshWorkspace() }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("Contacts")
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
    }

    private var addContactButton: some View {
        Button { showAddContact = true } label: {
            ContactsToolbarIcon(systemName: "person.badge.plus")
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel("Add contact")
    }
}

extension ContactsView where PinnedRows == EmptyView {
    init(onOpenConversation: ((ConversationSummary) -> Void)? = nil) {
        self.init(onOpenConversation: onOpenConversation) { EmptyView() }
    }
}

/// A plain navigation-bar icon matching the other tab toolbars.
struct ContactsToolbarIcon: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.body.weight(.semibold))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}

private struct ContactsSectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 10)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// Row spacing and separators for Contacts: separators start at the text, not the avatar.
    func contactsListRow() -> some View {
        modifier(ContactsListRowModifier())
    }
}

private struct ContactsListRowModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let verticalInset: CGFloat = dynamicTypeSize.isAccessibilitySize ? 10 : 8
        content
            .listRowInsets(EdgeInsets(top: verticalInset, leading: 16, bottom: verticalInset, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparatorTint(Color(uiColor: .separator).opacity(0.6))
    }
}

/// Avatar, title and subtitle with an optional trailing accessory; the shared
/// shape of every Contacts row.
struct ContactsRowLayout<Leading: View, Trailing: View>: View {
    let title: String
    let subtitle: String?
    /// Overrides the secondary subtitle color, such as the tint for "online".
    var subtitleColor: Color? = nil
    private let leading: Leading
    private let trailing: Trailing

    init(
        title: String,
        subtitle: String?,
        subtitleColor: Color? = nil,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.subtitleColor = subtitleColor
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            leading
                .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(subtitleColor.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            trailing
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

extension ContactsRowLayout where Trailing == EmptyView {
    init(title: String, subtitle: String?, subtitleColor: Color? = nil, @ViewBuilder leading: () -> Leading) {
        self.init(title: title, subtitle: subtitle, subtitleColor: subtitleColor, leading: leading) { EmptyView() }
    }
}

private struct ContactAvatar: View {
    let name: String
    let imageSource: String?
    let seed: String?

    var body: some View {
        IdentityAvatar(
            name: name,
            imageSource: imageSource,
            kind: .person,
            size: 44,
            seed: seed,
            cornerRadius: 22
        )
    }
}

/// A person row: presence ("online", "last seen 9 minutes ago") under the name. The Kordi ID
/// stays searchable and shows only when presence is unknown.
private struct ContactIdentityRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale
    let contact: CloudContact

    private var handle: String? { contact.kordiId.nonEmpty.map { "@\($0)" } }

    /// Kordi Support and other Kordi agents are services, so they show their description instead of presence.
    private var isSupport: Bool { KordiSupportIdentity.matches(name: contact.preferredName, seed: contact.accountId) }
    private var isSystemAgent: Bool { isSupport || contact.contactKind == "system_agent" }

    private var systemAgentDescription: String? {
        contact.subtitle.nonEmpty ?? (isSupport ? "Ask questions or suggest improvements" : handle)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let presence = isSystemAgent ? nil : model.contactPresenceByAccountID[contact.accountId]
            ContactsRowLayout(
                title: contact.preferredName,
                subtitle: isSystemAgent
                    ? systemAgentDescription
                    : presence.map {
                        ContactPresencePresentation.listLabel(for: $0, now: context.date, calendar: calendar, locale: locale)
                    } ?? handle,
                subtitleColor: presence?.status == .online ? KordiTheme.signalBlue : nil
            ) {
                ContactAvatar(name: contact.preferredName, imageSource: contact.avatarUrl.nonEmpty, seed: contact.accountId)
            }
        }
    }
}

private struct ContactRequestRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let request: CloudContactRequest
    @State private var isWorking = false

    private var name: String { request.counterpart?.preferredName ?? "Kordi user" }

    private var subtitle: String {
        request.isIncoming ? (request.message.nonEmpty ?? "Wants to connect") : "Request sent"
    }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .trailing, spacing: 10) {
                ContactsRowLayout(title: name, subtitle: subtitle) { avatar }
                trailing
            }
        } else {
            ContactsRowLayout(title: name, subtitle: subtitle) { avatar } trailing: { trailing }
        }
    }

    private var avatar: some View {
        ContactAvatar(name: name, imageSource: request.counterpart?.avatarUrl.nonEmpty, seed: request.counterpart?.accountId)
    }

    @ViewBuilder
    private var trailing: some View {
        if request.isIncoming {
            HStack(spacing: 8) {
                Button(action: decline) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                        .frame(width: 36, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Decline")

                Button(action: accept) {
                    ZStack {
                        Text("Accept").opacity(isWorking ? 0 : 1)
                        if isWorking {
                            ProgressView().controlSize(.small).tint(.white)
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 30)
                    .background(KordiTheme.signalBlue, in: Capsule())
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Accept")
            }
            .disabled(isWorking)
            .opacity(isWorking ? 0.6 : 1)
        } else {
            Text("Pending")
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
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
