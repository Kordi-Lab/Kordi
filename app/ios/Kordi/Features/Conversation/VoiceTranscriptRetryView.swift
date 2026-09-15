import SwiftUI

struct VoiceTranscriptRetryView: View {
    let voice: VoiceMessage
    let onPrepare: (VoiceMessage) async -> URL?
    let onUpdate: (VoiceMessage) async -> Bool
    @State private var busy = false
    @State private var completed = false
    @State private var cached: VoiceMessage?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading) {
            Button(busy ? "Transcribing…" : "Retry transcription") {
                guard !busy else { return }
                busy = true
                Task {
                    defer { busy = false }
                    if cached == nil {
                        guard let url = await onPrepare(voice) else {
                            notice = "Audio is unavailable. Refresh the message before retrying."
                            return
                        }
                        cached = await VoiceMessageRecorder().transcribeExisting(voice, url: url)
                    }
                    guard let cached, !Task.isCancelled else { return }
                    completed = await onUpdate(cached)
                    notice = completed ? cached.transcriptionLabel : "Could not update transcription. Refresh and retry."
                }
            }
            .frame(minHeight: 44)
            .disabled(busy || completed || (voice.transcription?.attempts ?? 0) >= VoiceTranscription.maximumAttempts)
            if let notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
