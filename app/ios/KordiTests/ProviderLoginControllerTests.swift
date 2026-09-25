import XCTest
@testable import Kordi

/// Drives `ProviderLoginController` with a scripted transport that answers
/// like the hosted login worker.
@MainActor
final class ProviderLoginControllerTests: XCTestCase {
    /// Answers each poll with the next scripted result and waits while none is
    /// queued, like a long poll with no change.
    private actor ScriptedTransport: ProviderLoginTransport {
        private let started: ProviderLoginSession
        private let startError: Error?
        private let startDelay: Duration
        private var script: [Result<ProviderLoginSession, Error>] = []
        private var submitErrors: [Error]
        private(set) var starts = 0
        private(set) var polls = 0
        private(set) var submitted: [String] = []
        private(set) var cancelled: [String] = []

        init(
            started: ProviderLoginSession = ProviderLoginSession(sessionId: "login-1", status: .running, version: 1),
            startError: Error? = nil,
            startDelay: Duration = .zero,
            submitErrors: [Error] = []
        ) {
            self.started = started
            self.startError = startError
            self.startDelay = startDelay
            self.submitErrors = submitErrors
        }

        func enqueue(_ results: Result<ProviderLoginSession, Error>...) {
            script.append(contentsOf: results)
        }

        func start(provider: String, label: String, mode: String?, method: String?) async throws -> ProviderLoginSession {
            starts += 1
            if startDelay > .zero { try await Task.sleep(for: startDelay) }
            if let startError { throw startError }
            return started
        }

        func poll(sessionID: String, after version: Int?) async throws -> ProviderLoginSession {
            polls += 1
            while script.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
            return try script.removeFirst().get()
        }

        func submit(sessionID: String, value: String) async throws {
            submitted.append(value)
            if !submitErrors.isEmpty { throw submitErrors.removeFirst() }
        }

        func cancel(sessionID: String) async throws {
            cancelled.append(sessionID)
        }
    }

    private static let keyStep = ProviderLoginStep.apiKey(instructions: nil, placeholder: "csk-...", authURL: nil)

    private func method(_ id: String, kind: String) throws -> ProviderLoginMethod {
        let entry = OMPProviderCatalogEntry(id: id, login: OMPProviderLoginPolicy(kind: kind, name: id), models: ["m"])
        return try XCTUnwrap(ProviderLoginMethod.methods(for: entry).first)
    }

    private func makeController(retryDelay: Duration = .milliseconds(10)) -> ProviderLoginController {
        let controller = ProviderLoginController()
        controller.retryDelay = { _ in retryDelay }
        return controller
    }

    private func wait(
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line,
        until condition: () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while await !condition() {
            guard Date() < deadline else { return XCTFail("Timed out waiting", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func inputEntries(_ controller: ProviderLoginController) -> Int {
        controller.transcript.entries.filter { if case .input = $0.kind { true } else { false } }.count
    }

    // MARK: Verifying after input

    /// After Save the worker keeps the answered step with `running`, and an
    /// in-flight poll may still return the earlier `awaiting-input` snapshot.
    /// Neither may reopen the field; the final status decides.
    func testAnsweredStepStaysVerifyingUntilOMPMovesOn() async throws {
        let transport = ScriptedTransport(
            started: ProviderLoginSession(sessionId: "login-1", status: .awaitingInput, step: Self.keyStep, version: 1)
        )
        let controller = makeController()
        var saved: [ProviderLoginSnapshot] = []
        controller.start(try method("cerebras", kind: "api-key"), label: "Team", transport: transport) { saved.append($0) }
        try await wait { controller.state.phase == .input }
        XCTAssertEqual(inputEntries(controller), 1)

        controller.submit("csk-synthetic")
        XCTAssertEqual(controller.state.phase, .working)
        await transport.enqueue(
            .success(ProviderLoginSession(sessionId: "login-1", status: .awaitingInput, step: Self.keyStep, version: 1)),
            .success(ProviderLoginSession(sessionId: "login-1", status: .running, step: Self.keyStep, version: 2))
        )
        try await wait { await transport.polls >= 3 }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(controller.state.phase, .working)
        XCTAssertEqual(controller.state.status, ProviderLoginViewState.verifyingMessage)
        XCTAssertNil(controller.transcript.activeInput, "The answered field must not reopen")
        XCTAssertEqual(inputEntries(controller), 1, "No second key field is appended")

        let snapshot = ProviderLoginSnapshot(snapshotId: "s1", provider: "cerebras", authChoice: "cloud-login:1", label: "Team")
        await transport.enqueue(.success(ProviderLoginSession(sessionId: "login-1", status: .completed, snapshot: snapshot)))
        try await wait { controller.state.phase == .completed }
        XCTAssertEqual(saved, [snapshot])
        let submitted = await transport.submitted
        XCTAssertEqual(submitted, ["csk-synthetic"], "The value is sent once")
    }

    /// A newer request for the same step is OMP asking again.
    func testNewerRequestForTheSameStepReopensTheField() async throws {
        let prompt = ProviderLoginStep.prompt(message: "Token", placeholder: nil, secret: true, allowEmpty: false)
        let transport = ScriptedTransport(
            started: ProviderLoginSession(sessionId: "login-1", status: .awaitingInput, step: prompt, version: 4)
        )
        let controller = makeController()
        controller.start(try method("example", kind: "custom"), label: "Work", transport: transport) { _ in }
        try await wait { controller.state.phase == .input }
        controller.submit("token-one")
        await transport.enqueue(
            .success(ProviderLoginSession(sessionId: "login-1", status: .running, step: prompt, version: 5)),
            .success(ProviderLoginSession(sessionId: "login-1", status: .awaitingInput, step: prompt, version: 6))
        )
        try await wait { controller.state.phase == .input }
        XCTAssertNotNil(controller.transcript.activeInput)
    }

    // MARK: Failures and cancellation

    func testFailureCancelsTheServerSession() async throws {
        let transport = ScriptedTransport()
        let controller = makeController()
        controller.start(try method("kimi-code", kind: "device-code"), label: "Work", transport: transport) { _ in }
        await transport.enqueue(.failure(CloudAPIError(code: "login_expired", message: "Expired", statusCode: 410)))
        try await wait { controller.state.phase == .failed }
        try await wait { await transport.cancelled == ["login-1"] }
    }

    func testCancelWhileStartingEndsTheLateSession() async throws {
        let transport = ScriptedTransport(startDelay: .milliseconds(300))
        let controller = makeController()
        controller.start(try method("kimi-code", kind: "device-code"), label: "Work", transport: transport) { _ in }
        XCTAssertEqual(controller.state.phase, .starting)
        controller.cancel()
        XCTAssertEqual(controller.state.phase, .cancelled)
        try await wait { await transport.cancelled == ["login-1"] }
        XCTAssertEqual(controller.state.phase, .cancelled, "The late start must not reopen the attempt")
    }

    func testSubmitRetriesAPassingFailureOnlyWhileNothingChanged() async throws {
        let network = CloudAPIError(code: "network_error", message: "Offline", statusCode: 0)
        let started = ProviderLoginSession(sessionId: "login-1", status: .awaitingInput, step: Self.keyStep, version: 1)
        let retried = ScriptedTransport(started: started, submitErrors: [network])
        let first = makeController()
        first.start(try method("cerebras", kind: "api-key"), label: "Team", transport: retried) { _ in }
        try await wait { first.state.phase == .input }
        first.submit("csk-synthetic")
        try await wait { await retried.submitted.count == 2 }
        XCTAssertEqual(first.state.phase, .working)

        // The value arrived although its response was lost: OMP moved on.
        let received = ScriptedTransport(started: started, submitErrors: [network])
        let second = makeController(retryDelay: .milliseconds(300))
        second.start(try method("cerebras", kind: "api-key"), label: "Team", transport: received) { _ in }
        try await wait { second.state.phase == .input }
        second.submit("csk-synthetic")
        await received.enqueue(.success(ProviderLoginSession(sessionId: "login-1", status: .running, step: Self.keyStep, version: 2)))
        try await Task.sleep(for: .milliseconds(600))
        let sent = await received.submitted
        XCTAssertEqual(sent.count, 1, "A received value is not sent again")
        XCTAssertEqual(second.state.phase, .working)
    }

    // MARK: Backend without OMP

    func testOnlyA404OrUnconfiguredBackendIsUnavailable() {
        let notFound = CloudAPIError(code: "server_error", message: "Not found", statusCode: 404)
        let notConfigured = CloudAPIError(code: "provider_auth_not_configured", message: "Off", statusCode: 503)
        let passing = CloudAPIError(code: "omp_unavailable", message: "Unavailable", statusCode: 503)
        XCTAssertTrue(OMPBackendSupport.isUnavailable(notFound))
        XCTAssertTrue(OMPBackendSupport.isUnavailable(notConfigured))
        XCTAssertFalse(OMPBackendSupport.isUnavailable(passing))
        XCTAssertTrue(OMPBackendSupport.isTransient(passing))
        for code in ["login_not_found", "account_unavailable"] {
            XCTAssertFalse(OMPBackendSupport.isUnavailable(CloudAPIError(code: code, message: "", statusCode: 404)), code)
        }
        XCTAssertFalse(OMPBackendSupport.isUnavailable(CloudAPIError(code: "server_error", message: "", statusCode: 500)))
        XCTAssertFalse(OMPBackendSupport.isUnavailable(URLError(.timedOut)))
        XCTAssertEqual(ProviderLoginViewState.failureMessage(code: OMPBackendSupport.notConfiguredCode, reason: nil), OMPBackendSupport.unavailableMessage)
        XCTAssertEqual(ProviderLoginViewState.failureMessage(code: OMPBackendSupport.transientCode, reason: nil), OMPBackendSupport.transientMessage)
    }

    func testUnavailableBackendFailsOnceWithTheBackendMessage() async throws {
        for error in [
            CloudAPIError(code: "server_error", message: "Not found", statusCode: 404),
            CloudAPIError(code: "provider_auth_not_configured", message: "Off", statusCode: 503),
        ] {
            let transport = ScriptedTransport(startError: error)
            let controller = makeController()
            controller.start(try method("kimi-code", kind: "device-code"), label: "Work", transport: transport) { _ in }
            try await wait { controller.state.phase == .failed }
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertEqual(controller.state.failure, OMPBackendSupport.unavailableMessage)
            XCTAssertTrue(controller.backendUnavailable)
            let starts = await transport.starts
            let polls = await transport.polls
            XCTAssertEqual(starts, 1)
            XCTAssertEqual(polls, 0)
        }
    }

    func testPassingWorkerFailureOnStartCanBeRetried() async throws {
        let transport = ScriptedTransport(startError: CloudAPIError(code: "omp_unavailable", message: "Unavailable", statusCode: 503))
        let controller = makeController()
        controller.start(try method("kimi-code", kind: "device-code"), label: "Work", transport: transport) { _ in }
        try await wait { controller.state.phase == .failed }
        XCTAssertEqual(controller.state.failure, OMPBackendSupport.transientMessage)
        XCTAssertFalse(controller.backendUnavailable, "Try again stays available")
    }

    func testPassingWorkerFailureWhilePollingIsRetried() async throws {
        let transport = ScriptedTransport()
        let controller = makeController()
        controller.start(try method("kimi-code", kind: "device-code"), label: "Work", transport: transport) { _ in }
        let snapshot = ProviderLoginSnapshot(snapshotId: "s1", provider: "kimi-code", authChoice: "cloud-login:1", label: "Work")
        await transport.enqueue(
            .failure(CloudAPIError(code: "omp_unavailable", message: "Unavailable", statusCode: 503)),
            .failure(CloudAPIError(code: "omp_busy", message: "Busy", statusCode: 503)),
            .success(ProviderLoginSession(sessionId: "login-1", status: .completed, snapshot: snapshot))
        )
        try await wait { controller.state.phase == .completed }
        XCTAssertFalse(controller.backendUnavailable)
        let polls = await transport.polls
        XCTAssertEqual(polls, 3)
    }

    func testCatalogMarksTheBackendOnlyWhenOMPIsMissing() async throws {
        let suiteName = "ProviderLoginControllerTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = AppModel(
            cache: try LocalMessageStore(inMemory: true),
            sessionRuntimeRouteStore: SessionRuntimeRouteStore(defaults: defaults),
            previewMode: true
        )
        await model.refreshOMPProviderCatalog { throw CloudAPIError(code: "omp_unavailable", message: "Down", statusCode: 503) }
        XCTAssertFalse(model.ompBackendUnavailable, "A passing worker failure keeps OMP actions available")
        await model.refreshOMPProviderCatalog { throw CloudAPIError(code: "server_error", message: "Not found", statusCode: 404) }
        XCTAssertTrue(model.ompBackendUnavailable)
        XCTAssertEqual(model.ompProviderCatalog, OMPProviderCatalog.pinned)
        XCTAssertNil(model.providerAuthenticationErrorMessage)
        XCTAssertGreaterThanOrEqual(model.authenticationProviderDefinitions.count, 60)

        await model.refreshOMPProviderCatalog { throw CloudAPIError(code: "server_error", message: "Down", statusCode: 500) }
        XCTAssertTrue(model.ompBackendUnavailable, "Other failures leave the state unchanged")
        await model.refreshOMPProviderCatalog {
            OMPProviderCatalog(providers: [OMPProviderCatalogEntry(id: "cerebras", models: ["m"])])
        }
        XCTAssertFalse(model.ompBackendUnavailable)
        await model.refreshOMPProviderCatalog { throw CloudAPIError(code: "provider_auth_not_configured", message: "Off", statusCode: 503) }
        XCTAssertTrue(model.ompBackendUnavailable)
    }
}
