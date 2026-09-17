import CoreGraphics
import QuartzCore

/// Shared motion for native tail scrolling. Sends, receipts and late growth
/// move the transcript on display frames with the same ease-out curve the
/// outgoing bubble uses, so the two animations settle together.
enum ConversationTailScrollMotion {
    /// Matches `MessageSendEntranceTransform` and the desktop transcript lift.
    static let duration: CFTimeInterval = 0.24
    static let curve = CubicBezierEase(x1: 0.23, y1: 1, x2: 0.32, y2: 1)

    /// One frame-driven scroll from a start offset to a target offset.
    struct Segment {
        let fromY: CGFloat
        let toY: CGFloat
        let startedAt: CFTimeInterval
        let duration: CFTimeInterval

        init(fromY: CGFloat, toY: CGFloat, startedAt: CFTimeInterval, duration: CFTimeInterval = ConversationTailScrollMotion.duration) {
            self.fromY = fromY
            self.toY = toY
            self.startedAt = startedAt
            self.duration = duration
        }

        func progress(at time: CFTimeInterval) -> CGFloat {
            guard duration > 0 else { return 1 }
            return CGFloat(min(1, max(0, (time - startedAt) / duration)))
        }

        func offset(at time: CFTimeInterval) -> CGFloat {
            let eased = ConversationTailScrollMotion.curve.value(at: progress(at: time))
            return fromY + (toY - fromY) * eased
        }

        func isFinished(at time: CFTimeInterval) -> Bool {
            progress(at: time) >= 1
        }
    }
}

/// CSS-style cubic bezier easing evaluated by Newton iteration on the x axis.
struct CubicBezierEase {
    let x1: CGFloat
    let y1: CGFloat
    let x2: CGFloat
    let y2: CGFloat

    func value(at x: CGFloat) -> CGFloat {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        var t = x
        for _ in 0..<8 {
            let currentX = sample(t, x1, x2) - x
            let derivative = slope(t, x1, x2)
            guard abs(currentX) > 1e-6, abs(derivative) > 1e-6 else { break }
            t -= currentX / derivative
        }
        return sample(min(1, max(0, t)), y1, y2)
    }

    private func sample(_ t: CGFloat, _ p1: CGFloat, _ p2: CGFloat) -> CGFloat {
        let oneMinusT = 1 - t
        return 3 * oneMinusT * oneMinusT * t * p1 + 3 * oneMinusT * t * t * p2 + t * t * t
    }

    private func slope(_ t: CGFloat, _ p1: CGFloat, _ p2: CGFloat) -> CGFloat {
        let oneMinusT = 1 - t
        return 3 * oneMinusT * oneMinusT * p1 + 6 * oneMinusT * t * (p2 - p1) + 3 * t * t * (1 - p2)
    }
}
