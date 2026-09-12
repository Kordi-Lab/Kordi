import UIKit

/// Scroll native content directly. For a virtualized history jump, hold the
/// current viewport until the destination is measured, then reveal it locally.
@MainActor
final class ConversationTailScrollAnimator: NSObject {

    private weak var scrollView: UIScrollView?
    private weak var contentView: UIView?
    private var pendingContentOriginY: CGFloat = 0
    private var pendingOriginCompensation = false
    private var pendingFromY: CGFloat?
    private var pendingAnimated = false
    private var pendingReduceMotion = false
    private var generation = 0
    private var reduceMotion = false
    private var positionedCompletion: (() -> Void)?
    private var positioningDisplayLink: CADisplayLink?
    private var previousGeometry: PositionedGeometry?
    private var keyboardAnimationDeadline: CFTimeInterval = 0
    private var nativeDisplayLink: CADisplayLink?
    private var nativeTargetY: CGFloat = 0
    private var nativeStartedAt: CFTimeInterval = 0
    private var nativePreviousGeometry: PositionedGeometry?
    private var jumpCover: UIView?
    private var jumpImage: UIView?
    private var isFadingJumpCover = false
    private var settledJumpFrames = 0
    var onTransitionVisibilityChange: (() -> Void)?
    var isTransitionCoveringContent: Bool { jumpCover != nil }

    var isAnimating: Bool { nativeDisplayLink != nil }

    private struct PositionedGeometry: Equatable {
        let contentSize: CGSize
        let viewportSize: CGSize
        // Keyboard layout can commit final bounds before their animation ends.
        let presentedViewportBounds: CGRect
        let insets: UIEdgeInsets
        let contentBounds: CGRect
        let targetY: CGFloat
    }

    var hasPendingRequest: Bool { pendingFromY != nil }

    func keyboardWillAnimate(until deadline: CFTimeInterval) {
        keyboardAnimationDeadline = deadline
        previousGeometry = nil
    }

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
        pendingOriginCompensation = contentView.map {
            $0.bounds.height <= scrollView.bounds.height - scrollView.adjustedContentInset.top - scrollView.adjustedContentInset.bottom
        } ?? false
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
        finishNativeAnimation()
        guard let scrollView else { return }
        // Stop UIKit at its current position; never restore an older sampled frame.
        scrollView.setContentOffset(scrollView.contentOffset, animated: false)
    }

    func disconnect() {
        cancel()
        keyboardAnimationDeadline = 0
        scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(userDidPan))
        scrollView = nil
    }

    func visibleOffset(in scrollView: UIScrollView) -> CGFloat {
        scrollView.layer.presentation()?.bounds.origin.y ?? scrollView.contentOffset.y
    }

    static func targetOffset(in scrollView: UIScrollView) -> CGFloat {
        return max(-scrollView.adjustedContentInset.top,
            scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
    }

    private func attach(to scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { return }
        // The keyboard notification may precede the first scroll request.
        let pendingKeyboardDeadline = keyboardAnimationDeadline
        disconnect()
        keyboardAnimationDeadline = pendingKeyboardDeadline
        self.scrollView = scrollView
        scrollView.panGestureRecognizer.addTarget(self, action: #selector(userDidPan))

    }

    @objc private func userDidPan(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began { cancel() }
    }

    private func flush(in scrollView: UIScrollView) {
        guard pendingFromY != nil else { return }
        if !isAnimating {
            scrollView.superview?.layoutIfNeeded()
            scrollView.layoutIfNeeded()
        }
        guard let previousY = pendingFromY else { return }
        let originDelta = pendingOriginCompensation
            ? (contentView?.convert(.zero, to: scrollView).y ?? 0) - pendingContentOriginY : 0
        let animated = pendingAnimated
        let reduceMotion = pendingReduceMotion
        pendingFromY = nil
        pendingAnimated = false
        let targetY = Self.targetOffset(in: scrollView)
        let running = isAnimating

        if positionedCompletion != nil {
            finishNativeAnimation()
            UIView.performWithoutAnimation {
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            }
            previousGeometry = positionedGeometry(in: scrollView)
            startPositioning()
            return
        }
        // Duplicate state changes must not restart a navigation transition.
        if running, abs(nativeTargetY - targetY) < 0.5, !reduceMotion { return }
        let shouldAnimate = !reduceMotion && (animated || running)
        if !shouldAnimate {
            finishNativeAnimation()
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            return
        }
        // Only an undersized bottom-aligned stack needs origin compensation.
        // Reapplying a lazy long-history origin change can reverse a tail jump.
        if !running, abs(originDelta) > 0.5 {
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: previousY + originDelta), animated: false)
        }
        guard abs(scrollView.contentOffset.y - targetY) > 0.5 else {
            finishNativeAnimation()
            return
        }
        if !running, let contentView, contentView.bounds.height > scrollView.bounds.height {
            beginJumpCover(in: scrollView)
        }
        nativeTargetY = targetY
        nativePreviousGeometry = nil
        if nativeDisplayLink == nil {
            nativeStartedAt = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(observeNativeAnimation))
            nativeDisplayLink = link
            link.add(to: .main, forMode: .common)
        }
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: jumpCover == nil)
    }

    private func visibleViewport(in scroll: UIScrollView, window: UIWindow) -> CGRect {
        if let presented = scroll.layer.presentation(), let root = window.layer.presentation() {
            return presented.convert(presented.bounds, to: root)
                .inset(by: scroll.adjustedContentInset).intersection(window.bounds)
        }
        return scroll.convert(scroll.bounds.inset(by: scroll.adjustedContentInset), to: window)
            .intersection(window.bounds)
    }

    private func beginJumpCover(in scroll: UIScrollView) {
        guard let window = scroll.window else { return }
        let viewport = visibleViewport(in: scroll, window: window)
        guard viewport.width > 0, viewport.height > 0 else { return }
        let image: UIView
        if let snapshot = window.resizableSnapshotView(from: viewport, afterScreenUpdates: false, withCapInsets: .zero) {
            image = snapshot
        } else {
            let format = UIGraphicsImageRendererFormat(); format.opaque = true
            let bitmap = UIGraphicsImageRenderer(size: viewport.size, format: format).image { context in
                UIColor.systemBackground.setFill(); context.cgContext.fill(CGRect(origin: .zero, size: viewport.size))
                context.cgContext.translateBy(x: -viewport.minX, y: -viewport.minY)
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
            image = UIImageView(image: bitmap)
        }
        let cover = UIView(frame: viewport)
        // Old pixels must not activate a different message at the new position.
        cover.isUserInteractionEnabled = true
        cover.accessibilityElementsHidden = true
        cover.accessibilityIdentifier = "conversation-jump-cover"
        cover.clipsToBounds = true
        image.frame = cover.bounds
        cover.addSubview(image)
        window.addSubview(cover)
        jumpCover = cover; jumpImage = image
        settledJumpFrames = 0; isFadingJumpCover = false
        onTransitionVisibilityChange?()
    }

    private func revealJumpDestination() {
        guard let cover = jumpCover, !isFadingJumpCover else { return }
        isFadingJumpCover = true
        UIView.animate(withDuration: 0.18, delay: 0,
            options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
            cover.alpha = 0
            self.jumpImage?.transform = CGAffineTransform(translationX: 0, y: -12)
        } completion: { [weak self, weak cover] _ in
            guard let self, let cover, self.jumpCover === cover else { return }
            self.finishNativeAnimation()
        }
    }

    @objc private func observeNativeAnimation() {
        guard let scrollView else { finishNativeAnimation(); return }
        guard !scrollView.isTracking, !scrollView.isDragging else { cancel(); return }
        let targetY = Self.targetOffset(in: scrollView)
        // Bound settling if repeated lazy measurements keep changing the target.
        if CACurrentMediaTime() - nativeStartedAt > 2 {
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            finishNativeAnimation()
            return
        }
        if let cover = jumpCover {
            guard let window = scrollView.window else { finishNativeAnimation(); return }
            cover.frame = visibleViewport(in: scrollView, window: window)
            nativeTargetY = targetY
            if abs(scrollView.contentOffset.y - targetY) > 0.5 {
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
                nativePreviousGeometry = nil; settledJumpFrames = 0
                return
            }
            guard CACurrentMediaTime() >= keyboardAnimationDeadline else {
                nativePreviousGeometry = nil; settledJumpFrames = 0
                return
            }
            let geometry = positionedGeometry(in: scrollView)
            let stable = nativePreviousGeometry.map {
                $0.contentSize == geometry.contentSize && $0.viewportSize == geometry.viewportSize
                    && $0.insets == geometry.insets && $0.contentBounds == geometry.contentBounds
                    && abs($0.targetY - geometry.targetY) < 0.5
            } ?? false
            settledJumpFrames = stable ? settledJumpFrames + 1 : 0
            nativePreviousGeometry = geometry
            if settledJumpFrames >= 4 { revealJumpDestination() }
            return
        }
        if abs(nativeTargetY - targetY) > 0.5 {
            request(in: scrollView, contentView: contentView, animated: true, reduceMotion: reduceMotion)
            return
        }
        guard abs(scrollView.contentOffset.y - targetY) < 0.5 else {
            nativePreviousGeometry = nil
            return
        }
        let geometry = positionedGeometry(in: scrollView)
        if nativePreviousGeometry == geometry { finishNativeAnimation() }
        else { nativePreviousGeometry = geometry }
    }

    private func finishNativeAnimation() {
        nativeDisplayLink?.invalidate()
        nativeDisplayLink = nil
        nativePreviousGeometry = nil
        let wasCovered = jumpCover != nil
        jumpCover?.layer.removeAllAnimations()
        jumpCover?.removeFromSuperview()
        jumpCover = nil; jumpImage = nil
        isFadingJumpCover = false; settledJumpFrames = 0
        if wasCovered { onTransitionVisibilityChange?() }
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
        // Presentation geometry can repeat between frames while the keyboard
        // animation is still active. Do not reveal from an intermediate pause.
        guard CACurrentMediaTime() >= keyboardAnimationDeadline else {
            previousGeometry = nil
            return
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
            presentedViewportBounds: scrollView.layer.presentation()?.bounds ?? scrollView.bounds,
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
