import SwiftUI

struct VoiceTranscriptDetails: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: VoiceTranscriptState
    let onTranscribe: () -> Void
    @State private var showsFullTranscript = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch state {
            case .ready(let transcript):
                Text(transcript)
                    .font(.subheadline)
                    .lineLimit(showsFullTranscript ? nil : 6)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if transcript.count > 160 || transcript.contains("\n") {
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
            case .transcribing:
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Transcribing…")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(minHeight: 28)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Transcribing voice message")
            case .notTranscribed:
                transcribeButton(title: "Transcribe", prefix: nil)
            case .failed(let canRetry):
                if canRetry {
                    transcribeButton(title: "Try again", prefix: "Couldn’t transcribe")
                } else {
                    Text("Couldn’t transcribe this recording")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(minHeight: 28)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func transcribeButton(title: String, prefix: String?) -> some View {
        HStack(spacing: 6) {
            if let prefix {
                Text(prefix)
                    .foregroundStyle(.secondary)
                Text("·")
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            Button(title, action: onTranscribe)
                .fontWeight(.semibold)
                .buttonStyle(.plain)
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(minHeight: 28)
                .contentShape(Rectangle().inset(by: -8))
                .accessibilityLabel(prefix == nil ? "Transcribe voice message" : "Try transcribing again")
        }
        .font(.caption)
        .frame(minHeight: 28, alignment: .leading)
    }
}
