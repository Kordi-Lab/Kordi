import UIKit

/// Keeps the model at the measured tail and animates only its presentation offset.
/// Receipts do not restart movement; rapid sends retarget the visible position.
@MainActor
final class ConversationTailScrollAnimator: NSObject {
    static let animationKey = "kordi.conversation.tail"
    static let duration: TimeInterval = 0.2

    private weak var scrollView: UIScrollView?
    private var sizeObservation: NSKeyValueObservation?
    private weak var contentView: UIView?
    private var pendingContentOriginY: CGFloat = 0
    private var pendingFromY: CGFloat?
    private var pendingAnimated = false
    private var pendingReduceMotion = false
    private var generation = 0
    private var reduceMotion = false
    private var positionedCompletion: (() -> Void)?
    private var positioningDisplayLink: CADisplayLink?
    private var previousGeometry: PositionedGeometry?

    private struct PositionedGeometry: Equatable {
        let contentSize: CGSize
        let viewportSize: CGSize
        let insets: UIEdgeInsets
        let contentBounds: CGRect
        let targetY: CGFloat
    }

    var hasPendingRequest: Bool { pendingFromY != nil }

    func request(in scrollView: UIScrollView, contentView: UIView? = nil, animated: Bool, reduceMotion: Bool, onPositioned: (() -> Void)? = nil) {
        attach(to: scrollView)
        self.contentView = contentView
        self.reduceMotion = reduceMotion
        pendingAnimated = pendingAnimated || animated
        pendingReduceMotion = reduceMotion
        if let onPositioned {
            positionedCompletion = onPositioned
            previousGeometry = nil
        }
        guard pendingFromY == nil else { return }
        pendingFromY = visibleOffset(in: scrollView)
        pendingContentOriginY = contentView?.convert(.zero, to: scrollView).y ?? 0
        let requestedGeneration = generation
        DispatchQueue.main.async { [weak self, weak scrollView] in
            guard let self, let scrollView, self.generation == requestedGeneration else { return }
            self.flush(in: scrollView)
        }
    }

    func cancel() {
        generation &+= 1
        pendingFromY = nil
        pendingAnimated = false
        finishPositioning()
        guard let scrollView else { return }
        let displayedY = visibleOffset(in: scrollView)
        scrollView.layer.removeAnimation(forKey: Self.animationKey)
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: displayedY), animated: false)
    }

    func disconnect() {
        cancel()
        scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(userDidPan))
        sizeObservation = nil
        scrollView = nil
    }

    func visibleOffset(in scrollView: UIScrollView) -> CGFloat {
        scrollView.layer.presentation()?.bounds.origin.y ?? scrollView.contentOffset.y
    }

    static func targetOffset(in scrollView: UIScrollView) -> CGFloat {
        max(-scrollView.adjustedContentInset.top,
            scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
    }

    private func attach(to scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { return }
        disconnect()
        self.scrollView = scrollView
        scrollView.panGestureRecognizer.addTarget(self, action: #selector(userDidPan))
        sizeObservation = scrollView.observe(\.contentSize, options: [.old, .new]) { [weak self] view, change in
            guard change.oldValue != change.newValue else { return }
            Task { @MainActor [weak self, weak view] in
                guard let self, let view, view.layer.animation(forKey: Self.animationKey) != nil else { return }
                self.request(in: view, contentView: self.contentView, animated: false, reduceMotion: self.reduceMotion)
            }
        }
    }

    @objc private func userDidPan(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began { cancel() }
    }

    private func flush(in scrollView: UIScrollView) {
        guard pendingFromY != nil else { return }
        scrollView.superview?.layoutIfNeeded()
        scrollView.layoutIfNeeded()
        guard let previousY = pendingFromY else { return }
        // An undersized, bottom-aligned history moves within the viewport even
        // when contentOffset stays zero. Include that measured origin change.
        let currentContentOriginY = contentView?.convert(.zero, to: scrollView).y ?? 0
        let fromY = previousY + currentContentOriginY - pendingContentOriginY
        let animated = pendingAnimated
        let reduceMotion = pendingReduceMotion
        pendingFromY = nil
        pendingAnimated = false
        let targetY = Self.targetOffset(in: scrollView)
        let running = scrollView.layer.animation(forKey: Self.animationKey) != nil
        if positionedCompletion != nil {
            // The inserted row remains hidden until the viewport and measured
            // content agree. Never show its provisional pre-scroll position.
            scrollView.layer.removeAnimation(forKey: Self.animationKey)
            UIView.performWithoutAnimation {
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            }
            previousGeometry = positionedGeometry(in: scrollView)
            startPositioning()
            return
        }
        // The logical offset already equals the destination during an animation.
        // A delivery receipt or duplicate layout request must not snap to it.
        if abs(scrollView.contentOffset.y - targetY) < 0.5, running, !reduceMotion { return }
        scrollView.layer.removeAnimation(forKey: Self.animationKey)
        UIView.performWithoutAnimation {
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
        }
        guard !reduceMotion, (animated || running), abs(fromY - targetY) > 0.5 else { return }
        let animation = CABasicAnimation(keyPath: "bounds.origin.y")
        animation.fromValue = fromY
        animation.toValue = targetY
        animation.duration = Self.duration
        animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
        scrollView.layer.add(animation, forKey: Self.animationKey)
    }

    private func startPositioning() {
        guard positioningDisplayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(positionBeforeDisplay))
        positioningDisplayLink = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func positionBeforeDisplay() {
        guard let scrollView, positionedCompletion != nil else {
            finishPositioning()
            return
        }
        guard !scrollView.isDragging, !scrollView.isTracking else {
            finishPositioning()
            return
        }
        scrollView.superview?.layoutIfNeeded()
        scrollView.layoutIfNeeded()
        guard scrollView.bounds.height > 0, scrollView.contentSize.height > 0 else { return }
        let targetY = Self.targetOffset(in: scrollView)
        UIView.performWithoutAnimation {
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
        }
        let geometry = positionedGeometry(in: scrollView)
        if previousGeometry == geometry, abs(scrollView.contentOffset.y - targetY) < 0.5 {
            finishPositioning()
        } else {
            previousGeometry = geometry
        }
    }

    private func positionedGeometry(in scrollView: UIScrollView) -> PositionedGeometry {
        PositionedGeometry(
            contentSize: scrollView.contentSize,
            viewportSize: scrollView.bounds.size,
            insets: scrollView.adjustedContentInset,
            contentBounds: contentView?.bounds ?? .zero,
            targetY: Self.targetOffset(in: scrollView)
        )
    }

    private func finishPositioning() {
        positioningDisplayLink?.invalidate()
        positioningDisplayLink = nil
        previousGeometry = nil
        let completion = positionedCompletion
        positionedCompletion = nil
        completion?()
    }

}
