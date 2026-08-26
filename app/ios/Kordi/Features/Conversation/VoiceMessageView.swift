import AVFoundation
import Observation
import SwiftUI
import UIKit

enum VoiceRecordingGestureIntent: Equatable {
    case hold
    case cancel
    case convertToText
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
            let window = recognizer.view?.window
            let location = recognizer.location(in: window)
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
            CGSize(
                width: location.x - startLocation.x,
                height: location.y - startLocation.y
            )
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
        gesture.minimumPressDuration = 0.25
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

enum VoiceHoldToTalkTargetLayout {
    static let activationDistance: CGFloat = 92
    static let cancelSectorDegrees = 215.0...260.0
    static let convertToTextSectorDegrees = 280.0...325.0

    static func intent(
        for translation: CGSize
    ) -> VoiceRecordingGestureIntent {
        let distance = sqrt(
            translation.width * translation.width
                + translation.height * translation.height
        )
        guard distance >= activationDistance else { return .hold }
        let rawDegrees = atan2(
            Double(translation.height),
            Double(translation.width)
        ) * 180 / .pi
        let degrees = rawDegrees < 0 ? rawDegrees + 360 : rawDegrees
        if cancelSectorDegrees.contains(degrees) { return .cancel }
        if convertToTextSectorDegrees.contains(degrees) { return .convertToText }
        return .hold
    }
}

struct VoiceHoldToTalkOverlay: View {
    let recorder: VoiceMessageRecorder
    let gestureIntent: VoiceRecordingGestureIntent

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black.opacity(0.78)
                    .ignoresSafeArea()

                recordingPrompt(in: proxy.size)
                    .position(x: proxy.size.width / 2, y: proxy.size.height * 0.5)

                gestureTargets(in: proxy.size)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func recordingPrompt(in size: CGSize) -> some View {
        VStack(spacing: 18) {
            VoiceWaveform(
                samples: recorder.waveformSamples,
                progress: 1,
                activeColor: KordiTheme.signalBlue
            )
                .frame(width: min(180, max(140, size.width * 0.46)))
            Text(statusText)
                .font(.headline)
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }

    private var statusText: String {
        switch gestureIntent {
        case .hold: "Release to send voice"
        case .cancel: "Release to cancel"
        case .convertToText: "Release to convert to text"
        }
    }

    private func gestureTargets(in size: CGSize) -> some View {
        let center = CGPoint(x: size.width / 2, y: size.height + 42)
        let innerRadius = VoiceHoldToTalkTargetLayout.activationDistance
        let outerRadius = min(250, size.width * 0.54)
        let labelRadius = (innerRadius + outerRadius) * 0.52
        let cancelLabel = point(
            from: center,
            radius: labelRadius,
            degrees: 237.5
        )
        let convertLabel = point(
            from: center,
            radius: labelRadius,
            degrees: 302.5
        )
        return ZStack {
            Canvas { context, _ in
                let sectors: [(
                    intent: VoiceRecordingGestureIntent,
                    startDegrees: Double,
                    endDegrees: Double
                )] = [
                    (
                        .cancel,
                        VoiceHoldToTalkTargetLayout.cancelSectorDegrees.lowerBound,
                        VoiceHoldToTalkTargetLayout.cancelSectorDegrees.upperBound
                    ),
                    (
                        .convertToText,
                        VoiceHoldToTalkTargetLayout.convertToTextSectorDegrees.lowerBound,
                        VoiceHoldToTalkTargetLayout.convertToTextSectorDegrees.upperBound
                    ),
                ]

                for sector in sectors {
                    let isSelected = gestureIntent == sector.intent
                    let path = sectorPath(
                        center: center,
                        innerRadius: innerRadius,
                        outerRadius: outerRadius,
                        startDegrees: sector.startDegrees,
                        endDegrees: sector.endDegrees
                    )
                    let opacity = isSelected ? 0.17 : 0.065
                    context.drawLayer { layer in
                        layer.addFilter(.blur(radius: 3.2))
                        layer.fill(
                            path,
                            with: .radialGradient(
                                Gradient(stops: [
                                    .init(
                                        color: .white.opacity(opacity),
                                        location: 0
                                    ),
                                    .init(
                                        color: .white.opacity(opacity * 0.72),
                                        location: 0.72
                                    ),
                                    .init(color: .clear, location: 1),
                                ]),
                                center: center,
                                startRadius: innerRadius,
                                endRadius: outerRadius
                            )
                        )
                    }
                }
            }

            directionalLabel(
                "Cancel",
                isSelected: gestureIntent == .cancel
            )
            .position(cancelLabel)

            directionalLabel(
                "Convert to Text",
                isSelected: gestureIntent == .convertToText
            )
            .position(convertLabel)
        }
        .clipped()
    }

    private func sectorPath(
        center: CGPoint,
        innerRadius: CGFloat,
        outerRadius: CGFloat,
        startDegrees: Double,
        endDegrees: Double
    ) -> Path {
        var path = Path()
        let outerStart = point(
            from: center,
            radius: outerRadius,
            degrees: startDegrees
        )
        let innerEnd = point(
            from: center,
            radius: innerRadius,
            degrees: endDegrees
        )
        let connectorRadius = (innerRadius + outerRadius) / 2
        path.move(to: outerStart)
        for degrees in stride(from: startDegrees, through: endDegrees, by: 3) {
            path.addLine(to: point(from: center, radius: outerRadius, degrees: degrees))
        }
        path.addQuadCurve(
            to: innerEnd,
            control: point(
                from: center,
                radius: connectorRadius,
                degrees: endDegrees + (endDegrees > 300 ? 14 : 0)
            )
        )
        for degrees in stride(from: endDegrees, through: startDegrees, by: -3) {
            path.addLine(to: point(from: center, radius: innerRadius, degrees: degrees))
        }
        path.addQuadCurve(
            to: outerStart,
            control: point(
                from: center,
                radius: connectorRadius,
                degrees: startDegrees + (startDegrees < 250 ? -14 : 0)
            )
        )
        path.closeSubpath()
        return path
    }

    private func point(
        from center: CGPoint,
        radius: CGFloat,
        degrees: Double
    ) -> CGPoint {
        let radians = degrees * .pi / 180
        return CGPoint(
            x: center.x + CGFloat(cos(radians)) * radius,
            y: center.y + CGFloat(sin(radians)) * radius
        )
    }

    private func directionalLabel(
        _ title: String,
        isSelected: Bool
    ) -> some View {
        Text(title)
            .font(.callout.weight(isSelected ? .semibold : .regular))
            .foregroundStyle(.white.opacity(isSelected ? 0.96 : 0.64))
            .lineLimit(1)
            .minimumScaleFactor(0.72)
    }
}

struct VoiceRecordingComposer: View {
    let recorder: VoiceMessageRecorder
    let onCancel: () -> Void
    let onSend: () -> Void

    var body: some View {
        Group {
            if recorder.phase == .recording || recorder.phase == .paused {
                if recorder.isLocked {
                    lockedControls
                } else {
                    Color.clear
                        .frame(height: 58)
                        .accessibilityHidden(true)
                }
            } else {
                failedControls
                    .frame(height: 56)
                    .padding(.horizontal, 14)
                    .background(.ultraThinMaterial, in: Capsule())
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var lockedControls: some View {
        HStack(spacing: 8) {
            Button(role: .destructive, action: onCancel) {
                Image(systemName: "trash")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel voice recording")

            VoiceWaveform(
                samples: recorder.waveformSamples,
                progress: 1
            )
                .frame(maxWidth: .infinity, minHeight: 24)

            Text(VoiceRecordingComposer.duration(recorder.durationMs))
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
    var activeColor = KordiTheme.signalBlue

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, sample in
                Capsule()
                    .fill(
                        Double(index) / Double(max(1, values.count)) <= progress
                            ? activeColor
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

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        stopTimer()
        player.stop()
        isPlaying = false
        errorMessage = "Unable to play this voice message."
    }

    private func preparePlayer(url: URL, identifier: String) -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            self.player = player
            mediaId = identifier
            player.delegate = self
            player.enableRate = true
            player.rate = Float(speed)
            guard player.prepareToPlay() else {
                throw CocoaError(.fileReadCorruptFile)
            }
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
            guard player.play() else {
                stopTimer()
                isPlaying = false
                errorMessage = "Unable to play this voice message."
                return
            }
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
