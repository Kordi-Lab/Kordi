import SwiftUI
import UIKit

/// Preview-only selection of a provider login flow to start offline:
/// `--preview-login-steps=<provider>[:<method>]`.
enum PreviewLoginSteps {
    static let argumentPrefix = "--preview-login-steps="

    struct Request: Equatable {
        let provider: String
        let method: String?
    }

    static var request: Request? { request(in: ProcessInfo.processInfo.arguments) }

    static var requestedProvider: String? { request?.provider }

    static func request(in arguments: [String]) -> Request? {
        if let argument = arguments.last(where: { $0.hasPrefix(argumentPrefix) }),
           let value = String(argument.dropFirst(argumentPrefix.count)).nonEmpty {
            let parts = value.split(separator: ":", maxSplits: 1).map(String.init)
            guard let provider = parts.first?.nonEmpty else { return nil }
            return Request(provider: provider, method: parts.count > 1 ? parts[1].nonEmpty : nil)
        }
        // Earlier alias for the ChatGPT device-code preview.
        if arguments.contains("--preview-codex-device-login") {
            return Request(provider: OMPProviderCatalogEntry.chatGPTDeviceLoginID, method: nil)
        }
        return nil
    }

    static func requestedProvider(in arguments: [String]) -> String? {
        request(in: arguments)?.provider
    }

    /// The provider row that owns a requested login flow.
    static func definition(
        for requested: String,
        in definitions: [ProviderAuthenticationDefinition]
    ) -> ProviderAuthenticationDefinition? {
        definitions.first { $0.id == requested }
            ?? definitions.first {
                ProviderAuthenticationDefinition.canonicalID($0.id)
                    == ProviderAuthenticationDefinition.canonicalID(requested)
            }
    }
}

// MARK: - Layer 2: method picker

/// Lists each way to add an account; shown only when there is more than one.
struct ProviderLoginMethodPicker: View {
    let provider: ProviderAuthenticationDefinition
    let methods: [ProviderLoginMethod]
    let existingLabels: [String]
    let initialMethod: ProviderLoginMethod?
    let autoStart: Bool
    let onFinish: (String?) -> Void
    let onStartChat: (String?) -> Void

    @State private var selected: ProviderLoginMethod?
    @State private var didApplyInitial = false

    var body: some View {
        List {
            Section {
                ForEach(methods) { method in
                    Button {
                        selected = method
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(method.title)
                                    .foregroundStyle(Color.primary)
                                Text(method.pickerDescription)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("provider-login-method-\(method.id)")
                }
            } footer: {
                Text("OMP completes each step on Kordi Cloud; provider tokens never reach this iPhone.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Add \(provider.shortName) account")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $selected) { method in
            ProviderLoginScreen(
                provider: provider,
                method: method,
                existingLabels: existingLabels,
                autoStart: autoStart && method == initialMethod,
                onFinish: onFinish,
                onStartChat: onStartChat
            )
        }
        .task {
            guard !didApplyInitial, let initialMethod else { return }
            didApplyInitial = true
            try? await Task.sleep(for: .milliseconds(350))
            selected = initialMethod
        }
    }
}

// MARK: - Layer 3: login screen

/// Runs one OMP login session. Like OMP's login dialog, each step is appended
/// to a transcript: the sign-in link, prompts with earlier answers kept
/// (secrets hidden), and progress lines.
struct ProviderLoginScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    let provider: ProviderAuthenticationDefinition
    let method: ProviderLoginMethod
    let existingLabels: [String]
    let autoStart: Bool
    let onFinish: (String?) -> Void
    let onStartChat: (String?) -> Void

    @StateObject private var controller = ProviderLoginController()
    @State private var didFinish = false
    @State private var label: String
    @State private var apiKey = ""
    @State private var input = ""
    @State private var openedURL: URL?
    @State private var didAutoStart = false

    init(
        provider: ProviderAuthenticationDefinition,
        method: ProviderLoginMethod,
        existingLabels: [String],
        autoStart: Bool,
        onFinish: @escaping (String?) -> Void,
        onStartChat: @escaping (String?) -> Void
    ) {
        self.provider = provider
        self.method = method
        self.existingLabels = existingLabels
        self.autoStart = autoStart
        self.onFinish = onFinish
        self.onStartChat = onStartChat
        _label = State(initialValue: Self.suggestedLabel(for: method, provider: provider, existingLabels: existingLabels))
    }

    private var state: ProviderLoginViewState { controller.state }
    private var showsIntro: Bool {
        switch state.phase {
        case .idle, .failed, .cancelled: true
        default: false
        }
    }

    var body: some View {
        List {
            Section("Account name") {
                TextField("Work", text: $label)
                    .textInputAutocapitalization(.words)
                    .disabled(state.isActive || state.phase == .completed)
                    .accessibilityIdentifier("provider-login-label")
            }
            if showsIntro {
                Section {
                    intro
                } footer: {
                    if model.ompBackendUnavailable {
                        Text(OMPBackendSupport.unavailableMessage)
                            .accessibilityIdentifier("omp-backend-unavailable")
                    } else {
                        Text(method.isKeyEntry
                            ? "OMP checks the key on Kordi Cloud before it is saved to your account."
                            : "OMP completes each step on Kordi Cloud; provider tokens never reach this iPhone.")
                    }
                }
            }
            if !controller.transcript.entries.isEmpty, !(state.phase == .failed && controller.backendUnavailable) {
                Section("Steps") {
                    ForEach(controller.transcript.entries) { entry in
                        entryView(entry)
                    }
                    if state.phase == .signIn, !lastEntryIsProgress {
                        statusLine("Waiting for approval…", identifier: "provider-login-waiting")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
        .navigationTitle("\(method.title) · \(provider.shortName)")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(state.isActive)
        .toolbar {
            if state.isActive {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        controller.cancel()
                        dismiss()
                    }
                    .accessibilityIdentifier("provider-login-cancel")
                }
            } else if state.phase == .completed {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { finish() }
                }
            }
        }
        .onAppear {
            guard autoStart, !didAutoStart, !method.isKeyEntry else { return }
            didAutoStart = true
            start()
        }
        .onDisappear {
            if controller.state.isActive { controller.cancel() }
        }
        .onChange(of: state.phase) { _, phase in
            // A saved account returns to the provider screen on its own.
            guard phase == .completed else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1_600))
                finish()
            }
        }
        .onChange(of: controller.backendUnavailable) { _, unavailable in
            if unavailable { model.markOMPBackendUnavailable() }
        }
        .onChange(of: state.signInURL) { _, url in
            // Browser sign-in opens its page as soon as OMP provides it.
            guard let url, url != openedURL, !model.isPreviewMode, method.style == .browserSignIn else { return }
            openSignInPage(url)
        }
    }

    // MARK: Intro

    @ViewBuilder
    private var intro: some View {
        Text(method.summary)
            .font(.subheadline)
            .accessibilityIdentifier(method.isKeyEntry ? "provider-login-key-instructions" : "provider-login-summary")
        if method.isKeyEntry {
            if let keyURL = ProviderLoginViewState.httpsURL(method.policy.authUrl) {
                Link("Get an API key", destination: keyURL)
                    .accessibilityIdentifier("provider-login-get-key")
            }
            SecureField(method.policy.placeholder?.nonEmpty ?? "Paste key", text: $apiKey)
                .textContentType(.password)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive()
                .accessibilityIdentifier("provider-api-key")
            Button("Save") { start(apiKey: apiKey) }
                .fontWeight(.semibold)
                .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.ompBackendUnavailable)
                .accessibilityIdentifier("provider-login-save-key")
        } else {
            Button(method.actionTitle) { start() }
                .fontWeight(.semibold)
                .disabled(model.ompBackendUnavailable)
                .accessibilityIdentifier("provider-login-start")
        }
    }

    // MARK: Transcript

    @ViewBuilder
    private func entryView(_ entry: ProviderLoginTranscriptEntry) -> some View {
        switch entry.kind {
        case .auth(let url, let instructions, let userCode):
            authEntry(url: url, instructions: instructions, userCode: userCode)
        case .input(let input):
            inputEntry(input, isActive: entry.id == activeInputID)
        case .progress(let message):
            let isLatest = entry.id == controller.transcript.entries.last?.id
            if isLatest && (state.phase == .working || state.phase == .signIn || state.phase == .starting) {
                statusLine(
                    message,
                    identifier: state.phase == .signIn ? "provider-login-waiting" : "provider-login-status"
                )
            } else {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("provider-login-progress")
            }
        case .failure(let message) where message == OMPBackendSupport.unavailableMessage:
            // Shown once, in the footer above.
            EmptyView()
        case .failure(let message):
            VStack(alignment: .leading, spacing: 6) {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("provider-login-error")
                Button("Try again") { retry() }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("provider-login-retry")
            }
        case .completed(let name):
            VStack(alignment: .leading, spacing: 8) {
                Text("Signed in as \(name)")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.green)
                    .accessibilityIdentifier("provider-login-completed")
                HStack(spacing: 20) {
                    Button("Done") { finish() }
                        .buttonStyle(.borderless)
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("provider-login-done")
                    Button("Start chat") { finish(startingChat: true) }
                        .buttonStyle(.borderless)
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("provider-login-start-chat")
                }
            }
        case .cancelled:
            Text("Canceled.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("provider-login-cancelled")
        }
    }

    private func authEntry(url: URL, instructions: String?, userCode: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let userCode {
                Text("Enter this code on the sign-in page:")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(userCode)
                    .font(.title2.monospaced().weight(.semibold))
                    .textSelection(.enabled)
                    .privacySensitive()
                    .accessibilityIdentifier("provider-login-device-code")
                Button("Copy code") { UIPasteboard.general.string = userCode }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("provider-login-copy-code")
            }
            if let instructions, !(userCode.map(instructions.contains) ?? false) {
                Text(Self.sentence(instructions))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("provider-login-instructions")
            }
            Button("Open sign-in page") { openSignInPage(url) }
                .buttonStyle(.borderless)
                .fontWeight(.semibold)
                .accessibilityIdentifier("provider-login-open-url")
            if method.style == .browserSignIn {
                // Hosted OAuth redirects to a localhost callback this iPhone cannot serve.
                Text(Self.localhostHint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("provider-login-localhost-hint")
            }
            HStack(spacing: 8) {
                Text(url.absoluteString)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("provider-login-url")
                Spacer(minLength: 4)
                Button("Copy link") { UIPasteboard.general.url = url }
                    .buttonStyle(.borderless)
                    .font(.caption.weight(.semibold))
                    .accessibilityIdentifier("provider-login-copy-link")
            }
        }
        .padding(.vertical, 2)
    }

    private var lastEntryIsProgress: Bool {
        if case .progress = controller.transcript.entries.last?.kind { return true }
        return false
    }

    private var activeInputID: Int? {
        guard state.phase == .input else { return nil }
        return controller.transcript.entries.last { entry in
            if case .input(let input) = entry.kind { !input.isAnswered } else { false }
        }?.id
    }

    private func inputEntry(_ entry: ProviderLoginTranscriptEntry.Input, isActive: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.message ?? Self.defaultMessage(for: entry.kind))
                .font(.subheadline)
                .accessibilityIdentifier("provider-login-prompt")
            if let instructions = entry.instructions, isActive {
                Text(Self.sentence(instructions))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if isActive {
                HStack(spacing: 10) {
                    Group {
                        if entry.isSecret {
                            SecureField(Self.example(entry.placeholder), text: $input)
                                .textContentType(.password)
                                .privacySensitive()
                        } else if entry.kind == .pasteCode && entry.placeholder == nil {
                            TextField(Self.pastePlaceholder, text: $input)
                        } else {
                            TextField(Self.example(entry.placeholder), text: $input)
                        }
                    }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("provider-login-input")
                    Button(entry.kind == .apiKey ? "Save" : "Continue") {
                        let value = input
                        input = ""
                        controller.submit(value)
                    }
                    .buttonStyle(.borderless)
                    .fontWeight(.semibold)
                    .disabled(!entry.allowsEmpty && input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("provider-login-submit")
                }
                if let error = entry.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("provider-login-error")
                }
            } else if entry.isAnswered {
                Text(entry.answer ?? "Sent")
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("provider-login-answer")
            }
        }
        .padding(.vertical, 2)
    }

    private func statusLine(_ text: String, identifier: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    // MARK: Actions

    private func start(apiKey key: String? = nil) {
        guard let transport = model.makeProviderLoginTransport() else { return }
        input = ""
        openedURL = nil
        let accountLabel = label.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? Self.suggestedLabel(for: method, provider: provider, existingLabels: existingLabels)
        controller.start(method, label: accountLabel, apiKey: key, transport: transport) { snapshot in
            model.recordProviderLogin(snapshot)
        }
        if key != nil { apiKey = "" }
    }

    private func finish(startingChat: Bool = false) {
        guard !didFinish, state.phase == .completed else { return }
        didFinish = true
        let snapshotID = state.snapshot?.snapshotId
        if startingChat { onStartChat(snapshotID) } else { onFinish(snapshotID) }
    }

    private func retry() {
        if method.isKeyEntry {
            controller.reset()
        } else {
            start()
        }
    }

    private func openSignInPage(_ url: URL) {
        openedURL = url
        // Preview data never leaves the app; the simulator only advances its step.
        if !model.isPreviewMode { openURL(url) }
        controller.signInPageOpened()
    }

    static func suggestedLabel(
        for method: ProviderLoginMethod,
        provider: ProviderAuthenticationDefinition,
        existingLabels: [String]
    ) -> String {
        for name in ["Work", "Personal"] where !existingLabels.contains(name) { return name }
        let base = method.isKeyEntry ? "API key"
            : method.provider == "openai-codex" ? "ChatGPT account" : "\(provider.shortName) account"
        return "\(base) \(existingLabels.count + 1)"
    }

    static let localhostHint = "After you approve, the browser lands on a localhost page that cannot load. Copy that page's full address and paste it below."
    static let pastePlaceholder = "Full address from the browser, or the code"

    private static func defaultMessage(for kind: ProviderLoginViewState.InputKind) -> String {
        switch kind {
        case .apiKey: "API key"
        case .pasteCode: "Paste the final redirect URL or authorization code"
        case .prompt: "Enter the requested value"
        }
    }

    private static func example(_ placeholder: String?) -> String {
        placeholder?.nonEmpty.map { "e.g., \($0)" } ?? "Value"
    }

    private static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last, !".!?…".contains(last) else { return trimmed }
        return trimmed + "."
    }
}
