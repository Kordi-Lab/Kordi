import Foundation

/// Offline stand-in for the login-session API used by preview data. It replays
/// each login kind with the pinned catalog's own texts and never opens a URL
/// or contacts a server. It follows the hosted worker and server:
/// - start answers 422 `login_unsupported` (reason `unsupported_flow`) for an
///   api-key flow OMP does not accept, and for an `env-only` provider without
///   a key variable;
/// - after input the session reports `running` with the answered step while
///   OMP checks the value;
/// - a value that starts with `invalid` fails the session with reason
///   `invalid_input`, which a poll reports as HTTP 502 `login_failed`.
actor PreviewProviderLoginSimulator: ProviderLoginTransport {
    static let previewUserCode = "PRVW-2468"
    static let rejectedValuePrefix = "invalid"

    private struct Session {
        let storedProvider: String
        let label: String
        let flow: Flow
        var current: ProviderLoginSession
        var queue: [(delay: Duration, session: ProviderLoginSession)] = []
        /// Bumped on every change; `delivered` is the version the app last saw.
        var version = 0
        var delivered = 0
        /// The latest sign-in link, kept after later steps like the server does.
        var auth: ProviderLoginAuth?

        mutating func advance(to next: ProviderLoginSession) {
            current = next
            version += 1
            if case .openURL(let url, let launchURL, let instructions) = next.step {
                auth = ProviderLoginAuth(url: url, launchUrl: launchURL, instructions: instructions)
            }
        }

        func response(id: String) throws -> ProviderLoginSession {
            if current.status == .failed {
                throw CloudAPIError(
                    code: "login_failed", message: "Sign-in did not finish. Start again.",
                    statusCode: 502, reason: current.error ?? "unknown"
                )
            }
            return ProviderLoginSession(
                sessionId: id,
                status: current.status,
                step: current.step,
                auth: auth,
                version: version,
                snapshot: current.snapshot
            )
        }
    }

    private enum Flow {
        case key, oauth, device, prompt
    }

    private let catalog: [OMPProviderCatalogEntry]
    private var sessions: [String: Session] = [:]
    private var counter = 0

    init(catalog: [OMPProviderCatalogEntry]) {
        self.catalog = catalog
    }

    func start(provider: String, label: String, mode: String?, method: String?) async throws -> ProviderLoginSession {
        guard var policy = policy(provider: provider, mode: mode) else {
            throw Self.unsupported("unknown_provider")
        }
        if (method == "api-key" && !policy.acceptsAPIKeyMethod) || (policy.kind == "env-only" && policy.envVars.isEmpty) {
            throw Self.unsupported("unsupported_flow")
        }
        if method == "api-key", !policy.acceptsKeyEntry { policy = policy.apiKeyMethodPolicy }
        counter += 1
        let id = "preview-login-\(counter)"
        let stored = policy.storeCredentialsAs ?? provider
        var session: Session
        switch flow(for: policy) {
        case .key:
            // Like the worker, only an `api-key` rule's own texts are shown.
            let keyRule = policy.kind == "api-key"
            session = Session(storedProvider: stored, label: label, flow: .key, current: ProviderLoginSession(
                sessionId: id,
                status: .awaitingInput,
                step: .apiKey(
                    instructions: keyRule ? policy.instructions : nil,
                    placeholder: keyRule ? policy.placeholder : nil,
                    authURL: keyRule ? policy.authUrl : nil
                )
            ))
        case .oauth:
            session = Session(storedProvider: stored, label: label, flow: .oauth, current: ProviderLoginSession(
                sessionId: id,
                status: .running,
                step: .openURL(
                    url: Self.signInURL(for: policy),
                    launchURL: nil,
                    instructions: policy.instructions ?? "Complete sign-in in your browser."
                )
            ))
        case .device:
            let instructions = (policy.instructions ?? "Enter code: {user_code}")
                .replacingOccurrences(of: "{user_code}", with: Self.previewUserCode)
            session = Session(
                storedProvider: stored,
                label: label,
                flow: .device,
                current: ProviderLoginSession(
                    sessionId: id,
                    status: .running,
                    step: .openURL(url: Self.signInURL(for: policy), launchURL: nil, instructions: instructions)
                ),
                queue: [(.milliseconds(900), ProviderLoginSession(
                    status: .running,
                    step: .progress(message: "Waiting for browser authorization (code: \(Self.previewUserCode))…")
                ))]
            )
        case .prompt:
            session = Session(storedProvider: stored, label: label, flow: .prompt, current: ProviderLoginSession(
                sessionId: id,
                status: .awaitingInput,
                step: .prompt(
                    message: policy.prompt ?? policy.instructions ?? "Paste the token issued by the provider",
                    placeholder: policy.placeholder,
                    secret: true,
                    allowEmpty: false
                )
            ))
        }
        if case .openURL(let url, let launchURL, let instructions) = session.current.step {
            session.auth = ProviderLoginAuth(url: url, launchUrl: launchURL, instructions: instructions)
        }
        sessions[id] = session
        return try session.response(id: id)
    }

    /// Long-polls like the server: answers at once with an unseen change or a
    /// final status, otherwise after the next scripted step or 25 seconds.
    func poll(sessionID: String, after version: Int?) async throws -> ProviderLoginSession {
        let started = ContinuousClock.now
        for _ in 0..<100 {
            guard var session = sessions[sessionID] else { throw Self.notFound }
            if let next = session.queue.first, session.version == session.delivered,
               ContinuousClock.now - started >= next.delay {
                session.queue.removeFirst()
                session.advance(to: next.session)
            }
            let unseen = version.map { $0 != session.version } ?? (session.version != session.delivered)
            if unseen || session.current.status.isTerminal {
                session.delivered = session.version
                sessions[sessionID] = session
                return try session.response(id: sessionID)
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        guard let session = sessions[sessionID] else { throw Self.notFound }
        return try session.response(id: sessionID)
    }

    func submit(sessionID: String, value: String) async throws {
        guard var session = sessions[sessionID] else { throw Self.notFound }
        guard session.current.status == .awaitingInput else {
            throw CloudAPIError(code: "login_not_awaiting_input", message: "This sign-in is not waiting for input.", statusCode: 409)
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, !Self.allowsEmpty(session.current.step) {
            throw CloudAPIError(code: "invalid_login_input", message: "OMP could not use this input.", statusCode: 400)
        }
        counter += 1
        // OMP keeps the answered step while it checks the value.
        session.advance(to: ProviderLoginSession(status: .running, step: session.current.step))
        if trimmed.lowercased().hasPrefix(Self.rejectedValuePrefix) {
            session.queue = [(.milliseconds(1_500), ProviderLoginSession(status: .failed, error: "invalid_input"))]
        } else {
            let saved = ProviderLoginSession(status: .completed, snapshot: ProviderLoginSnapshot(
                snapshotId: "provider_auth_preview_login_\(counter)",
                provider: session.storedProvider,
                authChoice: "cloud-login:preview-\(counter)",
                label: session.label
            ))
            session.queue = session.flow == .oauth
                ? [
                    (.milliseconds(700), ProviderLoginSession(
                        status: .running, step: .progress(message: "Exchanging the authorization code…")
                    )),
                    (.milliseconds(1_500), saved),
                ]
                : [(.milliseconds(1_500), saved)]
        }
        sessions[sessionID] = session
    }

    func cancel(sessionID: String) async throws {
        guard var session = sessions[sessionID], !session.current.status.isTerminal else { return }
        session.advance(to: ProviderLoginSession(status: .cancelled))
        session.queue = []
        sessions[sessionID] = session
    }

    func signInPageOpened(sessionID: String) async {
        guard var session = sessions[sessionID], session.flow == .oauth,
              case .openURL = session.current.step else { return }
        session.advance(to: ProviderLoginSession(status: .awaitingInput, step: .pasteCode(instructions: nil)))
        sessions[sessionID] = session
    }

    private func policy(provider: String, mode: String?) -> OMPProviderLoginPolicy? {
        if mode == "device", ProviderAuthenticationDefinition.canonicalID(provider) == "openai" {
            return catalog.first { $0.id == OMPProviderCatalogEntry.chatGPTDeviceLoginID }?.login
                ?? .chatGPTDeviceFallback
        }
        return catalog.first { $0.id == provider }?.loginPolicy
    }

    private func flow(for policy: OMPProviderLoginPolicy) -> Flow {
        switch ProviderLoginMethod.style(for: policy) {
        case .apiKey: .key
        case .browserSignIn: .oauth
        case .deviceCode: .device
        case .vendorToken: .prompt
        }
    }

    private static func allowsEmpty(_ step: ProviderLoginStep?) -> Bool {
        if case .prompt(_, _, _, let allowEmpty) = step { return allowEmpty }
        return false
    }

    /// Public sign-in pages are shown but never opened in preview data.
    private static func signInURL(for policy: OMPProviderLoginPolicy) -> String {
        if let url = policy.authUrl?.nonEmpty { return url }
        switch policy.hook {
        case "openai-codex-device": return "https://auth.openai.com/codex/device"
        case "github-copilot": return "https://github.com/login/device"
        default: return "https://example.com/kordi-preview-sign-in"
        }
    }

    private static func unsupported(_ reason: String) -> CloudAPIError {
        CloudAPIError(code: "login_unsupported", message: "This provider cannot be added this way.", statusCode: 422, reason: reason)
    }

    private static let notFound = CloudAPIError(
        code: "login_not_found", message: "This sign-in is no longer available.", statusCode: 404
    )
}
