import XCTest
@testable import Kordi

final class ProviderLoginTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func session(_ status: ProviderLoginStatus, _ step: ProviderLoginStep? = nil) -> ProviderLoginSession {
        ProviderLoginSession(status: status, step: step)
    }

    private func reduce(_ events: ProviderLoginEvent...) -> ProviderLoginViewState {
        events.reduce(ProviderLoginViewState()) { ProviderLoginViewState.reduce($0, $1) }
    }

    // MARK: Decoding

    func testStepDecoderReadsEveryStepType() throws {
        XCTAssertEqual(
            try decode(ProviderLoginStep.self, #"{"type":"open-url","url":"https://example.com/a","launchUrl":"https://example.com/b","instructions":"Enter code: ABCD-1234"}"#),
            .openURL(url: "https://example.com/a", launchURL: "https://example.com/b", instructions: "Enter code: ABCD-1234")
        )
        XCTAssertEqual(
            try decode(ProviderLoginStep.self, #"{"type":"prompt","message":"Enter a domain","placeholder":"example.com","secret":true,"allowEmpty":true}"#),
            .prompt(message: "Enter a domain", placeholder: "example.com", secret: true, allowEmpty: true)
        )
        XCTAssertEqual(
            try decode(ProviderLoginStep.self, #"{"type":"prompt","message":"Name"}"#),
            .prompt(message: "Name", placeholder: nil, secret: false, allowEmpty: false)
        )
        XCTAssertEqual(
            try decode(ProviderLoginStep.self, #"{"type":"paste-code","instructions":"Paste the redirect URL"}"#),
            .pasteCode(instructions: "Paste the redirect URL")
        )
        XCTAssertEqual(try decode(ProviderLoginStep.self, #"{"type":"progress","message":"Working"}"#), .progress(message: "Working"))
        XCTAssertEqual(
            try decode(ProviderLoginStep.self, #"{"type":"api-key","instructions":"Copy a key","placeholder":"sk-...","authUrl":"https://example.com/keys"}"#),
            .apiKey(instructions: "Copy a key", placeholder: "sk-...", authURL: "https://example.com/keys")
        )
        XCTAssertEqual(try decode(ProviderLoginStep.self, #"{"type":"select"}"#), .unsupported(type: "select"))
    }

    func testSessionDecoderReadsStatusesAndSnapshot() throws {
        let started = try decode(ProviderLoginSession.self, #"{"sessionId":"login-1","status":"awaiting-input","step":{"type":"api-key"}}"#)
        XCTAssertEqual(started.sessionId, "login-1")
        XCTAssertEqual(started.status, .awaitingInput)
        XCTAssertEqual(started.step, .apiKey(instructions: nil, placeholder: nil, authURL: nil))

        let completed = try decode(ProviderLoginSession.self, #"{"status":"completed","snapshot":{"snapshotId":"s1","provider":"openai-codex","authChoice":"choice-1","label":"Work"}}"#)
        XCTAssertEqual(completed.snapshot, ProviderLoginSnapshot(snapshotId: "s1", provider: "openai-codex", authChoice: "choice-1", label: "Work"))
        XCTAssertTrue(completed.status.isTerminal)

        for raw in ["running", "claiming", "failed", "cancelled"] {
            let decoded = try decode(ProviderLoginSession.self, #"{"status":"\#(raw)"}"#)
            XCTAssertEqual(decoded.status.rawValue, raw)
        }
        let failed = try decode(ProviderLoginSession.self, #"{"status":"failed","error":"login_failed","reason":"denied"}"#)
        XCTAssertEqual(failed.error, "login_failed")
        XCTAssertEqual(failed.reason, "denied")
        XCTAssertEqual(try decode(ProviderLoginSession.self, #"{"status":"paused"}"#).status, .failed)
    }

    func testCatalogLoginDecodesAndMissingLoginFallsBackToEnvOnly() throws {
        let entry = try decode(OMPProviderCatalogEntry.self, """
        {"id":"example","models":["m"],"login":{"kind":"device-code","name":"Example","instructions":"Enter code: {user_code}",
         "validates":true,"pasteKey":false,"manualOnly":false,"callbackPort":1455,"hook":null,"envVars":["EXAMPLE_API_KEY"],
         "storeCredentialsAs":"example-store"}}
        """)
        XCTAssertEqual(entry.loginPolicy.kind, "device-code")
        XCTAssertEqual(entry.loginPolicy.instructions, "Enter code: {user_code}")
        XCTAssertEqual(entry.loginPolicy.callbackPort, 1455)
        XCTAssertTrue(entry.loginPolicy.validates)
        XCTAssertEqual(entry.loginPolicy.storeCredentialsAs, "example-store")

        let legacy = try decode(OMPProviderCatalogEntry.self, """
        {"id":"legacy","models":["m"],"auth":{"kind":"api-key","name":"Legacy","acceptsApiKey":true,
         "instructions":"Copy a key","authUrl":"https://example.com/keys","placeholder":"lk-...","envVars":["LEGACY_API_KEY"]}}
        """)
        XCTAssertNil(legacy.login)
        XCTAssertEqual(legacy.loginPolicy.kind, "env-only")
        XCTAssertEqual(legacy.loginPolicy.instructions, "Copy a key")
        XCTAssertEqual(legacy.loginPolicy.authUrl, "https://example.com/keys")
        XCTAssertEqual(legacy.loginPolicy.placeholder, "lk-...")
        XCTAssertEqual(try decode(OMPProviderLoginPolicy.self, "{}").kind, "env-only")

        let pinned = OMPProviderCatalog.pinned
        XCTAssertTrue(pinned.allSatisfy {
            ["api-key", "oauth-code", "device-code", "custom", "env-only"].contains($0.loginPolicy.kind)
        })
    }

    // MARK: Reducer

    func testOpenURLStepPrefersLaunchURLAndRejectsInsecureAddresses() {
        let state = reduce(.start, .session(session(.running, .openURL(
            url: "https://example.com/authorize", launchURL: "https://example.com/launch", instructions: "Complete sign-in"
        ))))
        XCTAssertEqual(state.phase, .signIn)
        XCTAssertEqual(state.stepName, "open-url")
        XCTAssertEqual(state.signInURL?.absoluteString, "https://example.com/launch")
        XCTAssertEqual(state.instructions, "Complete sign-in")
        XCTAssertNil(state.userCode)

        let insecure = reduce(.start, .session(session(.running, .openURL(url: "http://localhost:1455", launchURL: nil, instructions: nil))))
        XCTAssertEqual(insecure.phase, .failed)
    }

    func testDeviceCodeIsParsedAndKeptAcrossProgress() {
        var state = reduce(.start, .session(session(.running, .openURL(
            url: "https://example.com/device", launchURL: nil, instructions: "Enter code: PRVW-2468"
        ))))
        XCTAssertEqual(state.stepName, "device-code")
        XCTAssertEqual(state.userCode, "PRVW-2468")
        state = ProviderLoginViewState.reduce(state, .session(session(.running, .progress(message: "Waiting for approval…"))))
        XCTAssertEqual(state.phase, .signIn)
        XCTAssertEqual(state.userCode, "PRVW-2468")
        XCTAssertEqual(state.signInURL?.absoluteString, "https://example.com/device")
        XCTAssertEqual(state.status, "Waiting for approval…")

        XCTAssertEqual(ProviderLoginViewState.userCode(in: "Waiting for browser authorization (code: AB12-CD34)…"), "AB12-CD34")
        XCTAssertEqual(ProviderLoginViewState.userCode(in: "Visit the page and enter WXYZ-9876"), "WXYZ-9876")
        XCTAssertNil(ProviderLoginViewState.userCode(in: "Enter code: {user_code}"))
        XCTAssertNil(ProviderLoginViewState.userCode(in: "Paste the authorization code when prompted."))
    }

    func testAuthLinkKeepsSignInPageAndCodeAcrossLaterSteps() throws {
        let decoded = try decode(ProviderLoginSession.self, """
        {"sessionId":"login-2","status":"awaiting-input","version":7,
         "auth":{"url":"https://example.com/device","launchUrl":"https://example.com/device?code=1","instructions":"Enter code: QWER-5678"},
         "step":{"type":"prompt","message":"Paste the code shown after approval","secret":false}}
        """)
        XCTAssertEqual(decoded.version, 7)
        let state = reduce(.start, .session(decoded))
        XCTAssertEqual(state.phase, .input)
        XCTAssertEqual(state.signInURL?.absoluteString, "https://example.com/device?code=1")
        XCTAssertEqual(state.userCode, "QWER-5678")
        XCTAssertEqual(state.authInstructions, "Enter code: QWER-5678")

        let progressed = ProviderLoginViewState.reduce(state, .session(ProviderLoginSession(
            status: .running,
            step: .progress(message: "Exchanging…"),
            auth: ProviderLoginAuth(url: "https://example.com/device", instructions: "Enter code: QWER-5678")
        )))
        XCTAssertEqual(progressed.phase, .working)
        XCTAssertEqual(progressed.userCode, "QWER-5678")
        XCTAssertNotNil(progressed.signInURL)
    }

    func testPasteCodeKeepsSignInPageAndInstructions() {
        let state = reduce(
            .start,
            .session(session(.running, .openURL(url: "https://example.com/oauth", launchURL: nil, instructions: "Complete login in your browser."))),
            .session(session(.awaitingInput, .pasteCode(instructions: nil)))
        )
        XCTAssertEqual(state.phase, .input)
        XCTAssertEqual(state.inputKind, .pasteCode)
        XCTAssertEqual(state.stepName, "paste-code")
        XCTAssertEqual(state.signInURL?.absoluteString, "https://example.com/oauth")
        XCTAssertEqual(state.instructions, "Complete login in your browser.")
        XCTAssertFalse(state.isSecret)
    }

    func testPromptAndAPIKeyStepsDescribeTheirInput() {
        let prompt = reduce(.start, .session(session(.awaitingInput, .prompt(
            message: "Paste your token", placeholder: "tok_...", secret: true, allowEmpty: false
        ))))
        XCTAssertEqual(prompt.stepName, "prompt")
        XCTAssertEqual(prompt.message, "Paste your token")
        XCTAssertEqual(prompt.placeholder, "tok_...")
        XCTAssertTrue(prompt.isSecret)
        XCTAssertFalse(prompt.allowsEmpty)

        let optional = reduce(.start, .session(session(.awaitingInput, .prompt(
            message: "Domain (blank for default)", placeholder: nil, secret: false, allowEmpty: true
        ))))
        XCTAssertFalse(optional.isSecret)
        XCTAssertTrue(optional.allowsEmpty)

        let key = reduce(.start, .session(session(.awaitingInput, .apiKey(
            instructions: "Copy your key", placeholder: "csk-...", authURL: "https://example.com/keys"
        ))))
        XCTAssertEqual(key.stepName, "api-key")
        XCTAssertTrue(key.isSecret)
        XCTAssertEqual(key.keyURL?.absoluteString, "https://example.com/keys")
        let insecureKeyPage = reduce(.start, .session(session(.awaitingInput, .apiKey(
            instructions: nil, placeholder: nil, authURL: "http://example.com/keys"
        ))))
        XCTAssertNil(insecureKeyPage.keyURL)
    }

    /// After input OMP keeps the answered step with `running` while it checks
    /// the value; that step is not a new request for input.
    func testInputStepOnARunningSessionKeepsVerifying() {
        let key = ProviderLoginStep.apiKey(instructions: nil, placeholder: nil, authURL: nil)
        let submitted = reduce(.start, .session(session(.awaitingInput, key)), .submit)
        let checking = ProviderLoginViewState.reduce(submitted, .session(session(.running, key)))
        XCTAssertEqual(checking.phase, .working)
        XCTAssertEqual(checking.status, ProviderLoginViewState.verifyingMessage)

        let unanswered = reduce(.start, .session(session(.running, .prompt(message: "Token", placeholder: nil, secret: true, allowEmpty: false))))
        XCTAssertEqual(unanswered.phase, .working, "OMP is not waiting for this value")
        let saving = ProviderLoginViewState.reduce(submitted, .session(session(.claiming)))
        XCTAssertEqual(saving.phase, .working)
        XCTAssertEqual(saving.status, ProviderLoginViewState.savingMessage)
        XCTAssertFalse(ProviderLoginStatus.claiming.isTerminal)
    }

    func testProgressSubmitAndRejectedInput() {
        let progress = reduce(.start, .session(session(.running, .progress(message: "Initiating…"))))
        XCTAssertEqual(progress.phase, .working)
        XCTAssertEqual(progress.stepName, "progress")
        XCTAssertEqual(progress.status, "Initiating…")

        let waiting = reduce(.start, .session(session(.running)))
        XCTAssertEqual(waiting.phase, .working)

        let submitted = reduce(.start, .session(session(.awaitingInput, .apiKey(instructions: nil, placeholder: nil, authURL: nil))), .submit)
        XCTAssertEqual(submitted.phase, .working)
        XCTAssertEqual(submitted.status, ProviderLoginViewState.verifyingMessage)

        let rejected = ProviderLoginViewState.reduce(submitted, .failure(code: "invalid_login_input", reason: nil))
        XCTAssertEqual(rejected.phase, .input)
        XCTAssertEqual(rejected.inputKind, .apiKey)
        XCTAssertNotNil(rejected.inputError)
        XCTAssertTrue(rejected.isActive)
    }

    func testTerminalStates() {
        let snapshot = ProviderLoginSnapshot(snapshotId: "s1", provider: "anthropic", authChoice: "c1", label: "Team")
        let completed = reduce(.start, .session(ProviderLoginSession(status: .completed, snapshot: snapshot)))
        XCTAssertEqual(completed.phase, .completed)
        XCTAssertEqual(completed.snapshot, snapshot)
        XCTAssertFalse(completed.isActive)

        // Provider text is never shown; only known classifications are.
        let failed = reduce(.start, .session(ProviderLoginSession(status: .failed, error: "login_failed", reason: "The provider denied access")))
        XCTAssertEqual(failed.phase, .failed)
        XCTAssertEqual(failed.failure, "OMP could not finish signing in. Try again.")
        let rejected = reduce(.start, .session(ProviderLoginSession(status: .failed, error: "invalid_input")))
        XCTAssertEqual(rejected.failure, ProviderLoginViewState.reasonMessage("invalid_input"))

        XCTAssertEqual(reduce(.start, .session(session(.cancelled))).phase, .cancelled)
        XCTAssertEqual(reduce(.start, .cancel).phase, .cancelled)
        XCTAssertEqual(reduce(.start, .cancel, .reset), ProviderLoginViewState())
        XCTAssertEqual(reduce(.start, .session(session(.running, .unsupported(type: "select")))).phase, .failed)
    }

    func testErrorCodesMapToDistinctRecoveryText() {
        let codes = [
            "login_not_found", "login_expired", "login_failed", "invalid_login_input", "rate_limited",
            "omp_unavailable", "provider_auth_not_configured", "login_unsupported", "omp_busy", "network_error",
        ]
        let messages = codes.map { ProviderLoginViewState.failureMessage(code: $0, reason: nil) }
        XCTAssertEqual(Set(messages).count, codes.count)
        XCTAssertTrue(ProviderLoginViewState.failureMessage(code: "login_expired", reason: nil).contains("expired"))
        XCTAssertTrue(ProviderLoginViewState.failureMessage(code: "rate_limited", reason: nil).contains("Too many"))
    }

    func testFailureReasonsReadAsSentencesAndUnknownOnesAreDropped() {
        let reasons = ["invalid_input", "provider_rejected", "timeout", "unsupported_flow", "session_lost", "claim_failed"]
        let messages = reasons.map { ProviderLoginViewState.failureMessage(code: "login_failed", reason: $0) }
        XCTAssertEqual(Set(messages).count, reasons.count)
        for (reason, message) in zip(reasons, messages) {
            XCTAssertFalse(message.contains(reason), message)
            XCTAssertTrue(message.hasSuffix("."), message)
        }
        XCTAssertEqual(
            ProviderLoginViewState.failureMessage(code: "login_failed", reason: "invalid_input"),
            "OMP did not accept that value. Check it and start again."
        )
        for reason in ["unknown", "invalid_worker_state", "Provider said: synthetic-secret"] {
            XCTAssertEqual(ProviderLoginViewState.failureMessage(code: "login_failed", reason: reason), "OMP could not finish signing in. Try again.")
            XCTAssertEqual(ProviderLoginViewState.failureMessage(code: "some_new_code", reason: reason), "Sign-in failed. Try again.")
        }

        for code in ["login_not_found", "login_expired", "login_failed", "rate_limited", "omp_unavailable", "login_unsupported", "omp_busy"] {
            let state = reduce(.start, .failure(code: code, reason: nil))
            XCTAssertEqual(state.phase, .failed, code)
            XCTAssertFalse(state.isActive, code)
        }
        // Invalid input only keeps the step when an input step is on screen.
        XCTAssertEqual(reduce(.start, .failure(code: "invalid_login_input", reason: nil)).phase, .failed)
    }

    // MARK: Transcript

    private func transcript(_ events: [(ProviderLoginEvent, String?)]) -> ProviderLoginTranscript {
        var state = ProviderLoginViewState()
        var transcript = ProviderLoginTranscript()
        for (event, answer) in events {
            let old = state
            state = ProviderLoginViewState.reduce(state, event)
            transcript.record(event, from: old, to: state, answer: answer)
        }
        return transcript
    }

    func testTranscriptAppendsStepsInOrderAndKeepsAnswers() {
        let snapshot = ProviderLoginSnapshot(snapshotId: "s1", provider: "anthropic", authChoice: "c1", label: "Work")
        let entries = transcript([
            (.start, nil),
            (.session(session(.running, .openURL(url: "https://example.com/oauth", launchURL: nil, instructions: "Complete login."))), nil),
            (.session(session(.awaitingInput, .pasteCode(instructions: nil))), nil),
            (.submit, "code-123"),
            (.session(session(.running, .progress(message: "Exchanging…"))), nil),
            (.session(ProviderLoginSession(status: .completed, snapshot: snapshot)), nil),
        ]).entries.map(\.kind)
        XCTAssertEqual(entries.count, 6)
        XCTAssertEqual(entries[0], .progress("Connecting to OMP…"))
        XCTAssertEqual(entries[1], .auth(url: URL(string: "https://example.com/oauth")!, instructions: "Complete login.", userCode: nil))
        guard case .input(let input) = entries[2] else { return XCTFail("Expected the paste step") }
        XCTAssertEqual(input.kind, .pasteCode)
        XCTAssertTrue(input.isAnswered)
        XCTAssertEqual(input.answer, "code-123")
        XCTAssertEqual(entries[3], .progress(ProviderLoginViewState.verifyingMessage))
        XCTAssertEqual(entries[4], .progress("Exchanging…"))
        XCTAssertEqual(entries[5], .completed("Work"))
    }

    func testTranscriptHidesSecretsAndReopensRejectedInput() {
        var entries = transcript([
            (.start, nil),
            (.session(session(.awaitingInput, .prompt(message: "Domain", placeholder: nil, secret: false, allowEmpty: true))), nil),
            (.submit, "example.com"),
            (.session(session(.awaitingInput, .prompt(message: "Token", placeholder: "tok_", secret: true, allowEmpty: false))), nil),
            (.submit, "tok_secret"),
        ]).entries.map(\.kind)
        let answers = entries.compactMap { kind -> String? in
            if case .input(let input) = kind { return input.answer } else { return nil }
        }
        XCTAssertEqual(answers, ["example.com", ProviderLoginTranscript.hiddenAnswer])
        XCTAssertFalse(entries.description.contains("tok_secret"))

        entries = transcript([
            (.start, nil),
            (.session(session(.awaitingInput, .apiKey(instructions: nil, placeholder: nil, authURL: nil))), nil),
            (.submit, "bad"),
            (.failure(code: "invalid_login_input", reason: nil), nil),
        ]).entries.map(\.kind)
        guard case .input(let reopened) = entries.last else { return XCTFail("Expected the key step again") }
        XCTAssertFalse(reopened.isAnswered)
        XCTAssertNotNil(reopened.error)

        let device = transcript([
            (.start, nil),
            (.session(session(.running, .openURL(url: "https://example.com/device", launchURL: nil, instructions: "Enter code: PRVW-2468"))), nil),
            (.session(session(.running, .progress(message: "Waiting for browser authorization…"))), nil),
            (.failure(code: "login_expired", reason: nil), nil),
        ]).entries.map(\.kind)
        XCTAssertEqual(device[1], .auth(url: URL(string: "https://example.com/device")!, instructions: "Enter code: PRVW-2468", userCode: "PRVW-2468"))
        XCTAssertEqual(device[2], .progress("Waiting for browser authorization…"))
        XCTAssertEqual(device.last, .failure(ProviderLoginViewState.failureMessage(code: "login_expired", reason: nil)))
    }
}
