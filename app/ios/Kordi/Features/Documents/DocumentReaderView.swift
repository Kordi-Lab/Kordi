import SwiftUI

/// Opens the reader with the account's document service. Use this from
/// navigation destinations and covers.
struct DocumentReaderScreen: View {
    @EnvironmentObject private var model: AppModel
    let request: DocumentReaderRequest

    var body: some View {
        DocumentReaderView(request: request, service: model.makeDocumentService())
    }
}

/// The document reader (issue 1741): title, date pill, `@author` chip, the
/// tab bar, and the blocks with their reactions and comments.
struct DocumentReaderView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    @StateObject private var reader: DocumentReaderModel
    @State private var tabs = DocumentTabs()
    @State private var selectedBlockId: String?
    @State private var showsReactions = false
    @State private var composingBlockId: String?
    @State private var showsShareSheet: Bool
    @State private var showsPeopleCard = false
    @State private var messageConversation: ConversationSummary?
    @State private var sessionConversation: ConversationSummary?
    @State private var htmlHeight: CGFloat = 320
    @State private var readerNameDraft = ""
    @State private var showsRename = false
    @State private var renameDraft = ""
    @State private var editorSession: DocumentEditorSession?
    private let opensEditor: Bool

    init(
        request: DocumentReaderRequest,
        service: any DocumentService,
        showsShareSheet: Bool = false,
        selectedBlockId: String? = nil,
        opensEditor: Bool = false
    ) {
        _reader = StateObject(wrappedValue: DocumentReaderModel(request: request, service: service))
        _showsShareSheet = State(initialValue: showsShareSheet)
        _selectedBlockId = State(initialValue: selectedBlockId)
        self.opensEditor = opensEditor
    }

    var body: some View {
        Group {
            if let document = reader.document {
                content(document)
            } else if let error = reader.loadError {
                ContentUnavailableView {
                    Label(error, systemImage: error == "This link is off" ? "lock" : "doc.text")
                } actions: {
                    if error != "This link is off" {
                        Button("Try again") { Task { await reader.load() } }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("Document")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let sessionTarget {
                    Button("Open in session") { sessionConversation = sessionTarget }
                }
                if reader.canEdit {
                    Button(action: openEditor) {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("Edit")
                }
                if reader.document != nil {
                    Button { showsShareSheet = true } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share")
                }
                if reader.canRename {
                    Menu {
                        Button(action: beginRename) {
                            Label("Rename", systemImage: "pencil")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More")
                }
            }
        }
        .task {
            reader.accountDisplayName = model.account?.displayName
            if reader.document == nil { await reader.load() }
            if opensEditor { openEditor() }
        }
        .fullScreenCover(item: $editorSession, onDismiss: { Task { await reader.refresh() } }) { session in
            DocumentEditorView(session: session)
        }
        .sheet(isPresented: Binding(get: { showsShareSheet && reader.document != nil }, set: { showsShareSheet = $0 })) {
            DocumentShareSheet(reader: reader, request: reader.request)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showsPeopleCard) {
            if let author = reader.document?.author {
                DocumentPeopleCard(author: author, onMessage: messageAction(for: author))
                    .presentationDetents([.medium])
            }
        }
        .stableNavigationDestination(item: $messageConversation) { conversation in
            ConversationView(conversation: conversation)
                .task { _ = await model.restoreConversationIfNeeded(conversation) }
        }
        .stableNavigationDestination(item: $sessionConversation) { conversation in
            ConversationView(conversation: conversation)
        }
        .alert("Your name", isPresented: Binding(
            get: { reader.pendingNamedAction != nil },
            set: { if !$0 { reader.pendingNamedAction = nil } }
        )) {
            TextField("Name", text: $readerNameDraft)
            Button("Continue") { reader.saveReaderName(readerNameDraft) }
            Button("Cancel", role: .cancel) { reader.pendingNamedAction = nil }
        }
        .alert("Rename document", isPresented: $showsRename) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { reader.rename(to: renameDraft) }
                .disabled(DocumentRename.validTitle(renameDraft) == nil)
        }
        .alert("Could not finish", isPresented: Binding(
            get: { reader.actionError != nil },
            set: { if !$0 { reader.actionError = nil } }
        )) {
            Button("OK") { reader.actionError = nil }
        } message: {
            Text(reader.actionError ?? "")
        }
    }

    private func content(_ document: DocumentResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if tabs.showsStrip {
                    DocumentTabStrip(tabs: $tabs)
                }
                if tabs.current == 0 {
                    header(document)
                    ForEach(document.blocks) { block in
                        blockRow(block, in: document)
                    }
                    footer(document)
                } else {
                    Text("Empty tab")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await reader.refresh() }
        .safeAreaInset(edge: .top, spacing: 0) {
            DocumentTabBar(tabs: $tabs)
        }
    }

    private func header(_ document: DocumentResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(document.title)
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                Label(DocumentDates.pill(document.createdAt), systemImage: "calendar")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 9)
                    .frame(minHeight: 26)
                    .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                Button("@\(document.author.displayName)") { showsPeopleCard = true }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(chatTheme.accent)
                    .padding(.horizontal, 9)
                    .frame(minHeight: 26)
                    .background(chatTheme.accent.opacity(0.1), in: Capsule())
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows the author")
            }
        }
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .onTapGesture { clearSelection() }
    }

    @ViewBuilder
    private func footer(_ document: DocumentResponse) -> some View {
        let parts = [document.agent.map { "From \($0.displayName)" }, document.sessionTitle?.nonEmpty]
            .compactMap { $0 }
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.top, 8)
        }
    }

    private func blockRow(_ block: DocumentBlock, in document: DocumentResponse) -> some View {
        DocumentBlockRow(
            block: block,
            reader: reader,
            document: document,
            mentionCandidates: mentionCandidates(document),
            isSelected: selectedBlockId == block.id,
            isComposing: composingBlockId == block.id,
            showsReactions: $showsReactions,
            onSelect: { toggleSelection(block.id) },
            onComment: {
                composingBlockId = block.id
                clearSelection()
            },
            onCloseComposer: { composingBlockId = nil }
        ) {
            if document.format == .html {
                if let data = reader.htmlData {
                    DocumentHTMLView(data: data, contentHeight: $htmlHeight)
                        .frame(height: htmlHeight)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                }
            } else {
                MarkdownMessageContent(text: block.source)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func openEditor() {
        let user = DocumentEditorUser(name: model.account?.displayName ?? "", accountId: model.account?.accountId ?? "")
        guard let session = reader.makeEditorSession(user: user) else { return }
        session.accentHex = UIColor.tintColor.documentEditorHex(for: UITraitCollection.current)
        editorSession = session
    }

    private func beginRename() {
        renameDraft = reader.document?.title ?? ""
        showsRename = true
    }

    private func toggleSelection(_ blockId: String) {
        withAnimation(.easeOut(duration: 0.15)) {
            showsReactions = false
            selectedBlockId = selectedBlockId == blockId ? nil : blockId
        }
    }

    private func clearSelection() {
        withAnimation(.easeOut(duration: 0.15)) {
            showsReactions = false
            selectedBlockId = nil
        }
    }

    /// Agents first (the viewer's own, then the session's), then people.
    private func mentionCandidates(_ document: DocumentResponse) -> [DocumentMentionCandidate] {
        if model.isPreviewMode { return PreviewData.sharedDocumentMentionCandidates }
        guard document.viewer != .public else {
            return DocumentMentionCandidates.list(document: document, ownAccountId: nil, targets: [])
        }
        let ownId = model.account?.accountId
        let conversation = reader.request.conversation ?? sessionTarget ?? document.sessionId?.nonEmpty.flatMap { id in
            model.conversations.first { $0.sessionId == id }
        }
        var people: [String] = []
        if let conversation {
            people = conversation.groupParticipants.filter { $0.accountId != ownId }.map(\.displayName)
            if people.isEmpty, conversation.kind == .person { people = [conversation.displayName] }
        }
        return DocumentMentionCandidates.list(
            document: document,
            ownAccountId: ownId,
            targets: conversation.map { model.mentionTargets(for: $0).filter { $0.kind != .all } } ?? [],
            fallbackPeople: people
        )
    }

    /// The session to open from a link, when the viewer is a member and the
    /// reader was not already opened from inside it.
    private var sessionTarget: ConversationSummary? {
        guard case .link = reader.request.source,
              let document = reader.document, document.viewer != .public,
              let sessionId = document.sessionId?.nonEmpty else { return nil }
        return model.conversations.first { $0.sessionId == sessionId }
    }

    private func messageAction(for author: DocumentAuthor) -> (() -> Void)? {
        guard author.accountId != model.account?.accountId,
              let contact = model.contacts.first(where: { $0.accountId == author.accountId }),
              let conversation = model.conversationForContact(contact) else { return nil }
        return {
            showsPeopleCard = false
            messageConversation = conversation
        }
    }
}
