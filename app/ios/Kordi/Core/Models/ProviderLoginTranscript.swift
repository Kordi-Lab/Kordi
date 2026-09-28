import Foundation

// MARK: - Transcript

/// One line of the login screen's transcript, which mirrors OMP's login
/// dialog: steps are appended in order and earlier answers stay visible.
struct ProviderLoginTranscriptEntry: Identifiable, Equatable {
    enum Kind: Equatable {
        case auth(url: URL, instructions: String?, userCode: String?)
        case input(Input)
        case progress(String)
        case failure(String)
        case completed(String)
        case cancelled
    }

    struct Input: Equatable {
        var kind: ProviderLoginViewState.InputKind
        var message: String?
        var instructions: String?
        var placeholder: String?
        var isSecret: Bool
        var allowsEmpty: Bool
        /// What the user sent; secrets and keys are never kept.
        var answer: String?
        var isAnswered: Bool
        var error: String?
    }

    let id: Int
    var kind: Kind
}

struct ProviderLoginTranscript: Equatable {
    private(set) var entries: [ProviderLoginTranscriptEntry] = []
    private var nextID = 0

    static let hiddenAnswer = "Hidden"

    /// The input awaiting an answer, if any.
    var activeInput: ProviderLoginTranscriptEntry.Input? {
        guard let last = entries.last(where: { if case .input = $0.kind { true } else { false } }),
              case .input(let input) = last.kind, !input.isAnswered else { return nil }
        return input
    }

    mutating func record(
        _ event: ProviderLoginEvent,
        from old: ProviderLoginViewState,
        to new: ProviderLoginViewState,
        answer: String? = nil
    ) {
        switch event {
        case .start:
            entries.removeAll()
            appendProgress(new.status ?? "Connecting to OMP…")
        case .reset:
            entries.removeAll()
        case .cancel:
            append(.cancelled)
        case .submit:
            if let index = lastInputIndex, case .input(var input) = entries[index].kind, !input.isAnswered {
                input.isAnswered = true
                input.error = nil
                input.answer = input.isSecret || input.kind == .apiKey ? Self.hiddenAnswer : answer?.nonEmpty
                entries[index].kind = .input(input)
            }
            appendProgress(new.status ?? ProviderLoginViewState.verifyingMessage)
        case .failure(let code, _):
            if code == "invalid_login_input", new.phase == .input {
                if let index = lastInputIndex, case .input(var input) = entries[index].kind {
                    input.isAnswered = false
                    input.answer = nil
                    input.error = new.inputError
                    entries[index].kind = .input(input)
                    entries.removeSubrange((index + 1)...)
                } else {
                    appendInput(from: new)
                }
            } else if let failure = new.failure {
                append(.failure(failure))
            }
        case .session:
            recordSession(from: old, to: new)
        }
    }

    private mutating func recordSession(from old: ProviderLoginViewState, to new: ProviderLoginViewState) {
        switch new.phase {
        case .completed:
            append(.completed(new.snapshot?.label?.nonEmpty ?? "your account"))
            return
        case .failed:
            append(.failure(new.failure ?? "Sign-in failed. Try again."))
            return
        case .cancelled:
            append(.cancelled)
            return
        default:
            break
        }
        if let url = new.signInURL {
            let instructions = new.phase == .signIn ? (new.instructions ?? new.authInstructions) : new.authInstructions
            if let index = entries.lastIndex(where: {
                if case .auth(let existing, _, _) = $0.kind { existing == url } else { false }
            }) {
                if case .auth(_, let oldInstructions, let oldCode) = entries[index].kind {
                    entries[index].kind = .auth(
                        url: url, instructions: instructions ?? oldInstructions, userCode: new.userCode ?? oldCode
                    )
                }
            } else {
                append(.auth(url: url, instructions: instructions, userCode: new.userCode))
            }
        }
        if new.phase == .input {
            let changed = activeInput.map {
                $0.kind != new.inputKind || $0.message != new.message || $0.placeholder != new.placeholder
            } ?? true
            if changed { appendInput(from: new) }
        } else if let status = new.status, status != old.status || !lastIsProgress(status) {
            appendProgress(status)
        }
    }

    private var lastInputIndex: Int? {
        entries.lastIndex { if case .input = $0.kind { true } else { false } }
    }

    private func lastIsProgress(_ message: String) -> Bool {
        if case .progress(let last) = entries.last?.kind { return last == message }
        return false
    }

    private mutating func appendProgress(_ message: String) {
        guard !lastIsProgress(message) else { return }
        append(.progress(message))
    }

    private mutating func appendInput(from state: ProviderLoginViewState) {
        append(.input(.init(
            kind: state.inputKind ?? .prompt,
            message: state.message,
            // The sign-in link above already shows its own instructions.
            instructions: state.inputKind == .prompt || state.instructions == state.authInstructions
                ? nil : state.instructions,
            placeholder: state.placeholder,
            isSecret: state.isSecret,
            allowsEmpty: state.allowsEmpty,
            answer: nil,
            isAnswered: false,
            error: state.inputError
        )))
    }

    private mutating func append(_ kind: ProviderLoginTranscriptEntry.Kind) {
        entries.append(ProviderLoginTranscriptEntry(id: nextID, kind: kind))
        nextID += 1
    }
}
