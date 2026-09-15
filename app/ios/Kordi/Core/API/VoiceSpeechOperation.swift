import Foundation
import Speech

/// Completes exactly once on success, error, cancellation, or a bounded timeout.
@MainActor
final class VoiceSpeechOperation {
    private var continuation: CheckedContinuation<String, Error>?
    private var recognition: SFSpeechRecognitionTask?
    private var timeout: Task<Void, Never>?

    func run(recognizer: SFSpeechRecognizer, request: SFSpeechURLRecognitionRequest) async throws -> String {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    let text = result?.isFinal == true ? result?.bestTranscription.formattedString : nil
                    Task { @MainActor [weak self] in
                        if let error { self?.finish(.failure(error)) }
                        else if let text {
                            let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
                            self?.finish(text.isEmpty ? .failure(VoiceSpeechError.noSpeech) : .success(text))
                        }
                    }
                }
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                    self?.finish(.failure(VoiceSpeechError.timedOut))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel() }
        }
    }

    func cancel() { finish(.failure(CancellationError())) }

    private func finish(_ result: Result<String, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel()
        timeout = nil
        recognition?.cancel()
        recognition = nil
        continuation.resume(with: result)
    }
}

private enum VoiceSpeechError: LocalizedError {
    case noSpeech, timedOut
    var errorDescription: String? {
        switch self {
        case .noSpeech: "No recognizable speech was found. Retry or record another message."
        case .timedOut: "Transcription timed out. Retry or record another message."
        }
    }
}
