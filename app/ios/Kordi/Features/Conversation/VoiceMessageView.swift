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
    static let activationDelay: TimeInterval = 0.18

    let isEnabled: Bool
    let onPressingChanged: (Bool) -> Void
    /// Touch-down, before the long press activates.
    let onTouchDown: () -> Void
    /// The touch ended before the long press activated. `true` when the system cancelled it.
    let onReleasedBeforeActivation: (Bool) -> Void
    /// Finger location in window coordinates, with the window size.
    let onBegan: (CGPoint, CGSize) -> Void
    let onChanged: (CGPoint, CGSize) -> Void
    let onEnded: (CGPoint, CGSize) -> Void
    let onCancelled: () -> Void

    final class Coordinator: NSObject {
        var parent: VoiceRecordingGestureCapture

        init(parent: VoiceRecordingGestureCapture) {
            self.parent = parent
        }

        func setPressing(_ isPressing: Bool) {
            parent.onPressingChanged(isPressing)
        }

        func touchDown() {
            parent.onTouchDown()
        }

        func releasedBeforeActivation(_ wasCancelled: Bool) {
            parent.onReleasedBeforeActivation(wasCancelled)
        }

        @objc func handle(_ recognizer: UILongPressGestureRecognizer) {
            guard let window = recognizer.view?.window else {
                if [.ended, .cancelled, .failed].contains(recognizer.state) { parent.onCancelled() }
                return
            }
            let location = recognizer.location(in: window)
            let size = window.bounds.size
            switch recognizer.state {
            case .began:
                (recognizer.view as? VoiceRecordingCaptureView)?.didActivate = true
                parent.onBegan(location, size)
            case .changed:
                parent.onChanged(location, size)
            case .ended:
                parent.onEnded(location, size)
            case .cancelled, .failed:
                parent.onCancelled()
            default:
                break
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UIView {
        let view = VoiceRecordingCaptureView()
        view.backgroundColor = .clear
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        view.onPressingChanged = context.coordinator.setPressing
        view.onTouchDown = context.coordinator.touchDown
        view.onReleasedBeforeActivation = context.coordinator.releasedBeforeActivation
        let gesture = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handle(_:))
        )
        gesture.minimumPressDuration = Self.activationDelay
        gesture.allowableMovement = .greatestFiniteMagnitude
        gesture.cancelsTouchesInView = false
        view.addGestureRecognizer(gesture)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
        uiView.isUserInteractionEnabled = isEnabled
        if !isEnabled {
            (uiView as? VoiceRecordingCaptureView)?.setPressing(false)
        }
    }
}

private final class VoiceRecordingCaptureView: UIView {
    var onPressingChanged: (Bool) -> Void = { _ in }
    var onTouchDown: () -> Void = {}
    var onReleasedBeforeActivation: (Bool) -> Void = { _ in }
    var didActivate = false
    private var isPressing = false

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        didActivate = false
        setPressing(true)
        // Start audio now so speech counts from the touch, not from the long press.
        onTouchDown()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        setPressing(false)
        if !didActivate { onReleasedBeforeActivation(false) }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        setPressing(false)
        if !didActivate { onReleasedBeforeActivation(true) }
    }

    func setPressing(_ isPressing: Bool) {
        guard self.isPressing != isPressing else { return }
        self.isPressing = isPressing
        onPressingChanged(isPressing)
    }
}

/// Geometry shared by the Hold to Talk hit test and the overlay that draws it.
/// All values are in window coordinates.
struct VoiceHoldToTalkTargetLayout: Equatable {
    static let arcTopRatio: CGFloat = 0.83
    static let bubbleCenterRatio: CGFloat = 0.43
    static let targetCenterRatio: CGFloat = 0.73
    static let cancelTargetXRatio: CGFloat = 0.25
    static let convertTargetXRatio: CGFloat = 0.75
    static let targetDiameter: CGFloat = 72
    static let arcOverhang: CGFloat = 40
    static let arcCapHeight: CGFloat = 122
    /// Distance past the arc edge needed to leave or re-enter the send zone.
    static let verticalHysteresis: CGFloat = 12
    /// Distance past the center line needed to switch between Cancel and Convert to Text.
    static let horizontalHysteresis: CGFloat = 10

    let size: CGSize

    var arcTop: CGFloat { size.height * Self.arcTopRatio }
    var midX: CGFloat { size.width / 2 }
    var bubbleCenter: CGPoint { CGPoint(x: midX, y: size.height * Self.bubbleCenterRatio) }
    var cancelTargetCenter: CGPoint {
        CGPoint(x: size.width * Self.cancelTargetXRatio, y: size.height * Self.targetCenterRatio)
    }
    var convertTargetCenter: CGPoint {
        CGPoint(x: size.width * Self.convertTargetXRatio, y: size.height * Self.targetCenterRatio)
    }

    func intent(
        for location: CGPoint,
        previous: VoiceRecordingGestureIntent
    ) -> VoiceRecordingGestureIntent {
        switch previous {
        case .hold:
            guard location.y < arcTop - Self.verticalHysteresis else { return .hold }
            return location.x < midX ? .cancel : .convertToText
        case .cancel:
            if location.y > arcTop + Self.verticalHysteresis { return .hold }
            return location.x > midX + Self.horizontalHysteresis ? .convertToText : .cancel
        case .convertToText:
            if location.y > arcTop + Self.verticalHysteresis { return .hold }
            return location.x < midX - Self.horizontalHysteresis ? .cancel : .convertToText
        }
    }

    static func intent(
        for location: CGPoint,
        in size: CGSize,
        previous: VoiceRecordingGestureIntent
    ) -> VoiceRecordingGestureIntent {
        VoiceHoldToTalkTargetLayout(size: size).intent(for: location, previous: previous)
    }
}

/// What the Hold to Talk overlay shows. The composer drives it from the gesture,
/// so the overlay appears as soon as the long press begins.
@MainActor
@Observable
final class VoiceHoldToTalkPresentation {
    enum Stage: Equatable {
        case recording
        case tooShort
        case converting
    }

    static let tooShortDisplayDuration: Duration = .milliseconds(900)
    static let fadeDuration: TimeInterval = 0.14

    private(set) var stage: Stage?
    /// Stays true briefly after dismissal so the window overlay can fade out.
    private(set) var isOverlayMounted = false
    var intent = VoiceRecordingGestureIntent.hold
    @ObservationIgnored private var dismissTask: Task<Void, Never>?
    @ObservationIgnored private var unmountTask: Task<Void, Never>?

    var isPresented: Bool { stage != nil }

    func present() {
        dismissTask?.cancel()
        dismissTask = nil
        intent = .hold
        mount(.recording)
    }

    func showTooShort() {
        dismissTask?.cancel()
        intent = .hold
        mount(.tooShort)
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: Self.tooShortDisplayDuration)
            guard !Task.isCancelled, let self, self.stage == .tooShort else { return }
            self.dismiss()
        }
    }

    func showConverting() {
        dismissTask?.cancel()
        dismissTask = nil
        intent = .convertToText
        mount(.converting)
    }

    func dismiss() {
        dismissTask?.cancel()
        dismissTask = nil
        guard isOverlayMounted else { return }
        stage = nil
        unmountTask?.cancel()
        guard !UIAccessibility.isReduceMotionEnabled else {
            unmountTask = nil
            isOverlayMounted = false
            return
        }
        unmountTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(Self.fadeDuration * 1_000) + 30))
            guard !Task.isCancelled, let self, self.stage == nil else { return }
            self.isOverlayMounted = false
        }
    }

    private func mount(_ stage: Stage) {
        unmountTask?.cancel()
        unmountTask = nil
        isOverlayMounted = true
        self.stage = stage
    }

    #if DEBUG
    func installPreview(stage: Stage, intent: VoiceRecordingGestureIntent) {
        dismissTask?.cancel()
        dismissTask = nil
        self.intent = intent
        mount(stage)
    }
    #endif
}

struct VoiceHoldToTalkOverlay: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let recorder: VoiceMessageRecorder
    let presentation: VoiceHoldToTalkPresentation

    @State private var isShown = false
    @State private var lastStage = VoiceHoldToTalkPresentation.Stage.recording

    static let barCount = 16
    static let barWidth: CGFloat = 4
    static let barSpacing: CGFloat = 3
    static let minimumBarHeight: CGFloat = 4
    static let maximumBarHeight: CGFloat = 34
    static let bubbleHeight: CGFloat = 76
    static let bubbleMinimumWidth: CGFloat = 150
    static let bubbleMaximumWidth: CGFloat = 250
    static let countdownStartMs = 50_000

    private static let ink = Color(red: 17 / 255, green: 24 / 255, blue: 39 / 255)
    private static let convertBarColor = Color(red: 156 / 255, green: 163 / 255, blue: 175 / 255)

    var body: some View {
        GeometryReader { proxy in
            let layout = VoiceHoldToTalkTargetLayout(size: proxy.size)
            ZStack(alignment: .topLeading) {
                backdrop
                arc(layout)
                    .opacity(showsTargets ? 1 : 0)
                target(.cancel, center: layout.cancelTargetCenter)
                    .opacity(showsTargets ? 1 : 0)
                target(.convertToText, center: layout.convertTargetCenter)
                    .opacity(showsTargets ? 1 : 0)
                bubble
                    .position(layout.bubbleCenter)
                status
                    .frame(width: max(0, proxy.size.width - 32))
                    .position(
                        x: layout.midX,
                        y: layout.bubbleCenter.y + Self.bubbleHeight / 2 + 50
                    )
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: showsTargets)
        }
        .ignoresSafeArea()
        .opacity(isVisible ? 1 : 0)
        .animation(
            reduceMotion ? nil : .easeOut(duration: VoiceHoldToTalkPresentation.fadeDuration),
            value: isVisible
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { isShown = true }
        .onChange(of: presentation.stage, initial: true) { _, stage in
            // Keep the last content while the window overlay fades out.
            if let stage { lastStage = stage }
        }
    }

    private var stage: VoiceHoldToTalkPresentation.Stage {
        presentation.stage ?? lastStage
    }

    private var isVisible: Bool {
        isShown && presentation.stage != nil
    }

    private var intent: VoiceRecordingGestureIntent {
        switch stage {
        case .recording: presentation.intent
        case .tooShort: .hold
        case .converting: .convertToText
        }
    }

    private var showsTargets: Bool { stage == .recording }

    @ViewBuilder
    private var backdrop: some View {
        if reduceTransparency {
            Color.black.opacity(0.78)
        } else {
            ZStack {
                Rectangle().fill(.ultraThinMaterial)
                Color.black.opacity(0.46)
            }
            .environment(\.colorScheme, .dark)
        }
    }

    // MARK: Bubble

    private var bubble: some View {
        HStack(spacing: 12) {
            switch stage {
            case .recording:
                levelBars
                Text(Self.timerText(durationMs: recorder.durationMs))
                    .font(.footnote.weight(.semibold).monospacedDigit())
                    .lineLimit(1)
                    .fixedSize()
            case .tooShort:
                Image(systemName: "exclamationmark.circle")
                    .font(.body.weight(.semibold))
                Text("Too short")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .fixedSize()
            case .converting:
                ProgressView()
                    .controlSize(.small)
                    .tint(Self.ink)
                Text("Converting…")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .foregroundStyle(bubbleContentColor)
        .padding(.horizontal, 20)
        .frame(
            minWidth: stage == .recording
                ? Self.bubbleWidth(durationMs: recorder.durationMs)
                : Self.bubbleMinimumWidth,
            minHeight: Self.bubbleHeight,
            maxHeight: Self.bubbleHeight
        )
        .background {
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(bubbleFill)
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(bubbleFill)
                    .frame(width: 16, height: 16)
                    .rotationEffect(.degrees(45))
                    .offset(y: 6)
            }
            .compositingGroup()
            .shadow(color: .black.opacity(0.25), radius: 15, y: 10)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: intent)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: Self.bubbleWidth(durationMs: recorder.durationMs))
    }

    private var levelBars: some View {
        let heights = Self.levelBarHeights(recorder.waveformSamples)
        return HStack(spacing: Self.barSpacing) {
            ForEach(heights.indices, id: \.self) { index in
                Capsule()
                    .fill(intent == .convertToText ? Self.convertBarColor : Color.white.opacity(0.92))
                    .frame(width: Self.barWidth, height: heights[index])
            }
        }
        .frame(height: Self.maximumBarHeight)
        .animation(reduceMotion ? nil : .linear(duration: 0.1), value: heights)
    }

    private var bubbleFill: Color {
        switch intent {
        case .hold: KordiTheme.signalBlue
        case .cancel: Color(uiColor: .systemRed)
        case .convertToText: .white
        }
    }

    private var bubbleContentColor: Color {
        intent == .convertToText ? Self.ink : .white
    }

    // MARK: Status

    private var status: some View {
        let text = Self.statusText(stage: stage, intent: intent)
        return VStack(spacing: 2) {
            Text(text.title)
                .font(.headline)
                .foregroundStyle(.white.opacity(0.92))
            Text(text.subtitle)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.62))
        }
        .multilineTextAlignment(.center)
        .lineLimit(2)
    }

    // MARK: Targets

    private func target(_ kind: VoiceRecordingGestureIntent, center: CGPoint) -> some View {
        let isActive = stage == .recording && intent == kind
        let diameter = VoiceHoldToTalkTargetLayout.targetDiameter
        return ZStack(alignment: .topLeading) {
            ZStack {
                Circle()
                    .fill(isActive ? Color.white : Color.white.opacity(0.16))
                Circle()
                    .strokeBorder(Color.white.opacity(isActive ? 0 : 0.22), lineWidth: 1)
                Image(systemName: kind == .cancel ? "xmark" : "textformat")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(
                        isActive
                            ? (kind == .cancel ? Color(uiColor: .systemRed) : Self.ink)
                            : Color.white
                    )
            }
            .frame(width: diameter, height: diameter)
            .scaleEffect(isActive && !reduceMotion ? 1.22 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.62),
                value: isActive
            )
            .position(center)

            Text(kind == .cancel ? "Cancel" : "Convert to Text")
                .font(.subheadline.weight(isActive ? .bold : .medium))
                .foregroundStyle(isActive ? Color.white : Color.white.opacity(0.8))
                .lineLimit(1)
                .fixedSize()
                .position(x: center.x, y: center.y + diameter / 2 + 20)
        }
    }

    // MARK: Arc

    private func arc(_ layout: VoiceHoldToTalkTargetLayout) -> some View {
        let isHolding = stage == .recording && intent == .hold
        return ZStack(alignment: .topLeading) {
            VoiceHoldToTalkArcShape(top: layout.arcTop, edgeOnly: false)
                .fill(Color.white.opacity(isHolding ? 0.30 : 0.18))
            VoiceHoldToTalkArcShape(top: layout.arcTop, edgeOnly: true)
                .stroke(Color.white.opacity(0.35), lineWidth: 1)
            Image(systemName: "waveform")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(Color.white.opacity(isHolding ? 1 : 0.7))
                .position(x: layout.midX, y: layout.arcTop + 44)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: isHolding)
    }

    // MARK: Pure helpers

    /// `m:ss` while recording, then a countdown during the last ten seconds.
    static func timerText(durationMs: Int) -> String {
        let elapsedSeconds = max(0, durationMs) / 1_000
        if durationMs >= countdownStartMs {
            let remaining = max(1, VoiceMessageRecorder.maximumDurationMs / 1_000 - elapsedSeconds)
            return "\(remaining)s left"
        }
        return "\(elapsedSeconds / 60):\(String(format: "%02d", elapsedSeconds % 60))"
    }

    static func bubbleWidth(durationMs: Int) -> CGFloat {
        let seconds = CGFloat(max(0, durationMs) / 1_000)
        return min(bubbleMaximumWidth, bubbleMinimumWidth + seconds * 10)
    }

    /// Heights for the most recent level samples, oldest first. Missing samples use the minimum height.
    static func levelBarHeights(_ samples: [Double]) -> [CGFloat] {
        let recent = samples.suffix(barCount)
        let padded = Array(repeating: 0.0, count: barCount - recent.count) + recent
        return padded.map { sample in
            let level = max(0, min(1, (sample - 0.08) / 0.92))
            return minimumBarHeight + (maximumBarHeight - minimumBarHeight) * CGFloat(level)
        }
    }

    static func statusText(
        stage: VoiceHoldToTalkPresentation.Stage,
        intent: VoiceRecordingGestureIntent
    ) -> (title: String, subtitle: String) {
        switch stage {
        case .tooShort:
            return ("Too short", "Hold for at least 1 second")
        case .converting:
            return ("Converting to text…", "The words will appear in the message field")
        case .recording:
            switch intent {
            case .hold: return ("Release to send", "Slide to a target to cancel or convert")
            case .cancel: return ("Release to cancel", "The recording will be discarded")
            case .convertToText: return ("Release to convert to text", "Edit the words before sending")
            }
        }
    }
}

/// The send zone: a wide elliptical cap whose top edge sits at the layout's arc top.
private struct VoiceHoldToTalkArcShape: Shape {
    let top: CGFloat
    let edgeOnly: Bool

    func path(in rect: CGRect) -> Path {
        let overhang = VoiceHoldToTalkTargetLayout.arcOverhang
        let capHeight = VoiceHoldToTalkTargetLayout.arcCapHeight
        let minX = rect.minX - overhang
        let maxX = rect.maxX + overhang
        let bottom = max(rect.maxY, top + capHeight) + overhang
        let transform = CGAffineTransform(translationX: rect.midX, y: top + capHeight)
            .scaledBy(x: (maxX - minX) / 2, y: capHeight)
        var path = Path()
        if !edgeOnly {
            path.move(to: CGPoint(x: minX, y: bottom))
            path.addLine(to: CGPoint(x: minX, y: top + capHeight))
        }
        path.addArc(
            center: .zero,
            radius: 1,
            startAngle: .degrees(180),
            endAngle: .degrees(360),
            clockwise: false,
            transform: transform
        )
        if !edgeOnly {
            path.addLine(to: CGPoint(x: maxX, y: bottom))
            path.closeSubpath()
        }
        return path
    }
}

#if DEBUG
/// `--preview-voice-hold=<state>` freezes Hold to Talk in one state for screenshots.
enum VoiceHoldToTalkPreviewState: String {
    case hold
    case cancel
    case convert
    case short
    case converting
    case draftFailed = "draft-failed"

    private static let argumentPrefix = "--preview-voice-hold="

    static var launchArgument: VoiceHoldToTalkPreviewState? {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("--preview-data"),
              let argument = arguments.first(where: { $0.hasPrefix(argumentPrefix) }) else { return nil }
        return VoiceHoldToTalkPreviewState(rawValue: String(argument.dropFirst(argumentPrefix.count)))
    }

    static let sampleWaveform: [Double] = (0..<48).map { index in
        let wave = abs(sin(Double(index) * 0.62)) * (0.55 + 0.45 * abs(cos(Double(index) * 0.21)))
        return min(1, 0.12 + 0.82 * wave)
    }

    var isPressing: Bool {
        switch self {
        case .hold, .cancel, .convert: true
        case .short, .converting, .draftFailed: false
        }
    }

    @MainActor
    func install(recorder: VoiceMessageRecorder, presentation: VoiceHoldToTalkPresentation) {
        switch self {
        case .draftFailed:
            recorder.installFailedDraftPreview(durationMs: 7_000, waveformSamples: Self.sampleWaveform)
        case .hold, .cancel, .convert, .short, .converting:
            recorder.installHoldToTalkPreview(durationMs: 4_200, waveformSamples: Self.sampleWaveform)
            switch self {
            case .cancel: presentation.installPreview(stage: .recording, intent: .cancel)
            case .convert: presentation.installPreview(stage: .recording, intent: .convertToText)
            case .short: presentation.installPreview(stage: .tooShort, intent: .hold)
            case .converting: presentation.installPreview(stage: .converting, intent: .convertToText)
            default: presentation.installPreview(stage: .recording, intent: .hold)
            }
        }
    }
}
#endif

/// Review, failed, and locked recordings share one draft pill.
struct VoiceRecordingComposer: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let recorder: VoiceMessageRecorder
    let onCancel: () -> Void
    let onSend: () -> Void

    @State private var playback = VoiceMessagePlayback()
    @State private var showsTrim = false

    private static let pillBarCount = 24

    var body: some View {
        VStack(spacing: 6) {
            if showsTrim && recorder.phase == .review {
                VoiceTrimControl(
                    durationMs: recorder.durationMs,
                    startMs: recorder.trimStartMs,
                    endMs: recorder.trimEndMs,
                    onChange: recorder.setTrim
                )
                .frame(height: 24)
                .padding(.leading, 40 + 8 + 20)
                .padding(.trailing, 20)
                .disabled(recorder.transcriptionPhase == .transcribing)
                .transition(.opacity)
            }

            HStack(spacing: 8) {
                discardButton
                pill
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: showsTrim)
        .accessibilityElement(children: .contain)
        .onChange(of: recorder.trimStartMs) {
            playback.updateBounds(startMs: recorder.trimStartMs, endMs: recorder.trimEndMs)
        }
        .onChange(of: recorder.trimEndMs) {
            playback.updateBounds(startMs: recorder.trimStartMs, endMs: recorder.trimEndMs)
        }
        .onChange(of: recorder.phase) { _, phase in
            guard phase != .review else { return }
            showsTrim = false
            playback.reset()
        }
    }

    private var isRecording: Bool {
        recorder.phase == .recording || recorder.phase == .paused
    }

    private var canSend: Bool {
        switch recorder.phase {
        case .recording, .paused: true
        case .review: recorder.pendingMessage != nil
        case .idle, .failed: false
        }
    }

    private var discardButton: some View {
        Button(role: .destructive, action: onCancel) {
            Image(systemName: "xmark")
                .font(.body.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 40, height: 40)
                .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                .contentShape(Circle().inset(by: -4))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isRecording ? "Cancel voice recording" : "Discard voice recording")
    }

    private var pill: some View {
        HStack(spacing: 4) {
            switch recorder.phase {
            case .recording, .paused:
                recordingContent
            case .review:
                reviewContent
            case .idle, .failed:
                failedContent
            }
            sendButton
        }
        .padding(.leading, 3)
        .padding(.trailing, 5)
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }

    @ViewBuilder
    private var recordingContent: some View {
        Button {
            if recorder.phase == .paused {
                recorder.resume()
            } else {
                recorder.pause()
            }
        } label: {
            Image(systemName: recorder.phase == .paused ? "mic.fill" : "pause.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(recorder.phase == .paused ? Color(uiColor: .systemRed) : Color.primary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(recorder.phase == .paused ? "Resume recording" : "Pause recording")

        VoiceWaveform(
            samples: Array(recorder.waveformSamples.suffix(Self.pillBarCount)),
            progress: 1,
            height: 26
        )
        .frame(maxWidth: .infinity)

        Text(VoiceRecordingComposer.duration(recorder.durationMs))
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .fixedSize()
            .padding(.trailing, 4)
    }

    @ViewBuilder
    private var reviewContent: some View {
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
                .font(.callout.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(playback.isPlaying ? "Pause voice recording preview" : "Play voice recording preview")

        VStack(alignment: .leading, spacing: 1) {
            ZStack {
                VoiceWaveform(
                    samples: VoiceMessageRecorder.downsample(recorder.waveformSamples, count: Self.pillBarCount),
                    progress: playback.progress,
                    height: 20
                )
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
            .frame(height: 22)
            .clipped()

            reviewStatus
                .frame(height: 15)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        Text(VoiceRecordingComposer.duration(recorder.trimEndMs - recorder.trimStartMs))
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .fixedSize()

        Button {
            showsTrim.toggle()
        } label: {
            Image(systemName: "scissors")
                .font(.callout.weight(.semibold))
                .foregroundStyle(showsTrim ? KordiTheme.signalBlue : Color.secondary)
                .frame(width: 34, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(recorder.transcriptionPhase == .transcribing)
        .accessibilityLabel(showsTrim ? "Hide trim controls" : "Trim voice recording")

        if recorder.transcriptionPhase == .failed {
            Button(action: recorder.retryTranscription) {
                Image(systemName: "arrow.clockwise")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 34, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!recorder.canRetryTranscription)
            .opacity(recorder.canRetryTranscription ? 1 : 0.4)
            .accessibilityLabel("Retry transcription")
        }
    }

    @ViewBuilder
    private var reviewStatus: some View {
        switch recorder.transcriptionPhase {
        case .transcribing:
            HStack(spacing: 4) {
                ProgressView()
                    .controlSize(.mini)
                Text("Transcribing…")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        case .failed:
            Text(recorder.errorMessage ?? "Unable to transcribe this recording.")
                .font(.caption2)
                .foregroundStyle(Color(uiColor: .systemRed))
                .lineLimit(1)
                .truncationMode(.tail)
        case .idle, .ready:
            Text("Ready to send")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var failedContent: some View {
        Text(recorder.errorMessage ?? "Voice recording unavailable.")
            .font(.caption)
            .foregroundStyle(Color(uiColor: .systemRed))
            .lineLimit(2)
            .minimumScaleFactor(0.85)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 13)

        Button {
            Task { await recorder.start() }
        } label: {
            Image(systemName: "arrow.clockwise")
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.secondary)
                .frame(width: 34, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Record voice message again")
    }

    private var sendButton: some View {
        Button(action: onSend) {
            Image(systemName: "arrow.up")
                .font(.body.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(KordiTheme.signalBlue, in: Circle())
                .contentShape(Circle().inset(by: -2))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .opacity(canSend ? 1 : 0.4)
        .accessibilityLabel("Send voice message")
    }

    static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, Int((Double(milliseconds) / 1_000).rounded()))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let voiceMessage: VoiceMessage
    let isActionPresented: Bool
    let reservesDeliveryStatus: Bool
    let onPrepare: (VoiceMessage) async -> URL?
    var deliveryState: MessageDeliveryState? = nil
    var readByCount: Int? = nil
    var deliveryTint: Color? = nil
    var onUpdateTranscript: ((VoiceMessage) async -> Bool)? = nil
    var onExpansionChange: (Bool) -> Void = { _ in }

    @State private var playback = VoiceMessagePlayback()
    @State private var showsTranscript = false

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
                            toggleTranscript()
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
                            if let deliveryState {
                                MessageDeliveryGlyph(state: deliveryState, readByCount: readByCount, tint: deliveryTint)
                                    .allowsHitTesting(false)
                            } else {
                                Color.clear.frame(width: 16, height: 14).accessibilityHidden(true)
                            }
                        }
                    }
                    .frame(height: 20)
                }
            }
            .transaction { $0.animation = nil }

            VoiceTranscriptDetails(voice: voiceMessage, onPrepare: onPrepare, onUpdate: onUpdateTranscript)
                .frame(height: showsTranscript ? nil : 0, alignment: .top)
                .clipped()
                .opacity(showsTranscript ? 1 : 0)
                .allowsHitTesting(showsTranscript)
                .accessibilityHidden(!showsTranscript)
        }
        .disabled(isActionPresented)
        .frame(width: Self.compactWidth(durationMs: voiceMessage.durationMs))
        .accessibilityElement(children: .contain)
        .onAppear { if showsTranscript { onExpansionChange(true) } }
        .onDisappear { if showsTranscript { onExpansionChange(false) } }
    }

    private func toggleTranscript() {
        let expanded = !showsTranscript
        if expanded { onExpansionChange(true) }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16), completionCriteria: .logicallyComplete) {
            showsTranscript = expanded
        } completion: {
            if !expanded && !showsTranscript { onExpansionChange(false) }
        }
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
    var height: CGFloat = 32

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, sample in
                Capsule()
                    .fill(
                        Double(index) / Double(max(1, values.count)) <= progress
                            ? activeColor
                            : Color.secondary.opacity(0.35)
                    )
                    .frame(maxWidth: 3, minHeight: 3, maxHeight: max(3, (height - 4) * sample))
            }
        }
        .frame(height: height)
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
