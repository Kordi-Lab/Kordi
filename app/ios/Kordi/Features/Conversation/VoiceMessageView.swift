import AVFoundation
import Observation
import SwiftUI
import UIKit

enum VoiceRecordingGestureIntent: Equatable {
    case hold
    case cancel
    case lock
}

struct VoiceRecordingGestureCapture: UIViewRepresentable {
    let isEnabled: Bool
    let onBegan: () -> Void
    let onChanged: (CGSize) -> Void
    let onEnded: (CGSize) -> Void
    let onCancelled: () -> Void

    final class Coordinator: NSObject {
        var parent: VoiceRecordingGestureCapture
        private var startLocation = CGPoint.zero

        init(parent: VoiceRecordingGestureCapture) {
            self.parent = parent
        }

        @objc func handle(_ recognizer: UILongPressGestureRecognizer) {
            let location = recognizer.location(in: nil)
            switch recognizer.state {
            case .began:
                startLocation = location
                parent.onBegan()
            case .changed:
                parent.onChanged(translation(to: location))
            case .ended:
                parent.onEnded(translation(to: location))
            case .cancelled, .failed:
                parent.onCancelled()
            default:
                break
            }
        }

        private func translation(to location: CGPoint) -> CGSize {
            CGSize(width: location.x - startLocation.x, height: location.y - startLocation.y)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        let gesture = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handle(_:))
        )
        gesture.minimumPressDuration = 0
        gesture.allowableMovement = .greatestFiniteMagnitude
        gesture.cancelsTouchesInView = true
        view.addGestureRecognizer(gesture)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
        uiView.isUserInteractionEnabled = isEnabled
    }
}

struct VoiceRecordingComposer: View {
    let recorder: VoiceMessageRecorder
    let gestureIntent: VoiceRecordingGestureIntent
    let onCancel: () -> Void
    let onSend: () -> Void

    var body: some View {
        Group {
            if recorder.phase == .recording || recorder.phase == .paused {
                if recorder.isLocked {
                    lockedControls
                } else {
                    heldControls
                }
            } else {
                failedControls
                    .frame(height: 56)
                    .padding(.horizontal, 14)
                    .background(.ultraThinMaterial, in: Capsule())
            }
        }
        .accessibilityElement(children: .contain)
        .animation(.snappy(duration: 0.18), value: gestureIntent)
        .animation(.snappy(duration: 0.18), value: recorder.isLocked)
    }

    private var heldControls: some View {
        ZStack(alignment: .bottomTrailing) {
            HStack(spacing: 8) {
                Circle()
                    .fill(.red)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)

                Text(Self.duration(recorder.durationMs))
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.primary)

                Spacer(minLength: 8)

                Image(systemName: "chevron.left")
                    .font(.caption.weight(.bold))
                    .accessibilityHidden(true)

                Text(gestureIntent == .cancel ? "Release to cancel" : "Slide to cancel")
                    .font(.callout)
                    .foregroundStyle(gestureIntent == .cancel ? .red : .secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.leading, 18)
            .padding(.trailing, 88)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(.ultraThinMaterial, in: Capsule())

            if gestureIntent != .cancel {
                VStack(spacing: 2) {
                    Image(systemName: gestureIntent == .lock ? "lock.fill" : "lock.open.fill")
                        .font(.body.weight(.semibold))
                    Image(systemName: "chevron.up")
                        .font(.caption2.weight(.bold))
                }
                .foregroundStyle(gestureIntent == .lock ? KordiTheme.signalBlue : .secondary)
                .frame(width: 44, height: 64)
                .background(.ultraThinMaterial, in: Capsule())
                .offset(x: -17, y: -58)
                .accessibilityHidden(true)
            }

            Circle()
                .fill(gestureIntent == .cancel ? Color.red : KordiTheme.signalBlue)
                .frame(width: 78, height: 78)
                .overlay {
                    Image(systemName: gestureIntent == .cancel ? "xmark" : "mic.fill")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(.white)
                }
                .shadow(
                    color: (gestureIntent == .cancel ? Color.red : KordiTheme.signalBlue)
                        .opacity(0.24),
                    radius: 10,
                    y: 4
                )
                .scaleEffect(gestureIntent == .lock ? 1.08 : 1)
                .offset(y: gestureIntent == .lock ? -8 : 0)
                .accessibilityHidden(true)
        }
        .frame(height: 82)
        .accessibilityLabel("Recording voice message")
        .accessibilityValue(Self.duration(recorder.durationMs))
        .accessibilityHint("Release to send, slide left to cancel, or slide up to lock")
    }

    private var lockedControls: some View {
        HStack(spacing: 8) {
            Button(role: .destructive, action: onCancel) {
                Image(systemName: "trash")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel voice recording")

            VoiceWaveform(samples: recorder.waveformSamples, progress: 1)
                .frame(maxWidth: .infinity, minHeight: 24)

            Text(Self.duration(recorder.durationMs))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

            Button {
                if recorder.phase == .paused {
                    recorder.resume()
                } else {
                    recorder.pause()
                }
            } label: {
                Image(systemName: recorder.phase == .paused ? "mic.fill" : "pause.fill")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recorder.phase == .paused ? "Resume recording" : "Pause recording")

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 50, height: 50)
                    .background(KordiTheme.signalBlue, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send voice message")
        }
        .frame(height: 58)
        .padding(.leading, 4)
        .padding(.trailing, 4)
        .background(.ultraThinMaterial, in: Capsule())
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
    let reservesDeliveryStatus: Bool
    let onPrepare: (VoiceMessage) async -> URL?

    @State private var playback = VoiceMessagePlayback()
    @State private var showsTranscript = false
    @State private var showsFullTranscript = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Button {
                    Task {
                        await playback.toggle(voiceMessage, prepare: onPrepare)
                    }
                } label: {
                    Group {
                        if playback.isLoading {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                                .font(.callout.weight(.semibold))
                        }
                    }
                    .frame(width: 36, height: 36)
                    .background(Color.primary.opacity(0.08), in: Circle())
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle().inset(by: -4))
                .accessibilityLabel(playback.isPlaying ? "Pause voice message" : "Play voice message")

                VStack(spacing: 0) {
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
                    .frame(height: 24)
                    .clipped()

                    HStack(spacing: 3) {
                        Text(VoiceRecordingComposer.duration(
                            playback.isPlaying ? playback.elapsedMs : voiceMessage.durationMs
                        ))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)

                        Spacer(minLength: 2)

                        if playback.errorMessage != nil {
                            Button {
                                playback.reset()
                                Task {
                                    await playback.toggle(voiceMessage, prepare: onPrepare)
                                }
                            } label: {
                                Image(systemName: "arrow.clockwise")
                                    .font(.caption2.weight(.semibold))
                                    .frame(width: 24, height: 24)
                            }
                            .buttonStyle(.plain)
                            .contentShape(Rectangle().inset(by: -8))
                            .foregroundStyle(KordiTheme.signalBlue)
                            .accessibilityLabel("Retry playback")
                        }

                        Button("\(playback.speed.formatted())×") {
                            playback.cycleSpeed()
                        }
                        .font(.caption2.weight(.bold))
                        .buttonStyle(.plain)
                        .frame(minWidth: 27, minHeight: 24)
                        .contentShape(Rectangle().inset(by: -8))
                        .accessibilityLabel("Playback speed \(playback.speed.formatted()) times")

                        Button {
                            showsTranscript.toggle()
                        } label: {
                            Image(systemName: "text.bubble")
                                .font(.caption2)
                                .frame(width: 24, height: 24)
                        }
                        .buttonStyle(.plain)
                        .contentShape(Rectangle().inset(by: -8))
                        .accessibilityLabel(showsTranscript ? "Hide voice transcript" : "Show voice transcript")
                        .accessibilityValue(showsTranscript ? "Expanded" : "Collapsed")

                        if reservesDeliveryStatus {
                            Color.clear
                                .frame(width: 14, height: 1)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(height: 20)
                }
            }

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
        .frame(width: showsTranscript ? 280 : Self.compactWidth(durationMs: voiceMessage.durationMs))
        .animation(.easeOut(duration: 0.16), value: showsTranscript)
        .accessibilityElement(children: .contain)
    }

    static func compactWidth(durationMs: Int) -> CGFloat {
        let seconds = CGFloat(max(1, min(60, Int(ceil(Double(durationMs) / 1_000)))))
        return min(260, 168 + seconds * 1.45)
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
