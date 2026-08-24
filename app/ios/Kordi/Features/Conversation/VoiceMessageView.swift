import AVFoundation
import Observation
import SwiftUI

enum VoiceRecordingGestureIntent: Equatable {
    case hold
    case cancel
}

struct VoiceRecordingComposer: View {
    let recorder: VoiceMessageRecorder
    let gestureIntent: VoiceRecordingGestureIntent

    var body: some View {
        HStack(spacing: 10) {
            if recorder.phase == .recording || recorder.phase == .paused {
                recordingControls
            } else {
                failedControls
            }
        }
        .frame(height: 50, alignment: .center)
        .padding(.horizontal, 14)
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityElement(children: .contain)
    }

    private var recordingControls: some View {
        Group {
            Image(systemName: gestureIntent == .cancel ? "xmark" : "mic.fill")
                .foregroundStyle(gestureIntent == .cancel ? .red : KordiTheme.signalBlue)
                .accessibilityHidden(true)

            VoiceWaveform(samples: recorder.waveformSamples, progress: 1)
                .frame(maxWidth: .infinity, minHeight: 24)

            Text(Self.duration(recorder.durationMs))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

            Text(gestureHint)
                .font(.caption2)
                .foregroundStyle(gestureIntent == .cancel ? .red : KordiTheme.signalBlue)
                .lineLimit(1)
        }
    }

    private var failedControls: some View {
        Group {
            Text(recorder.errorMessage ?? "Voice recording unavailable.")
                .font(.caption)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { await recorder.start() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Record voice message again")
        }
    }

    private var gestureHint: String {
        switch gestureIntent {
        case .hold: "Release to send · swipe up to cancel"
        case .cancel: "Release to cancel"
        }
    }

    static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, Int((Double(milliseconds) / 1_000).rounded()))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}

private struct VoiceDraftReview: View {
    let recorder: VoiceMessageRecorder
    @State private var playback = VoiceMessagePlayback()

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 6) {
                Button {
                    guard let url = recorder.reviewURL else { return }
                    playback.toggle(
                        url: url,
                        identifier: url.path,
                        startMs: recorder.trimStartMs,
                        endMs: recorder.trimEndMs
                    )
                } label: {
                    Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                        .frame(width: 44, height: 44)
                        .background(Color.primary.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playback.isPlaying ? "Pause voice recording preview" : "Play voice recording preview")

                ZStack {
                    VoiceWaveform(samples: recorder.waveformSamples, progress: playback.progress)
                    Slider(value: $playback.progress, in: 0...1) { editing in
                        if !editing { playback.seek(to: playback.progress) }
                    }
                    .tint(.clear)
                    .opacity(0.02)
                    .accessibilityLabel("Voice recording preview position")
                    .accessibilityValue(
                        "\(VoiceRecordingComposer.duration(playback.elapsedMs)) of \(VoiceRecordingComposer.duration(recorder.trimEndMs - recorder.trimStartMs))"
                    )
                }
                .frame(maxWidth: .infinity)

                Button("\(playback.speed.formatted())×") {
                    playback.cycleSpeed()
                }
                .font(.caption2.weight(.bold))
                .buttonStyle(.plain)
                .frame(minWidth: 36, minHeight: 44)
                .accessibilityLabel("Playback speed (playback.speed.formatted()) times")

                Text(VoiceRecordingComposer.duration(recorder.trimEndMs - recorder.trimStartMs))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            VoiceTrimControl(
                durationMs: recorder.durationMs,
                startMs: recorder.trimStartMs,
                endMs: recorder.trimEndMs,
                onChange: recorder.setTrim
            )
            .frame(height: 20)
        }
        .onChange(of: recorder.trimStartMs) {
            playback.updateBounds(startMs: recorder.trimStartMs, endMs: recorder.trimEndMs)
        }
        .onChange(of: recorder.trimEndMs) {
            playback.updateBounds(startMs: recorder.trimStartMs, endMs: recorder.trimEndMs)
        }
    }
}

private struct VoiceTrimControl: View {
    let durationMs: Int
    let startMs: Int
    let endMs: Int
    let onChange: (Int, Int) -> Void

    var body: some View {
        GeometryReader { proxy in
            let width = max(1, proxy.size.width)
            let startX = width * CGFloat(startMs) / CGFloat(max(1, durationMs))
            let endX = width * CGFloat(endMs) / CGFloat(max(1, durationMs))
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.secondary.opacity(0.2))
                    .frame(height: 2)
                Capsule()
                    .fill(KordiTheme.signalBlue)
                    .frame(width: max(2, endX - startX), height: 2)
                    .offset(x: startX)
                trimHandle(
                    label: "Trim start",
                    valueMs: startMs,
                    x: startX,
                    width: width,
                    range: 0...max(0, endMs - 250)
                ) { onChange($0, endMs) }
                trimHandle(
                    label: "Trim end",
                    valueMs: endMs,
                    x: endX,
                    width: width,
                    range: min(durationMs, startMs + 250)...durationMs
                ) { onChange(startMs, $0) }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func trimHandle(
        label: String,
        valueMs: Int,
        x: CGFloat,
        width: CGFloat,
        range: ClosedRange<Int>,
        onUpdate: @escaping (Int) -> Void
    ) -> some View {
        Circle()
            .fill(.background)
            .overlay {
                Circle().stroke(KordiTheme.signalBlue, lineWidth: 2)
            }
            .frame(width: 14, height: 14)
            .contentShape(Rectangle().inset(by: -12))
            .offset(x: x - 7)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let nextX = x + value.translation.width
                        let fraction = max(0, min(1, nextX / width))
                        let next = Int(Double(durationMs) * Double(fraction))
                        onUpdate(max(range.lowerBound, min(range.upperBound, next)))
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue(VoiceRecordingComposer.duration(valueMs))
            .accessibilityAdjustableAction { direction in
                let delta = direction == .increment ? 250 : -250
                onUpdate(max(range.lowerBound, min(range.upperBound, valueMs + delta)))
            }
    }
}

struct VoiceMessageBubbleContent: View {
    let voiceMessage: VoiceMessage
    let onPrepare: (VoiceMessage) async -> URL?

    @State private var playback = VoiceMessagePlayback()
    @State private var showsTranscript = false
    @State private var showsFullTranscript = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button {
                    Task {
                        await playback.toggle(voiceMessage, prepare: onPrepare)
                    }
                } label: {
                    Group {
                        if playback.isLoading {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                        }
                    }
                    .frame(width: 44, height: 44)
                    .background(Color.primary.opacity(0.08), in: Circle())
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playback.isPlaying ? "Pause voice message" : "Play voice message")

                ZStack {
                    VoiceWaveform(samples: voiceMessage.waveformSamples, progress: playback.progress)
                    Slider(value: $playback.progress, in: 0...1) { editing in
                        if !editing { playback.seek(to: playback.progress) }
                    }
                    .tint(.clear)
                    .opacity(0.02)
                    .accessibilityLabel("Voice message position")
                    .accessibilityValue(
                        "\(VoiceRecordingComposer.duration(playback.elapsedMs)) of \(VoiceRecordingComposer.duration(voiceMessage.durationMs))"
                    )
                }
                .frame(maxWidth: .infinity)

                Button("\(playback.speed.formatted())×") {
                    playback.cycleSpeed()
                }
                .font(.caption2.weight(.bold))
                .buttonStyle(.plain)
                .frame(minWidth: 36, minHeight: 44)
                .accessibilityLabel("Playback speed (playback.speed.formatted()) times")

                Button {
                    showsTranscript.toggle()
                } label: {
                    Image(systemName: "text.bubble")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsTranscript ? "Hide voice transcript" : "Show voice transcript")
                .accessibilityValue(showsTranscript ? "Expanded" : "Collapsed")
            }

            HStack {
                Text(VoiceRecordingComposer.duration(playback.isPlaying ? playback.elapsedMs : voiceMessage.durationMs))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                if playback.errorMessage != nil {
                    Button("Retry playback") {
                        playback.reset()
                        Task {
                            await playback.toggle(voiceMessage, prepare: onPrepare)
                        }
                    }
                    .font(.caption2.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(KordiTheme.signalBlue)
                }
            }
            .padding(.leading, 52)

            if showsTranscript {
                Divider().opacity(0.35)
                if voiceMessage.transcript.isEmpty {
                    Text("Transcript unavailable")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(voiceMessage.transcript)
                        .font(.body)
                        .lineLimit(showsFullTranscript ? nil : 6)
                        .textSelection(.enabled)
                    if voiceMessage.transcript.count > 320
                        || voiceMessage.transcript.split(separator: "\n").count > 5 {
                        Button(showsFullTranscript ? "Show less" : "Show full transcript") {
                            showsFullTranscript.toggle()
                        }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(KordiTheme.signalBlue)
                    }
                }
            }
        }
        .frame(minWidth: 248, maxWidth: 340, alignment: .leading)
        .animation(.easeOut(duration: 0.16), value: showsTranscript)
        .accessibilityElement(children: .contain)
    }
}

private struct VoiceWaveform: View {
    let samples: [Double]
    let progress: Double

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, sample in
                Capsule()
                    .fill(
                        Double(index) / Double(max(1, values.count)) <= progress
                            ? KordiTheme.signalBlue
                            : Color.secondary.opacity(0.35)
                    )
                    .frame(maxWidth: 3, minHeight: 3, maxHeight: max(3, 28 * sample))
            }
        }
        .frame(height: 32)
        .accessibilityHidden(true)
    }

    private var values: [Double] {
        samples.isEmpty ? Array(repeating: 0.08, count: 36) : samples
    }
}

@MainActor
@Observable
private final class VoiceMessagePlayback: NSObject, AVAudioPlayerDelegate {
    var isPlaying = false
    var isLoading = false
    var progress = 0.0
    var elapsedMs = 0
    var speed = 1.0
    var errorMessage: String?

    private var player: AVAudioPlayer?
    private var timer: Timer?
    private var mediaId: String?
    private var startMs = 0
    private var endMs = 0

    func toggle(
        _ voiceMessage: VoiceMessage,
        prepare: (VoiceMessage) async -> URL?
    ) async {
        if player == nil || mediaId != voiceMessage.mediaId {
            isLoading = true
            errorMessage = nil
            defer { isLoading = false }
            guard let url = await prepare(voiceMessage) else {
                errorMessage = "Unable to download this voice message."
                return
            }
            guard preparePlayer(url: url, identifier: voiceMessage.mediaId) else { return }
            updateBounds(startMs: 0, endMs: voiceMessage.durationMs)
        }
        toggleCurrentPlayer()
    }

    func toggle(url: URL, identifier: String, startMs: Int, endMs: Int) {
        if player == nil || mediaId != identifier {
            guard preparePlayer(url: url, identifier: identifier) else { return }
        }
        updateBounds(startMs: startMs, endMs: endMs)
        toggleCurrentPlayer()
    }

    func updateBounds(startMs: Int, endMs: Int) {
        self.startMs = startMs
        self.endMs = max(startMs + 1, endMs)
        guard let player else { return }
        let currentMs = Int(player.currentTime * 1_000)
        if currentMs < startMs || currentMs >= endMs {
            player.currentTime = Double(startMs) / 1_000
        }
        updateProgress()
    }

    func seek(to progress: Double) {
        guard let player else { return }
        player.currentTime = Double(startMs) / 1_000
            + Double(endMs - startMs) / 1_000 * max(0, min(1, progress))
        updateProgress()
    }

    func cycleSpeed() {
        speed = speed == 1 ? 1.5 : speed == 1.5 ? 2 : 1
        player?.rate = Float(speed)
        player?.enableRate = true
    }

    func reset() {
        stopTimer()
        player?.stop()
        player = nil
        mediaId = nil
        isPlaying = false
        isLoading = false
        progress = 0
        elapsedMs = 0
        errorMessage = nil
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        stopTimer()
        isPlaying = false
        player.currentTime = Double(startMs) / 1_000
        progress = 0
        elapsedMs = 0
    }

    private func preparePlayer(url: URL, identifier: String) -> Bool {
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            self.player = player
            mediaId = identifier
            player.delegate = self
            player.enableRate = true
            player.rate = Float(speed)
            player.prepareToPlay()
            errorMessage = nil
            return true
        } catch {
            errorMessage = "Unable to play this voice message."
            return false
        }
    }

    private func toggleCurrentPlayer() {
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            stopTimer()
            isPlaying = false
        } else {
            let currentMs = Int(player.currentTime * 1_000)
            if currentMs < startMs || currentMs >= endMs {
                player.currentTime = Double(startMs) / 1_000
            }
            player.enableRate = true
            player.rate = Float(speed)
            player.play()
            isPlaying = true
            startTimer()
        }
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.updateProgress() }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func updateProgress() {
        guard let player else { return }
        let currentMs = Int(player.currentTime * 1_000)
        if currentMs >= endMs {
            player.pause()
            player.currentTime = Double(startMs) / 1_000
            stopTimer()
            isPlaying = false
            progress = 0
            elapsedMs = 0
            return
        }
        elapsedMs = max(0, currentMs - startMs)
        progress = Double(max(0, currentMs - startMs)) / Double(max(1, endMs - startMs))
    }
}
