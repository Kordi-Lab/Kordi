import Foundation

/// Transport for one OMP login session. The live implementation calls Kordi
/// Cloud; preview data uses `PreviewProviderLoginSimulator` and stays offline.
protocol ProviderLoginTransport: Sendable {
    func start(provider: String, label: String, mode: String?, method: String?) async throws -> ProviderLoginSession
    func poll(sessionID: String, after version: Int?) async throws -> ProviderLoginSession
    func submit(sessionID: String, value: String) async throws
    func cancel(sessionID: String) async throws
    /// Tells an offline simulation that the user opened the sign-in page.
    /// The server learns about sign-in progress on its own.
    func signInPageOpened(sessionID: String) async
}

extension ProviderLoginTransport {
    func signInPageOpened(sessionID: String) async {}
}

struct CloudProviderLoginTransport: ProviderLoginTransport {
    let api: CloudAPIClient
    let token: String

    func start(provider: String, label: String, mode: String?, method: String?) async throws -> ProviderLoginSession {
        try await api.startProviderLogin(token: token, provider: provider, label: label, mode: mode, method: method)
    }

    func poll(sessionID: String, after version: Int?) async throws -> ProviderLoginSession {
        try await api.providerLoginSession(token: token, sessionId: sessionID, after: version)
    }

    func submit(sessionID: String, value: String) async throws {
        try await api.submitProviderLoginInput(token: token, sessionId: sessionID, value: value)
    }

    func cancel(sessionID: String) async throws {
        try await api.cancelProviderLogin(token: token, sessionId: sessionID)
    }
}

/// Drives one Add-account flow: starts a login session, long-polls its steps,
/// sends user input, and reports the saved account.
@MainActor
final class ProviderLoginController: ObservableObject {
    @Published private(set) var state = ProviderLoginViewState()
    @Published private(set) var transcript = ProviderLoginTranscript()
    @Published private(set) var activeMethodID: String?
    /// The method whose steps, failure, or cancellation are on screen.
    @Published private(set) var methodID: String?
    @Published private(set) var savedLabel: String?
    /// Set when the backend has no OMP; see `OMPBackendSupport`.
    @Published private(set) var backendUnavailable = false

    /// Retries of one poll or input request after a passing failure.
    static let maxTransientRetries = 4
    /// Wait before retry `n`; tests shorten it.
    var retryDelay: (Int) -> Duration = { .seconds(2 * $0) }

    /// The step the user answered and the version on screen at that moment.
    private struct Answer {
        let step: ProviderLoginStep?
        let version: Int?

        /// Whether `session` still shows the answered request. After input OMP
        /// keeps the answered step while it checks the value, so only a newer
        /// request for input, another step, or a final status moves on.
        func isPending(in session: ProviderLoginSession) -> Bool {
            switch session.status {
            case .running, .claiming:
                return session.step == nil || session.step == step
            case .awaitingInput:
                guard let current = session.version, let version else { return session.step == step }
                return current <= version
            case .completed, .failed, .cancelled:
                return false
            }
        }
    }

    private var transport: (any ProviderLoginTransport)?
    private var sessionID: String?
    private var lastStep: ProviderLoginStep?
    private var lastVersion: Int?
    private var answer: Answer?
    private var pendingKey: String?
    private var loopTask: Task<Void, Never>?
    private var generation = 0
    private var onCompleted: ((ProviderLoginSnapshot) -> Void)?

    func start(
        _ method: ProviderLoginMethod,
        label: String,
        apiKey: String? = nil,
        transport: any ProviderLoginTransport,
        onCompleted: @escaping (ProviderLoginSnapshot) -> Void
    ) {
        stopLoop()
        generation += 1
        let attempt = generation
        self.transport = transport
        self.onCompleted = onCompleted
        activeMethodID = method.id
        methodID = method.id
        savedLabel = nil
        backendUnavailable = false
        sessionID = nil
        lastStep = nil
        lastVersion = nil
        answer = nil
        pendingKey = apiKey?.nonEmpty
        send(.start)
        // The start request is not tied to the loop, so a sign-in canceled while
        // starting still receives its session id and can end it on the server.
        let request = Task { try await transport.start(
            provider: method.provider, label: label, mode: method.mode, method: method.method
        ) }
        loopTask = Task { [weak self] in
            do {
                let session = try await request.value
                guard let self, self.generation == attempt else {
                    await Self.discard(session, transport: transport)
                    return
                }
                guard let id = session.sessionId?.nonEmpty else {
                    if session.status.isTerminal { self.apply(session) } else {
                        self.send(.failure(code: "invalid_response", reason: "Kordi Cloud did not return a sign-in session."))
                    }
                    return
                }
                self.sessionID = id
                self.apply(session)
                await self.pollUntilFinished(attempt)
            } catch {
                self?.fail(error, attempt: attempt)
            }
        }
    }

    func submit(_ value: String) {
        guard state.phase == .input, let id = sessionID, let transport else { return }
        let attempt = generation
        let answered = Answer(step: lastStep, version: lastVersion)
        answer = answered
        send(.submit, answer: value)
        Task { [weak self] in
            var failures = 0
            while true {
                do {
                    try await transport.submit(sessionID: id, value: value)
                    return
                } catch {
                    guard let self, self.generation == attempt else { return }
                    // OMP already moved on; polling reports where it is.
                    if (error as? CloudAPIError)?.code == "login_not_awaiting_input" { return }
                    guard Self.isTransient(error), failures < Self.maxTransientRetries else {
                        self.fail(error, attempt: attempt)
                        return
                    }
                    failures += 1
                    try? await Task.sleep(for: self.retryDelay(failures))
                    // A received value bumps the version, which the long poll
                    // sees first; send again only while nothing has changed.
                    guard self.generation == attempt, self.state.phase == .working,
                          self.lastVersion == answered.version else { return }
                }
            }
        }
    }

    func signInPageOpened() {
        guard let id = sessionID, let transport else { return }
        Task { await transport.signInPageOpened(sessionID: id) }
    }

    func cancel() {
        endSession()
        stopLoop()
        generation += 1
        pendingKey = nil
        activeMethodID = nil
        send(.cancel)
    }

    /// Clears a finished, failed, or canceled attempt so another can start.
    func reset() {
        guard !state.isActive else { return }
        stopLoop()
        generation += 1
        activeMethodID = nil
        methodID = nil
        send(.reset)
    }

    private func pollUntilFinished(_ attempt: Int) async {
        var failures = 0
        while generation == attempt, state.isActive, let id = sessionID, let transport {
            do {
                let session = try await transport.poll(sessionID: id, after: lastVersion)
                guard generation == attempt else { return }
                failures = 0
                apply(session)
            } catch {
                guard generation == attempt, !(error is CancellationError) else { return }
                if Self.isTransient(error), failures < Self.maxTransientRetries {
                    failures += 1
                    try? await Task.sleep(for: retryDelay(failures))
                    continue
                }
                fail(error, attempt: attempt)
                return
            }
        }
    }

    private func apply(_ session: ProviderLoginSession) {
        // Versions only grow; a late answer to an older poll must not move back.
        if let version = session.version { lastVersion = max(version, lastVersion ?? version) }
        if answer?.isPending(in: session) == true { return }
        answer = nil
        if let step = session.step { lastStep = step }
        let next = ProviderLoginViewState.reduce(state, .session(session))
        if next.phase == .input, next.inputKind == .apiKey, let key = pendingKey {
            // The key was entered before the session started; answer OMP's
            // api-key step without adding a second key field to the transcript.
            pendingKey = nil
            state = next
            submit(key)
        } else {
            send(.session(session))
        }
        if state.phase == .completed {
            activeMethodID = nil
            sessionID = nil
            if let snapshot = state.snapshot {
                savedLabel = snapshot.label
                onCompleted?(snapshot)
            }
        } else if !state.isActive {
            activeMethodID = nil
            // A step this app cannot show ends the attempt while OMP still runs it.
            if session.status.isTerminal { sessionID = nil } else { endSession() }
        }
    }

    private func fail(_ error: Error, attempt: Int) {
        guard generation == attempt, !(error is CancellationError) else { return }
        let apiError = error as? CloudAPIError
        if apiError?.code == "invalid_login_input" { answer = nil }
        if OMPBackendSupport.isUnavailable(error) {
            backendUnavailable = true
            send(.failure(code: OMPBackendSupport.notConfiguredCode, reason: nil))
        } else {
            send(.failure(code: apiError?.code ?? "network_error", reason: apiError?.reason))
        }
        if !state.isActive {
            endSession()
            stopLoop()
            activeMethodID = nil
        }
    }

    /// Ends the server session, if any, so it does not hold an OMP login open.
    private func endSession() {
        guard let id = sessionID, let transport else { return }
        sessionID = nil
        Task { try? await transport.cancel(sessionID: id) }
    }

    private static func discard(_ session: ProviderLoginSession, transport: any ProviderLoginTransport) async {
        guard let id = session.sessionId?.nonEmpty, !session.status.isTerminal else { return }
        try? await transport.cancel(sessionID: id)
    }

    private func send(_ event: ProviderLoginEvent, answer: String? = nil) {
        let old = state
        state = ProviderLoginViewState.reduce(state, event)
        transcript.record(event, from: old, to: state, answer: answer)
    }

    private func stopLoop() {
        loopTask?.cancel()
        loopTask = nil
    }

    private static func isTransient(_ error: Error) -> Bool {
        guard !OMPBackendSupport.isUnavailable(error) else { return false }
        if OMPBackendSupport.isTransient(error) { return true }
        guard let error = error as? CloudAPIError else { return !(error is CancellationError) }
        return error.code == "network_error" || error.code == "proxy_unreachable"
            || (error.statusCode >= 500 && error.code == "server_error")
    }
}
