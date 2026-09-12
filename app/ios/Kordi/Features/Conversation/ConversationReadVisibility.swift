import SwiftUI
import UIKit

struct MentionPresentationModifier: ViewModifier {
    let isPending: Bool
    let viewportFrame: CGRect
    let action: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.5) { isVisible in
                guard isPending, isVisible else { return }
                action()
            }
        } else {
            content.onGeometryChange(for: Bool.self) { [isPending, viewportFrame] geometry in
                isPending && geometry.frame(in: .global).intersects(viewportFrame)
            } action: { isVisible in
                if isVisible { action() }
            }
        }
    }
}

/// Visibility is separate from tail geometry: a reply can be readable while
/// the viewport remains slightly above the exact bottom scroll offset.
struct LatestMessageVisibilityModifier: ViewModifier {
    let messageID: String
    let isLatest: Bool
    let isEnabled: Bool
    let update: (Bool) -> Void

    func body(content: Content) -> some View {
        content.background {
            if isLatest && isEnabled {
                ConversationReadVisibilityProbe(messageID: messageID, mode: .latest, update: update)
            }
        }
        .onDisappear { update(false) }
    }
}

struct ConversationReadPresentation: Equatable {
    let conversationID: String
    let isPresented: Bool
    let isAppForeground: Bool
    let isAtLatest: Bool
    var threadRootID: String? = nil
    var visibleMessageID: String? = nil

    var canMarkRead: Bool {
        isPresented && isAppForeground && isAtLatest
    }

    func canMarkRead(latestMessageID: String?) -> Bool {
        canMarkRead && (visibleMessageID == nil || visibleMessageID == latestMessageID)
    }
}

extension AppModel {
    func presentationCanMarkRead(_ presentation: ConversationReadPresentation) -> Bool {
        guard presentation.canMarkRead, presentation.visibleMessageID != nil else { return presentation.canMarkRead }
        let displayed = ChatCallActivityTimeline.collapsingStatuses(in: messagesByConversation[presentation.conversationID] ?? [])
        let projection = MessageThreadProjection(messages: displayed)
        let timeline = presentation.threadRootID.flatMap { projection.thread(rootID: $0)?.messages } ?? projection.mainMessages
        return presentation.canMarkRead(latestMessageID: timeline.last?.id)
    }

    func latestIncomingMessageID(
        for conversation: ConversationSummary,
        throughSequence: Int64? = nil
    ) -> String? {
        messagesByConversation[conversation.id]?
            .last(where: { message in
                guard message.author != .me else { return false }
                return throughSequence.map { sequence in
                    message.conversationSequence.map { $0 <= sequence } ?? false
                } ?? true
            })?
            .id
    }

}

/// Store a content anchor, not a distance from the beginning of a lazy timeline.
/// Earlier rows can be measured differently on the next visit.
struct ConversationReadingAnchor: Equatable {
    let messageID: String
    let offsetFromViewportTop: CGFloat
}

// Bookkeeping is deliberately not observable: scrolling must not invalidate rows.
@MainActor
final class ConversationScrollPosition {
    private final class WeakRow {
        weak var view: UIView?
        init(_ view: UIView) { self.view = view }
    }
    private var rows: [String: WeakRow] = [:]
    private weak var scrollView: UIScrollView?
    private weak var navigationAnimator: ConversationTailScrollAnimator?
    private var initialPositioner: ConversationInitialPositioner?
    private var isAnchorCaptureScheduled = false
    var contentOffsetY: CGFloat?
    var isPositioningInitialTimeline = false
    var isTransitionCovered = false
    private(set) var readingAnchor: ConversationReadingAnchor?
    // Native rows can detach before SwiftUI delivers the conversation's exit.
    // Keep the last displayed anchor separately from the current live geometry.
    private(set) var lastVisibleReadingAnchor: ConversationReadingAnchor?

    func positionInitialViewport(using position: @escaping () -> Bool) async -> Bool {
        let positioner = ConversationInitialPositioner(position: position)
        initialPositioner = positioner
        defer { if initialPositioner === positioner { initialPositioner = nil } }
        return await positioner.waitUntilPositioned()
    }

    func cancelInitialPositioning() {
        initialPositioner?.cancel()
    }

    func attachNavigationAnimator(_ animator: ConversationTailScrollAnimator) { navigationAnimator = animator }
    func cancelScrolling() {
        navigationAnimator?.cancel()
        isTransitionCovered = false
    }

    var isUserScrolling: Bool {
        guard let scrollView else { return false }
        return scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating
    }

    func attach(to scrollView: UIScrollView) {
        self.scrollView = scrollView
    }

    func register(_ view: UIView, messageID: String) {
        rows[messageID] = WeakRow(view)
    }

    func unregister(_ view: UIView, messageID: String) {
        if rows[messageID]?.view === view { rows[messageID] = nil }
    }

    func scheduleReadingAnchorCapture() {
        guard !isAnchorCaptureScheduled else { return }
        isAnchorCaptureScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.isAnchorCaptureScheduled = false
            self.captureReadingAnchor()
        }
    }

    func captureReadingAnchor() {
        guard let scrollView, scrollView.window != nil else { return }
        let viewport = scrollView.bounds.inset(by: scrollView.adjustedContentInset)
        let candidates = rows.compactMap { id, row -> ConversationReadingAnchor? in
            guard let view = row.view, view.window === scrollView.window,
                  view.isDescendant(of: scrollView), view.bounds.height > 0 else { return nil }
            let frame = view.convert(view.bounds, to: scrollView)
            guard frame.intersection(viewport).height > 0 else { return nil }
            return ConversationReadingAnchor(messageID: id, offsetFromViewportTop: frame.minY - viewport.minY)
        }
        readingAnchor = candidates.min { $0.offsetFromViewportTop < $1.offsetFromViewportTop }
        if let readingAnchor { lastVisibleReadingAnchor = readingAnchor }
    }

    func positionAtLatest(requiredMessageID: String? = nil) -> Bool {
        guard let scrollView, scrollView.window != nil,
              !scrollView.isTracking, !scrollView.isDragging,
              scrollView.bounds.height > 0, scrollView.contentSize.height > 0 else { return false }
        scrollView.layoutIfNeeded()
        if let requiredMessageID {
            guard let row = rows[requiredMessageID]?.view,
                  row.window === scrollView.window, row.isDescendant(of: scrollView),
                  row.bounds.height > 0 else { return false }
        }
        let target = ConversationTailScrollAnimator.targetOffset(in: scrollView)
        guard abs(scrollView.contentOffset.y - target) > 1 else { return true }
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: target), animated: false)
        return false
    }

    /// Return true only when a subsequent layout already has the saved position.
    /// The caller materializes the identity first, then waits for settled layout.
    func restore(_ anchor: ConversationReadingAnchor) -> Bool {
        guard let scrollView, scrollView.window != nil,
              !scrollView.isTracking, !scrollView.isDragging,
              let row = rows[anchor.messageID]?.view, row.window === scrollView.window,
              row.isDescendant(of: scrollView), row.bounds.height > 0 else { return false }
        let frame = row.convert(row.bounds, to: scrollView)
        let target = ConversationTimelineScrollBehavior.clampedContentOffsetY(
            frame.minY - scrollView.adjustedContentInset.top - anchor.offsetFromViewportTop,
            contentHeight: scrollView.contentSize.height, containerHeight: scrollView.bounds.height,
            topInset: scrollView.adjustedContentInset.top, bottomInset: scrollView.adjustedContentInset.bottom
        )
        guard abs(scrollView.contentOffset.y - target) > 1 else { return true }
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: target), animated: false)
        return false
    }
}

/// Position on display frames, with no timer-based quiet period. Cancellation
/// belongs to the opening task so a dismissed chat cannot finish revealing later.
@MainActor
final class ConversationInitialPositioner: NSObject {
    private let position: () -> Bool
    private var displayLink: CADisplayLink?
    private var completion: ((Bool) -> Void)?
    private var deadline: CFTimeInterval = 0
    private var stableFrames = 0

    init(position: @escaping () -> Bool) {
        self.position = position
    }

    func waitUntilPositioned() async -> Bool {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: false); return }
                completion = { continuation.resume(returning: $0) }
                deadline = CACurrentMediaTime() + 2
                let link = CADisplayLink(target: self, selector: #selector(beforeDisplay))
                displayLink = link
                link.add(to: .main, forMode: .common)
            }
        } onCancel: {
            Task { @MainActor in self.finish(false) }
        }
    }

    func cancel() { finish(false) }

    @objc private func beforeDisplay() {
        stableFrames = position() ? stableFrames + 1 : 0
        if stableFrames >= 2 { finish(true) }
        else if CACurrentMediaTime() >= deadline { finish(false) }
    }

    private func finish(_ positioned: Bool) {
        displayLink?.invalidate()
        displayLink = nil
        let completion = completion
        self.completion = nil
        completion?(positioned)
    }
}

/// Weak row references allow capture after native layout without a geometry
/// preference or a scroll observer on every message.
struct ConversationReadingAnchorProbe: UIViewRepresentable {
    let messageID: String
    let position: ConversationScrollPosition

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        return view
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func updateUIView(_ view: ProbeView, context: Context) {
        if let previous = context.coordinator.messageID, previous != messageID {
            position.unregister(view, messageID: previous)
        }
        context.coordinator.messageID = messageID
        context.coordinator.position = position
        view.position = position
        position.register(view, messageID: messageID)
        position.scheduleReadingAnchorCapture()
    }

    static func dismantleUIView(_ view: ProbeView, coordinator: Coordinator) {
        if let id = coordinator.messageID { coordinator.position?.unregister(view, messageID: id) }
        view.position = nil
    }

    final class ProbeView: UIView {
        weak var position: ConversationScrollPosition?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { position?.scheduleReadingAnchorCapture() }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            if window != nil { position?.scheduleReadingAnchorCapture() }
        }
    }

    final class Coordinator {
        var messageID: String?
        weak var position: ConversationScrollPosition?
    }
}

struct ConversationScrollGeometrySnapshot: Equatable {
    let isAtLatest: Bool
    let contentOffsetY: CGFloat
    let minimumOffsetY: CGFloat
    let maximumOffsetY: CGFloat
    let isValid: Bool
}


extension ConversationInitialViewport {
    var readAnchorID: String? {
        guard case let .resumed(id) = self else { return nil }
        return id
    }
}

struct InitialReadAnchorModifier: ViewModifier {
    let messageID: String
    let isAnchor: Bool
    let positioned: () -> Void

    func body(content: Content) -> some View {
        content.background {
            if isAnchor {
                ConversationReadVisibilityProbe(messageID: messageID, mode: .initialAnchor) { restored in
                    if restored { positioned() }
                }
            }
        }
    }
}

/// Sample UIKit after layout, outside SwiftUI's preference evaluation. Reading
/// global geometry for every row can create a layout cycle during keyboard moves.
/// Only the latest message and the initial restore anchor install these probes.
struct ConversationReadVisibilityProbe: UIViewRepresentable {
    enum Mode { case latest, initialAnchor }
    let messageID: String
    let mode: Mode
    let update: (Bool) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.configure(messageID: messageID, mode: mode, update: update)
    }

    static func dismantleUIView(_ view: ProbeView, coordinator: ()) {
        view.disconnect()
    }

    @MainActor
    final class ProbeView: UIView {
        private weak var scrollView: UIScrollView?
        private var observations: [NSKeyValueObservation] = []
        private var messageID: String?
        private var mode: Mode = .latest
        private var update: ((Bool) -> Void)?
        private var lastVisible: Bool?
        private var sampleScheduled = false

        func configure(messageID: String, mode: Mode, update: @escaping (Bool) -> Void) {
            if self.messageID != messageID || self.mode != mode {
                invalidateVisibility()
                self.messageID = messageID
                self.mode = mode
            }
            self.update = update
            scheduleSample()
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            scheduleSample()
        }

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            scheduleSample()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            scheduleSample()
        }

        nonisolated private func scheduleObservedSample() {
            DispatchQueue.main.async { [weak self] in self?.scheduleSample() }
        }

        private func scheduleSample() {
            guard !sampleScheduled else { return }
            sampleScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.sampleScheduled = false
                guard self.update != nil else { return }
                self.sample()
            }
        }

        private func sample() {
            var ancestor = superview
            while let current = ancestor, !(current is UIScrollView) {
                ancestor = current.superview
            }
            let enclosing = ancestor as? UIScrollView
            if scrollView !== enclosing {
                observations = []
                scrollView = enclosing
                if let enclosing {
                    observations = [
                        enclosing.observe(\.contentOffset) { [weak self] _, _ in self?.scheduleObservedSample() },
                        enclosing.observe(\.contentSize) { [weak self] _, _ in self?.scheduleObservedSample() },
                        enclosing.observe(\.bounds) { [weak self] _, _ in self?.scheduleObservedSample() },
                        enclosing.observe(\.adjustedContentInset) { [weak self] _, _ in self?.scheduleObservedSample() }
                    ]
                }
            }
            let visible = isVisible()
            guard lastVisible != visible else { return }
            lastVisible = visible
            update?(visible)
        }

        private func isVisible() -> Bool {
            guard window != nil, let scrollView, scrollView.window === window,
                  bounds.height > 0 else { return false }
            let frame = convert(bounds, to: scrollView)
            let viewport = scrollView.bounds.inset(by: scrollView.adjustedContentInset)
            let intersection = frame.intersection(viewport)
            guard !intersection.isNull, intersection.height > 0 else { return false }
            switch mode {
            case .latest:
                return intersection.height >= frame.height * 0.5
            case .initialAnchor:
                let delta = frame.midY - viewport.midY
                let minimum = -scrollView.adjustedContentInset.top
                let maximum = max(minimum, scrollView.contentSize.height - scrollView.bounds.height
                    + scrollView.adjustedContentInset.bottom)
                return abs(delta) <= 16
                    || (delta < 0 && scrollView.contentOffset.y <= minimum + 2)
                    || (delta > 0 && scrollView.contentOffset.y >= maximum - 2)
            }
        }

        private func invalidateVisibility() {
            if lastVisible == true, let update {
                DispatchQueue.main.async { update(false) }
            }
            lastVisible = nil
        }

        func disconnect() {
            observations = []
            scrollView = nil
            invalidateVisibility()
            update = nil
        }
    }
}
