import Foundation

struct VoiceTranscription: Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable { case pending, ready, failed, unavailable }
    static let maximumAttempts = 3
    let status: Status
    let sourceVersion: String
    let engine: String
    var language: String? = nil
    let attempts: Int

    func bound(to source: String) -> Self {
        Self(status: status, sourceVersion: source, engine: engine, language: language, attempts: attempts)
    }
}

extension VoiceMessage {
    var spokenText: String {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if let transcription,
           transcription.status != .ready || transcription.sourceVersion != mediaId { return "" }
        return text == "Transcription unavailable." ? "" : text
    }

    var transcriptionLabel: String {
        if !spokenText.isEmpty { return "Transcript ready." }
        switch transcription?.status {
        case .pending: return "Transcription pending."
        case .failed: return "Transcription failed. Audio is preserved."
        default: return "Transcript unavailable for this recording."
        }
    }
}
