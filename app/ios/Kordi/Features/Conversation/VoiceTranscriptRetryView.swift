import SwiftUI

struct VoiceTranscriptDetails: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let voice: VoiceMessage
    let onPrepare: (VoiceMessage) async -> URL?
    let onUpdate: ((VoiceMessage) async -> Bool)?
    @State private var showsFullTranscript = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !voice.spokenText.isEmpty {
                Text(voice.spokenText)
                    .font(.subheadline)
                    .lineLimit(showsFullTranscript ? nil : 6)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if voice.spokenText.count > 160 || voice.spokenText.contains("\n") {
                    Button(showsFullTranscript ? "Less" : "More") {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
                            showsFullTranscript.toggle()
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(KordiTheme.signalBlue)
                    .frame(minHeight: 28)
                }
            } else if voice.transcription?.status == .pending {
                Text("Transcribing…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 28)
            } else if let onUpdate {
                VoiceTranscriptRetryView(voice: voice, onPrepare: onPrepare, onUpdate: onUpdate)
            } else {
                Text("Failed")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 28)
                    .accessibilityLabel(voice.transcriptionLabel)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct VoiceTranscriptRetryView: View {
    let voice: VoiceMessage
    let onPrepare: (VoiceMessage) async -> URL?
    let onUpdate: (VoiceMessage) async -> Bool
    @State private var busy = false
    @State private var cached: VoiceMessage?

    var body: some View {
        HStack(spacing: 6) {
            Text(busy ? "Transcribing…" : "Failed")
                .foregroundStyle(.secondary)
                .accessibilityLabel(busy ? "Transcribing voice message" : voice.transcriptionLabel)
            if !busy {
                Text("·").foregroundStyle(.tertiary).accessibilityHidden(true)
                Button("Retry") {
                    guard !busy else { return }
                    busy = true
                    Task {
                        defer { busy = false }
                        if cached == nil {
                            guard let url = await onPrepare(voice) else { return }
                            cached = await VoiceMessageRecorder().transcribeExisting(voice, url: url)
                        }
                        guard let cached, !Task.isCancelled else { return }
                        if await onUpdate(cached) { self.cached = nil }
                    }
                }
                .fontWeight(.semibold)
                .buttonStyle(.plain)
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(minHeight: 28)
                .contentShape(Rectangle().inset(by: -8))
                .accessibilityLabel("Retry transcription")
                .disabled((voice.transcription?.attempts ?? 0) >= VoiceTranscription.maximumAttempts)
            }
        }
        .font(.caption)
        .frame(minHeight: 28, alignment: .leading)
    }
}
