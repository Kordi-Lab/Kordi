import Foundation

// MARK: - Login session wire format

enum ProviderLoginStatus: String, Decodable, Equatable {
    case running
    case awaitingInput = "awaiting-input"
    /// The server is saving the finished login; OMP needs nothing more.
    case claiming
    case completed
    case failed
    case cancelled

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // An unknown status must stop polling rather than loop forever.
        self = ProviderLoginStatus(rawValue: raw) ?? .failed
    }

    var isTerminal: Bool { self == .completed || self == .failed || self == .cancelled }
}

enum ProviderLoginStep: Decodable, Equatable {
    case openURL(url: String, launchURL: String?, instructions: String?)
    case prompt(message: String, placeholder: String?, secret: Bool, allowEmpty: Bool)
    case pasteCode(instructions: String?)
    case progress(message: String)
    case apiKey(instructions: String?, placeholder: String?, authURL: String?)
    case unsupported(type: String)

    /// Steps that ask the user for a value.
    var isInput: Bool {
        switch self {
        case .prompt, .pasteCode, .apiKey: true
        case .openURL, .progress, .unsupported: false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, url, launchUrl, instructions, message, placeholder, secret, allowEmpty, authUrl
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let type = try values.decode(String.self, forKey: .type)
        switch type {
        case "open-url":
            self = .openURL(
                url: try values.decode(String.self, forKey: .url),
                launchURL: try values.decodeIfPresent(String.self, forKey: .launchUrl),
                instructions: try values.decodeIfPresent(String.self, forKey: .instructions)
            )
        case "prompt":
            self = .prompt(
                message: try values.decodeIfPresent(String.self, forKey: .message) ?? "",
                placeholder: try values.decodeIfPresent(String.self, forKey: .placeholder),
                secret: try values.decodeIfPresent(Bool.self, forKey: .secret) ?? false,
                allowEmpty: try values.decodeIfPresent(Bool.self, forKey: .allowEmpty) ?? false
            )
        case "paste-code":
            self = .pasteCode(instructions: try values.decodeIfPresent(String.self, forKey: .instructions))
        case "progress":
            self = .progress(message: try values.decodeIfPresent(String.self, forKey: .message) ?? "")
        case "api-key":
            self = .apiKey(
                instructions: try values.decodeIfPresent(String.self, forKey: .instructions),
                placeholder: try values.decodeIfPresent(String.self, forKey: .placeholder),
                authURL: try values.decodeIfPresent(String.self, forKey: .authUrl)
            )
        default:
            self = .unsupported(type: type)
        }
    }
}

/// The latest sign-in link. The server keeps it after later steps so the page
/// and any device code stay available.
struct ProviderLoginAuth: Decodable, Equatable {
    let url: String
    let launchUrl: String?
    let instructions: String?

    init(url: String, launchUrl: String? = nil, instructions: String? = nil) {
        self.url = url
        self.launchUrl = launchUrl
        self.instructions = instructions
    }
}

struct ProviderLoginSnapshot: Decodable, Equatable {
    let snapshotId: String
    let provider: String
    let authChoice: String
    let label: String?
}

struct ProviderLoginSession: Decodable, Equatable {
    let sessionId: String?
    let status: ProviderLoginStatus
    let step: ProviderLoginStep?
    let auth: ProviderLoginAuth?
    let error: String?
    let reason: String?
    /// Changes on every update; sent back as `after` so a poll returns at once.
    let version: Int?
    let snapshot: ProviderLoginSnapshot?

    init(
        sessionId: String? = nil,
        status: ProviderLoginStatus,
        step: ProviderLoginStep? = nil,
        auth: ProviderLoginAuth? = nil,
        error: String? = nil,
        reason: String? = nil,
        version: Int? = nil,
        snapshot: ProviderLoginSnapshot? = nil
    ) {
        self.sessionId = sessionId
        self.status = status
        self.step = step
        self.auth = auth
        self.error = error
        self.reason = reason
        self.version = version
        self.snapshot = snapshot
    }
}

// MARK: - View state

enum ProviderLoginEvent: Equatable {
    case start
    case session(ProviderLoginSession)
    case submit
    case failure(code: String, reason: String?)
    case cancel
    case reset
}

/// What the Add-account section shows. `ProviderLoginViewState.reduce` is the
/// only place that maps login-session steps and errors to this state.
struct ProviderLoginViewState: Equatable {
    enum Phase: Equatable {
        case idle, starting, signIn, input, working, completed, failed, cancelled
    }

    enum InputKind: Equatable {
        case apiKey, pasteCode, prompt
    }

    var phase: Phase = .idle
    var inputKind: InputKind?
    var instructions: String?
    var message: String?
    var placeholder: String?
    var isSecret = false
    var allowsEmpty = false
    /// The last sign-in page OMP asked the user to open; kept across later steps.
    var signInURL: URL?
    var keyURL: URL?
    /// A device code parsed from OMP's instructions or progress text.
    var userCode: String?
    /// Instructions that came with the sign-in link.
    var authInstructions: String?
    var status: String?
    var inputError: String?
    var failure: String?
    var snapshot: ProviderLoginSnapshot?

    var isActive: Bool {
        switch phase {
        case .starting, .signIn, .input, .working: true
        default: false
        }
    }

    /// Stable step name for accessibility and tests.
    var stepName: String {
        switch phase {
        case .idle: "idle"
        case .starting: "starting"
        case .signIn: userCode == nil ? "open-url" : "device-code"
        case .input:
            switch inputKind {
            case .apiKey: "api-key"
            case .pasteCode: "paste-code"
            case .prompt, nil: "prompt"
            }
        case .working: "progress"
        case .completed: "completed"
        case .failed: "failed"
        case .cancelled: "cancelled"
        }
    }

    static let verifyingMessage = "Verifying with OMP…"
    static let savingMessage = "Saving the account…"

    static func reduce(_ state: ProviderLoginViewState, _ event: ProviderLoginEvent) -> ProviderLoginViewState {
        switch event {
        case .start:
            return ProviderLoginViewState(phase: .starting, status: "Connecting to OMP…")
        case .reset:
            return ProviderLoginViewState()
        case .cancel:
            return ProviderLoginViewState(phase: .cancelled)
        case .submit:
            var next = state
            next.phase = .working
            next.status = verifyingMessage
            next.inputError = nil
            return next
        case .failure(let code, let reason):
            if code == "invalid_login_input", state.inputKind != nil,
               state.phase == .working || state.phase == .input {
                var next = state
                next.phase = .input
                next.status = nil
                next.inputError = failureMessage(code: code, reason: reason)
                return next
            }
            return failed(state, failureMessage(code: code, reason: reason))
        case .session(let session):
            return apply(session, to: state)
        }
    }

    private static func apply(_ session: ProviderLoginSession, to state: ProviderLoginViewState) -> ProviderLoginViewState {
        switch session.status {
        case .completed:
            var next = ProviderLoginViewState(phase: .completed)
            next.snapshot = session.snapshot
            return next
        case .cancelled:
            return ProviderLoginViewState(phase: .cancelled)
        case .failed:
            // OMP reports its failure classification in `error`.
            return failed(state, failureMessage(code: "login_failed", reason: session.reason ?? session.error))
        case .running, .awaitingInput, .claiming:
            break
        }
        var next = state
        next.inputError = nil
        next.failure = nil
        // `auth` outlives the step that created it; keep its page and code visible.
        if let auth = session.auth {
            guard let target = httpsURL(auth.launchUrl) ?? httpsURL(auth.url) else {
                return failed(state, "OMP returned a sign-in address Kordi cannot open.")
            }
            next.signInURL = target
            next.userCode = userCode(in: auth.instructions) ?? next.userCode
            next.authInstructions = auth.instructions?.nonEmpty ?? next.authInstructions
        }
        guard let step = session.step else {
            if next.phase != .signIn { next.phase = .working }
            next.status = session.status == .claiming ? savingMessage : next.status ?? "Waiting for OMP…"
            return next
        }
        if step.isInput, session.status != .awaitingInput {
            // OMP reads input only while awaiting it; an input step on a running
            // session is the value it is still checking.
            next.phase = .working
            next.status = state.phase == .working ? state.status ?? verifyingMessage : "Waiting for OMP…"
            return next
        }
        switch step {
        case .openURL(let url, let launchURL, let instructions):
            guard let target = httpsURL(launchURL) ?? httpsURL(url) else {
                return failed(state, "OMP returned a sign-in address Kordi cannot open.")
            }
            next.phase = .signIn
            next.inputKind = nil
            next.signInURL = target
            next.instructions = instructions?.nonEmpty
            next.authInstructions = instructions?.nonEmpty ?? next.authInstructions
            next.userCode = userCode(in: instructions) ?? next.userCode
            next.status = nil
        case .prompt(let message, let placeholder, let secret, let allowEmpty):
            next.phase = .input
            next.inputKind = .prompt
            next.message = message.nonEmpty
            next.placeholder = placeholder?.nonEmpty
            next.isSecret = secret
            next.allowsEmpty = allowEmpty
            next.status = nil
        case .pasteCode(let instructions):
            next.phase = .input
            next.inputKind = .pasteCode
            next.instructions = instructions?.nonEmpty ?? state.instructions
            next.message = nil
            next.placeholder = nil
            next.isSecret = false
            next.allowsEmpty = false
            next.status = nil
        case .progress(let message):
            if next.phase != .signIn { next.phase = .working }
            next.status = message.nonEmpty ?? "Waiting for OMP…"
            next.userCode = next.userCode ?? userCode(in: message)
        case .apiKey(let instructions, let placeholder, let authURL):
            next.phase = .input
            next.inputKind = .apiKey
            next.instructions = instructions?.nonEmpty
            next.message = nil
            next.placeholder = placeholder?.nonEmpty
            next.keyURL = httpsURL(authURL)
            next.isSecret = true
            next.allowsEmpty = false
            next.status = nil
        case .unsupported:
            return failed(state, "This sign-in step needs Kordi on your Mac. Open Settings → Authentication there.")
        }
        return next
    }

    private static func failed(_ state: ProviderLoginViewState, _ message: String) -> ProviderLoginViewState {
        var next = ProviderLoginViewState(phase: .failed)
        next.failure = message
        return next
    }

    static func failureMessage(code: String, reason: String?) -> String {
        switch code {
        case "login_not_found":
            return "This sign-in is no longer available. Start again."
        case "login_expired":
            return "This sign-in expired. Start again."
        case "login_failed":
            return reasonMessage(reason) ?? "OMP could not finish signing in. Try again."
        case "invalid_login_input":
            return "OMP did not accept that value. Check it and try again."
        case "login_unsupported":
            return unsupportedMessage
        case "omp_busy":
            return "OMP is handling other sign-ins. Wait a moment, then try again."
        case "rate_limited":
            return "Too many sign-in attempts. Wait a minute, then try again."
        case OMPBackendSupport.notConfiguredCode:
            return OMPBackendSupport.unavailableMessage
        case OMPBackendSupport.transientCode:
            return OMPBackendSupport.transientMessage
        case "network_error", "proxy_unreachable":
            return "Could not reach Kordi Cloud. Check your connection and try again."
        case "invalid_session", "account_missing":
            return "Your Kordi session expired. Sign in again, then add the account."
        case "login_cancelled":
            return "Sign-in was canceled."
        case "provider_auth_error":
            return "Kordi Cloud could not save this account. Try again."
        default:
            return reasonMessage(reason) ?? "Sign-in failed. Try again."
        }
    }

    private static let unsupportedMessage = "This sign-in method is not available from Kordi Cloud yet. Add the account in Kordi on your Mac."

    /// The failure classifications OMP and Kordi Cloud report. Unknown values
    /// are never shown: they are identifiers, not sentences.
    static func reasonMessage(_ reason: String?) -> String? {
        switch reason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "invalid_input":
            return "OMP did not accept that value. Check it and start again."
        case "provider_rejected":
            return "The provider did not accept this sign-in. Check the account and try again."
        case "timeout":
            return "The sign-in timed out. Start again."
        case "unsupported_flow", "unknown_provider":
            return unsupportedMessage
        case "session_lost", "start_failed":
            return "OMP stopped this sign-in. Start again."
        case "claim_failed", "save_failed":
            return "Sign-in finished, but Kordi Cloud could not save the account. Start again."
        default:
            return nil
        }
    }

    static func httpsURL(_ value: String?) -> URL? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
              let url = URL(string: value), url.scheme?.lowercased() == "https", url.host != nil else {
            return nil
        }
        return url
    }

    /// Finds a device code such as `ABCD-1234` in OMP text like `Enter code: ABCD-1234`.
    static func userCode(in text: String?) -> String? {
        guard let text else { return nil }
        let patterns = [
            #"(?i)code:\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)"#,
            #"\b([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)\b"#,
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let range = Range(match.range(at: 1), in: text) else { continue }
            return String(text[range])
        }
        return nil
    }
}
