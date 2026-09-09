import SwiftUI
import UIKit

struct SharedEmojiAnimationView: View {
    let request: EmojiAnimationRequest
    let fallback: String
    let size: CGFloat
    var initialImage: UIImage?
    @State private var loadedKey: String?
    @State private var firstFrame: UIImage?
    @State private var prepared: PreparedEmojiAnimation?
    @State private var visible = true

    var body: some View {
        let active = EmojiPlaybackCoordinator.shared.animation(for: request.cacheKey)
        let animation = active ?? (loadedKey == request.cacheKey ? prepared : nil)
        ZStack {
            if let animation {
                PreparedEmojiImage(animation: animation, key: request.cacheKey, playing: visible)
            } else if loadedKey == request.cacheKey, let firstFrame {
                Image(uiImage: firstFrame).resizable().scaledToFit()
            } else if let initialImage {
                Image(uiImage: initialImage).resizable().scaledToFit()
            } else {
                Text(verbatim: fallback).font(.system(size: size * 0.9))
            }
        }
        .frame(width: size, height: size)
        .clipped()
        .modifier(EmojiPlaybackVisibility(visible: $visible))
        .task(id: request.cacheKey) {
            loadedKey = request.cacheKey
            prepared = active
            firstFrame = active?.frames.first
            guard active == nil else { return }
            for await phase in await EmojiAnimationRepository.shared.phases(for: request) {
                guard !Task.isCancelled else { return }
                switch phase {
                case .firstFrame(let frame):
                    firstFrame = frame
                case .ready(let animation):
                    prepared = animation
                }
            }
        }
    }
}

private struct EmojiPlaybackVisibility: ViewModifier {
    @Binding var visible: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
                .onAppear { visible = true }
                .onDisappear { visible = false }
        } else {
            content
                .onAppear { visible = true }
                .onDisappear { visible = false }
        }
    }
}

private struct PreparedEmojiImage: UIViewRepresentable {
    let animation: PreparedEmojiAnimation
    let key: String
    let playing: Bool

    func makeUIView(context: Context) -> EmojiAnimationRenderView {
        EmojiAnimationRenderView()
    }

    func updateUIView(_ view: EmojiAnimationRenderView, context: Context) {
        view.configure(animation: animation, key: key, playing: playing)
    }

    static func dismantleUIView(_ view: EmojiAnimationRenderView, coordinator: ()) {
        view.detach()
    }
}

@MainActor
final class EmojiAnimationRenderView: UIView {
    private var animation: PreparedEmojiAnimation?
    private(set) var animationKey: String?
    private var playing = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        layer.contentsGravity = .resizeAspect
    }

    required init?(coder: NSCoder) { nil }
    override var intrinsicContentSize: CGSize { .zero }

    func configure(animation: PreparedEmojiAnimation, key: String, playing: Bool) {
        guard animationKey != key || self.animation !== animation || self.playing != playing else { return }
        detach()
        self.animation = animation
        self.animationKey = key
        self.playing = playing
        show(animation.frames[0])
        updateRegistration()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateRegistration()
    }

    private func updateRegistration() {
        guard let animationKey else { return }
        if window != nil, playing, let animation, animation.frames.count > 1 {
            layer.contentsScale = window?.screen.scale ?? 1
            EmojiPlaybackCoordinator.shared.attach(self, key: animationKey, animation: animation)
        } else {
            EmojiPlaybackCoordinator.shared.detach(self, key: animationKey)
        }
    }

    func show(_ image: UIImage) {
        layer.contents = image.cgImage
    }

    func detach() {
        if let animationKey { EmojiPlaybackCoordinator.shared.detach(self, key: animationKey) }
        animationKey = nil
        animation = nil
        layer.contents = nil
    }
}

/// Frame ticks update backing layers only; they never publish SwiftUI state.
@MainActor
final class EmojiPlaybackCoordinator: NSObject {
    static let shared = EmojiPlaybackCoordinator()

    private final class WeakTarget {
        weak var view: EmojiAnimationRenderView?
        init(_ view: EmojiAnimationRenderView) { self.view = view }
    }

    private final class Playback {
        let animation: PreparedEmojiAnimation
        var targets: [ObjectIdentifier: WeakTarget] = [:]
        var elapsed: TimeInterval = 0
        var frame = 0
        init(_ animation: PreparedEmojiAnimation) { self.animation = animation }
    }

    @MainActor private final class DisplayLinkTarget: NSObject {
        weak var owner: EmojiPlaybackCoordinator?
        init(_ owner: EmojiPlaybackCoordinator) { self.owner = owner }
        @objc func tick(_ link: CADisplayLink) { owner?.tick(at: link.timestamp) }
    }

    private var entries: [String: Playback] = [:]
    private var displayLink: CADisplayLink?
    private var previousTimestamp: TimeInterval?
    private var applicationActive: Bool

    override init() {
        applicationActive = UIApplication.shared.applicationState == .active
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(applicationDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(applicationWillResignActive),
            name: UIApplication.willResignActiveNotification, object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        displayLink?.invalidate()
    }

    func animation(for key: String) -> PreparedEmojiAnimation? { entries[key]?.animation }

    func attach(_ view: EmojiAnimationRenderView, key: String, animation: PreparedEmojiAnimation) {
        let playback = entries[key] ?? Playback(animation)
        entries[key] = playback
        playback.targets[ObjectIdentifier(view)] = WeakTarget(view)
        view.show(playback.animation.frames[playback.frame])
        updateClock()
    }

    func detach(_ view: EmojiAnimationRenderView, key: String) {
        guard let playback = entries[key] else { return }
        playback.targets.removeValue(forKey: ObjectIdentifier(view))
        if playback.targets.isEmpty { entries.removeValue(forKey: key) }
        updateClock()
    }

    @objc private func applicationDidBecomeActive() {
        applicationActive = true
        updateClock()
    }

    @objc private func applicationWillResignActive() {
        applicationActive = false
        updateClock()
    }

    private func updateClock() {
        guard applicationActive, !entries.isEmpty else {
            displayLink?.invalidate()
            displayLink = nil
            previousTimestamp = nil
            return
        }
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: DisplayLinkTarget(self), selector: #selector(DisplayLinkTarget.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func tick(at timestamp: TimeInterval) {
        let delta = previousTimestamp.map { max(0, timestamp - $0) } ?? 0
        previousTimestamp = timestamp
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (key, playback) in entries {
            for (id, target) in playback.targets where target.view == nil {
                playback.targets.removeValue(forKey: id)
            }
            if playback.targets.isEmpty {
                entries.removeValue(forKey: key)
                continue
            }
            playback.elapsed = (playback.elapsed + delta).truncatingRemainder(dividingBy: playback.animation.duration)
            let frame = playback.animation.frameIndex(at: playback.elapsed)
            guard frame != playback.frame else { continue }
            playback.frame = frame
            for target in playback.targets.values { target.view?.show(playback.animation.frames[frame]) }
        }
        CATransaction.commit()
        if entries.isEmpty { updateClock() }
    }
}
