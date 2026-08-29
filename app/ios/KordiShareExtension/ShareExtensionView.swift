import Observation
import SwiftUI

@MainActor @Observable
final class ShareExtensionViewModel {
    private let context: NSExtensionContext
    private let credentialStore: ShareExtensionCredentialStore
    private var configuration: KordiShareConfiguration?
    private var credential: ShareExtensionCredential?
    private var payload: SharePayload?
    private var sendAttemptIDs = ShareSendAttemptIDs()
    private var didStart = false

    var conversations: [ShareConversation] = []
    var errorMessage: String?
    var isLoading = true
    var isSending = false
    var note = ""
    var query = ""
    var requiresSignIn = false
    var sendingConversationID: String?

    init(
        context: NSExtensionContext,
        credentialStore: ShareExtensionCredentialStore = ShareExtensionCredentialStore()
    ) {
        self.context = context
        self.credentialStore = credentialStore
    }

    var payloadText: String { payload?.displayText ?? "" }

    var filteredConversations: [ShareConversation] {
        filteredShareConversations(conversations, query: query)
    }

    func start() async {
        guard !didStart else { return }
        didStart = true
        do {
            payload = try await SharePayloadLoader.load(from: context)
            configuration = try KordiShareConfiguration.current()
            guard let credential = try credentialStore.load() else {
                requiresSignIn = true
                isLoading = false
                return
            }
            guard !credential.isExpired else {
                try? credentialStore.delete()
                requiresSignIn = true
                isLoading = false
                return
            }
            self.credential = credential
            try await loadConversations()
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    func retry() async {
        guard credential != nil, configuration != nil else {
            didStart = false
            requiresSignIn = false
            errorMessage = nil
            isLoading = true
            await start()
            return
        }
        await reloadConversations()
    }

    func send(to conversation: ShareConversation) async {
        guard !isSending,
              let payload,
              let credential,
              let configuration else { return }
        isSending = true
        sendingConversationID = conversation.id
        errorMessage = nil
        let clientMessageID = sendAttemptIDs.id(for: conversation.id)
        do {
            try await ShareExtensionAPIClient(configuration: configuration).send(
                body: payload.body(with: note),
                to: conversation.id,
                clientMessageID: clientMessageID,
                credential: credential
            )
            context.completeRequest(returningItems: [], completionHandler: nil)
        } catch let error as ShareExtensionAPIError {
            if error == .sessionExpired {
                try? credentialStore.delete()
                requiresSignIn = true
            }
            errorMessage = error.localizedDescription
            isSending = false
            sendingConversationID = nil
        } catch is CancellationError {
            isSending = false
            sendingConversationID = nil
        } catch {
            errorMessage = "Kordi could not send this item. Try again."
            isSending = false
            sendingConversationID = nil
        }
    }

    func cancel() {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }

    func openKordi() {
        guard let url = configuration?.hostAppURL
            ?? (try? KordiShareConfiguration.current().hostAppURL) else { return }
        context.open(url, completionHandler: nil)
    }

    private func reloadConversations() async {
        isLoading = true
        errorMessage = nil
        do {
            try await loadConversations()
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func loadConversations() async throws {
        guard let credential, let configuration else { return }
        do {
            conversations = try await ShareExtensionAPIClient(configuration: configuration)
                .conversations(credential: credential)
            isLoading = false
        } catch let error as ShareExtensionAPIError {
            if error == .sessionExpired {
                try? credentialStore.delete()
                requiresSignIn = true
            }
            throw error
        }
    }
}

struct ShareExtensionView: View {
    @State private var model: ShareExtensionViewModel

    init(context: NSExtensionContext) {
        _model = State(initialValue: ShareExtensionViewModel(context: context))
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Group {
                if model.isLoading {
                    ProgressView("Loading conversations…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.requiresSignIn {
                    unavailable(
                        title: "Open Kordi to sign in",
                        detail: model.errorMessage,
                        actionTitle: "Open Kordi",
                        action: model.openKordi
                    )
                } else if model.conversations.isEmpty {
                    unavailable(
                        title: model.errorMessage == nil ? "No conversations yet" : "Could not load conversations",
                        detail: model.errorMessage ?? "Start a conversation in Kordi, then share this item again.",
                        actionTitle: model.errorMessage == nil ? "Open Kordi" : "Try again",
                        action: model.errorMessage == nil
                            ? model.openKordi
                            : { Task { await model.retry() } }
                    )
                } else {
                    conversationList(model: model)
                }
            }
            .navigationTitle("Share to Kordi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: model.cancel)
                }
            }
            .searchable(text: $model.query, prompt: "Search conversations")
        }
        .task { await model.start() }
    }

    private func conversationList(model: ShareExtensionViewModel) -> some View {
        @Bindable var model = model
        return List {
            Section("Shared item") {
                Label {
                    Text(model.payloadText)
                        .lineLimit(3)
                } icon: {
                    Image(systemName: model.payloadText.hasPrefix("http") ? "link" : "text.alignleft")
                        .foregroundStyle(.secondary)
                }
                TextField("Add a note", text: $model.note, axis: .vertical)
                    .lineLimit(1...3)
            }

            Section("Choose a conversation") {
                ForEach(model.filteredConversations) { conversation in
                    Button {
                        Task { await model.send(to: conversation) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: symbol(for: conversation.kind))
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.tint)
                                .frame(width: 34, height: 34)
                                .background(.tint.opacity(0.10), in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(conversation.title)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(conversation.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            if model.sendingConversationID == conversation.id {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.up.circle.fill")
                                    .foregroundStyle(.tint)
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isSending)
                    .accessibilityLabel("Send to \(conversation.title). \(conversation.subtitle)")
                }
            }

            if let errorMessage = model.errorMessage {
                Section {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityLabel("Share failed. \(errorMessage)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .disabled(model.isSending)
    }

    private func unavailable(
        title: String,
        detail: String?,
        actionTitle: String,
        action: @escaping () -> Void
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: "square.and.arrow.up")
        } description: {
            if let detail { Text(detail) }
        } actions: {
            Button(actionTitle, action: action)
                .buttonStyle(.borderedProminent)
        }
    }

    private func symbol(for kind: String) -> String {
        switch kind {
        case "group": "person.3.fill"
        case "ai": "sparkles"
        default: "person.fill"
        }
    }
}
