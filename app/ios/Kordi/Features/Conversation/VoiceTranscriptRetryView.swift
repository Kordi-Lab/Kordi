import SwiftUI

struct VoiceTranscriptPopover: View {
    @Environment(\.dismiss) private var dismiss
    let voice: VoiceMessage
    let onPrepare: (VoiceMessage) async -> URL?
    let onUpdate: ((VoiceMessage) async -> Bool)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Voice transcript")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                Button("Close", systemImage: "xmark") { dismiss() }
                    .labelStyle(.iconOnly)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .buttonStyle(.plain)
            }

            if voice.spokenText.isEmpty {
                Text(voice.transcriptionLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let onUpdate {
                    VoiceTranscriptRetryView(voice: voice, onPrepare: onPrepare, onUpdate: onUpdate)
                        .buttonStyle(.bordered)
                        .tint(KordiTheme.signalBlue)
                }
            } else {
                ViewThatFits(in: .vertical) {
                    transcriptText
                    ScrollView { transcriptText }
                        .frame(height: 260)
                }
                .frame(maxHeight: 260)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .frame(width: 280)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var transcriptText: some View {
        Text(voice.spokenText)
            .font(.body)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

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
