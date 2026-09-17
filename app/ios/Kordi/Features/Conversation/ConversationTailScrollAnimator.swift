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
    /// Frame-driven scroll toward `nativeTargetY`. The model offset advances every
    /// display frame, so lazy rows, read probes and unread state see real movement
    /// rather than a bounds jump hidden behind a Core Animation presentation.
    private var scrollSegment: ConversationTailScrollMotion.Segment?
    private var jumpCover: UIView?
    private var jumpImage: UIView?
    private var isFadingJumpCover = false
    private var contentSizeObservation: NSKeyValueObservation?
    private var pendingResizeSnapshot: UIView?
    private var settledJumpFrames = 0
    private var messageJumpTargetY: (() -> CGFloat?)?
    private var messageJumpCompletion: (() -> Void)?
    private var jumpRevealTranslation: CGFloat = -12
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
        // A message jump owns the viewport until it reveals; content-follow requests wait.
        if messageJumpTargetY != nil, onPositioned == nil, self.scrollView === scrollView { return }
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

    /// Jump to a distant message with the same motion as a long jump to the latest
    /// message: hold a snapshot of the current viewport, position the destination
    /// underneath, and reveal it once its measured geometry settles.
    func jumpToMessage(
        in scrollView: UIScrollView,
        contentView: UIView?,
        movingToOlder: Bool,
        reduceMotion: Bool,
        targetOffsetY: @escaping () -> CGFloat?,
        onRevealed: @escaping () -> Void
    ) {
        attach(to: scrollView)
        if let contentView { self.contentView = contentView }
        generation &+= 1
        pendingFromY = nil
        pendingAnimated = false
        // Finishing resumes any earlier jump's waiter, so no caller is left suspended.
        finishNativeAnimation()
        self.reduceMotion = reduceMotion
        messageJumpTargetY = targetOffsetY
        messageJumpCompletion = onRevealed
        jumpRevealTranslation = movingToOlder ? 12 : -12
        if !reduceMotion { beginJumpCover(in: scrollView) }
        nativePreviousGeometry = nil
        settledJumpFrames = 0
        nativeStartedAt = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(observeNativeAnimation))
        nativeDisplayLink = link
        link.add(to: .main, forMode: .common)
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
        contentSizeObservation = nil
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

        // A send reveals its row as the transcript starts moving, so the new
        // bubble travels with its neighbours instead of appearing after a
        // hidden settle. Reduced motion and an in-flight keyboard transition
        // keep the measured, instant placement.
        let animatesSend = positionedCompletion != nil && animated && !reduceMotion
            && CACurrentMediaTime() >= keyboardAnimationDeadline
        if positionedCompletion != nil, !animatesSend {
            finishNativeAnimation()
            UIView.performWithoutAnimation {
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            }
            previousGeometry = positionedGeometry(in: scrollView)
            startPositioning()
            return
        }
        let revealSend: (() -> Void)? = animatesSend ? positionedCompletion : nil
        if animatesSend { positionedCompletion = nil }
        defer { revealSend?() }
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
            // A content-size clamp may already have reached the new target.
            // Keep its replacement cover until measurement and reveal finish.
            if jumpCover == nil { finishNativeAnimation() }
            else { nativeTargetY = targetY }
            return
        }
        // A send moves by about one row; only a genuine history jump needs the
        // snapshot cover that hides unmeasured lazy rows.
        if !running, !animatesSend, let contentView, contentView.bounds.height > scrollView.bounds.height {
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
        if jumpCover == nil {
            beginScrollSegment(to: targetY, in: scrollView)
        } else {
            scrollSegment = nil
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
        }
    }

    /// Continue toward a new target from the offset currently on screen.
    private func beginScrollSegment(to targetY: CGFloat, in scrollView: UIScrollView) {
        let now = CACurrentMediaTime()
        let fromY = scrollSegment.map { $0.offset(at: now) } ?? scrollView.contentOffset.y
        scrollSegment = ConversationTailScrollMotion.Segment(fromY: fromY, toY: targetY, startedAt: now)
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: fromY), animated: false)
    }

    private func visibleViewport(in scroll: UIScrollView, window: UIWindow) -> CGRect {
        if let presented = scroll.layer.presentation(), let root = window.layer.presentation() {
            return presented.convert(presented.bounds, to: root)
                .inset(by: scroll.adjustedContentInset).intersection(window.bounds)
        }
        return scroll.convert(scroll.bounds.inset(by: scroll.adjustedContentInset), to: window)
            .intersection(window.bounds)
    }

    private func viewportSnapshot(in window: UIWindow, viewport: CGRect) -> UIView {
        if let snapshot = window.resizableSnapshotView(from: viewport, afterScreenUpdates: false, withCapInsets: .zero) {
            return snapshot
        } else {
            let format = UIGraphicsImageRendererFormat(); format.opaque = true
            let bitmap = UIGraphicsImageRenderer(size: viewport.size, format: format).image { context in
                UIColor.systemBackground.setFill(); context.cgContext.fill(CGRect(origin: .zero, size: viewport.size))
                context.cgContext.translateBy(x: -viewport.minX, y: -viewport.minY)
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
            return UIImageView(image: bitmap)
        }
    }

    private func beginJumpCover(in scroll: UIScrollView, snapshot: UIView? = nil) {
        guard let window = scroll.window else { return }
        let viewport = visibleViewport(in: scroll, window: window)
        guard viewport.width > 0, viewport.height > 0 else { return }
        let image = snapshot ?? viewportSnapshot(in: window, viewport: viewport)
        let previousCover = jumpCover
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
        // Replace the partially faded cover atomically. Its completion belongs
        // to the old view and must not finish this new measurement/reveal cycle.
        previousCover?.layer.removeAllAnimations()
        previousCover?.removeFromSuperview()
        if previousCover == nil { onTransitionVisibilityChange?() }
    }

    private func observeContentSizeDuringReveal(in scrollView: UIScrollView) {
        guard contentSizeObservation == nil else { return }
        contentSizeObservation = scrollView.observe(\.contentSize, options: [.old, .new, .prior]) { [weak self, weak scrollView] _, change in
            MainActor.assumeIsolated {
                guard let self, let scrollView, self.isFadingJumpCover else { return }
                if change.isPrior {
                    // UIKit can clamp the offset inside the contentSize setter.
                    // Capture the composited frame before either layout moves.
                    if let window = scrollView.window, let cover = self.jumpCover {
                        self.pendingResizeSnapshot = self.viewportSnapshot(in: window, viewport: cover.frame)
                    }
                } else {
                    defer { self.pendingResizeSnapshot = nil }
                    guard change.oldValue != change.newValue,
                          let snapshot = self.pendingResizeSnapshot else { return }
                    self.beginJumpCover(in: scrollView, snapshot: snapshot)
                    self.nativePreviousGeometry = nil
                }
            }
        }
    }

    private func revealJumpDestination() {
        guard let cover = jumpCover, !isFadingJumpCover else { return }
        if let scrollView { observeContentSizeDuringReveal(in: scrollView) }
        isFadingJumpCover = true
        UIView.animate(withDuration: 0.18, delay: 0,
            options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
            cover.alpha = 0
            self.jumpImage?.transform = CGAffineTransform(translationX: 0, y: self.jumpRevealTranslation)
        } completion: { [weak self, weak cover] _ in
            guard let self, let cover, self.jumpCover === cover else { return }
            self.finishNativeAnimation()
        }
    }

    @objc private func observeNativeAnimation() {
        guard let scrollView else { finishNativeAnimation(); return }
        guard !scrollView.isTracking, !scrollView.isDragging else { cancel(); return }
        if let messageJumpTargetY {
            observeMessageJump(in: scrollView, resolveTargetY: messageJumpTargetY)
            return
        }
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
            // Lazy measurement moved the tail while scrolling. Retarget from the
            // offset on screen so the motion never reverses or restarts.
            nativeTargetY = targetY
            nativePreviousGeometry = nil
            beginScrollSegment(to: targetY, in: scrollView)
        }
        if let segment = scrollSegment {
            let now = CACurrentMediaTime()
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: segment.offset(at: now)), animated: false)
            guard segment.isFinished(at: now) else {
                nativePreviousGeometry = nil
                return
            }
            scrollSegment = nil
        }
        guard abs(scrollView.contentOffset.y - targetY) < 0.5 else {
            nativePreviousGeometry = nil
            return
        }
        let geometry = positionedGeometry(in: scrollView)
        if nativePreviousGeometry == geometry { finishNativeAnimation() }
        else { nativePreviousGeometry = geometry }
    }

    private func observeMessageJump(in scrollView: UIScrollView, resolveTargetY: () -> CGFloat?) {
        let timedOut = CACurrentMediaTime() - nativeStartedAt > 2
        if let cover = jumpCover, let window = scrollView.window {
            cover.frame = visibleViewport(in: scrollView, window: window)
        }
        guard let targetY = resolveTargetY() else {
            // The destination row is not built yet.
            nativePreviousGeometry = nil; settledJumpFrames = 0
            if timedOut { finishNativeAnimation() }
            return
        }
        if timedOut {
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            finishNativeAnimation()
            return
        }
        if abs(scrollView.contentOffset.y - targetY) > 0.5 {
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: targetY), animated: false)
            nativePreviousGeometry = nil; settledJumpFrames = 0
            return
        }
        let geometry = positionedGeometry(in: scrollView, targetY: targetY)
        let stable = nativePreviousGeometry.map {
            $0.contentSize == geometry.contentSize && $0.viewportSize == geometry.viewportSize
                && $0.insets == geometry.insets && $0.contentBounds == geometry.contentBounds
                && abs($0.targetY - geometry.targetY) < 0.5
        } ?? false
        settledJumpFrames = stable ? settledJumpFrames + 1 : 0
        nativePreviousGeometry = geometry
        guard settledJumpFrames >= 4 else { return }
        if jumpCover != nil { revealJumpDestination() } else { finishNativeAnimation() }
    }

    private func finishNativeAnimation() {
        contentSizeObservation = nil
        nativeDisplayLink?.invalidate()
        nativeDisplayLink = nil
        nativePreviousGeometry = nil
        scrollSegment = nil
        let wasCovered = jumpCover != nil
        jumpCover?.layer.removeAllAnimations()
        jumpCover?.removeFromSuperview()
        jumpCover = nil; jumpImage = nil
        pendingResizeSnapshot = nil
        isFadingJumpCover = false; settledJumpFrames = 0
        jumpRevealTranslation = -12
        messageJumpTargetY = nil
        if wasCovered { onTransitionVisibilityChange?() }
        if let completion = messageJumpCompletion {
            messageJumpCompletion = nil
            completion()
        }
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

    private func positionedGeometry(in scrollView: UIScrollView, targetY: CGFloat? = nil) -> PositionedGeometry {
        PositionedGeometry(
            contentSize: scrollView.contentSize,
            viewportSize: scrollView.bounds.size,
            presentedViewportBounds: scrollView.layer.presentation()?.bounds ?? scrollView.bounds,
            insets: scrollView.adjustedContentInset,
            contentBounds: contentView?.bounds ?? .zero,
            targetY: targetY ?? Self.targetOffset(in: scrollView)
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
