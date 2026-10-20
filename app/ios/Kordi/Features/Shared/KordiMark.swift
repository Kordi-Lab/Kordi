import SwiftUI
import UIKit

/// One frame of the flight animation, in the mark's 512-unit design box.
struct KordiBirdFlightSample: Equatable {
    /// Wing rotation around its root, in degrees. Positive is down.
    let wingAngle: Double
    /// Horizontal body offset in design units. Positive is forward (right).
    let bodyOffsetX: Double
    /// Vertical body offset in design units. Negative is up.
    let bodyOffsetY: Double
    /// Whole-bird rotation in degrees around the body centre.
    let bodyRotation: Double

    /// Flight pose held still: the wing at `wingAngle`, the body at rest.
    static func holding(wingAngle: Double) -> KordiBirdFlightSample {
        KordiBirdFlightSample(wingAngle: wingAngle, bodyOffsetX: 0, bodyOffsetY: 0, bodyRotation: 0)
    }
}

/// Matches the desktop flight: a fast flap and a strong swoop, both ease-in-out.
enum KordiBirdFlightMotion {
    static let wingDownAngle: Double = 32
    static let wingUpAngle: Double = -78
    static let flapDuration: TimeInterval = 0.36

    static let bodyLowOffset = CGSize(width: -10, height: 34)
    static let bodyHighOffset = CGSize(width: 10, height: -40)
    static let bodyLowRotation: Double = -6
    static let bodyHighRotation: Double = 4
    static let swoopDuration: TimeInterval = 0.72

    /// First pose: wing down, body low and back.
    static let rest = sample(elapsed: 0)

    static func sample(elapsed: TimeInterval) -> KordiBirdFlightSample {
        let safeElapsed = max(0, elapsed)
        let flap = easedCycle(safeElapsed, duration: flapDuration)
        let swoop = easedCycle(safeElapsed, duration: swoopDuration)
        return KordiBirdFlightSample(
            wingAngle: wingAngle(progress: flap),
            bodyOffsetX: Double(bodyLowOffset.width + ((bodyHighOffset.width - bodyLowOffset.width) * swoop)),
            bodyOffsetY: Double(bodyLowOffset.height + ((bodyHighOffset.height - bodyLowOffset.height) * swoop)),
            bodyRotation: bodyLowRotation + ((bodyHighRotation - bodyLowRotation) * swoop)
        )
    }

    /// Wing angle from fully down (0) to fully up (1).
    static func wingAngle(progress: Double) -> Double {
        let clamped = min(max(progress, 0), 1)
        return wingDownAngle + ((wingUpAngle - wingDownAngle) * clamped)
    }

    /// 0 at the start of each cycle, 1 halfway, with ease-in-out at both ends.
    private static func easedCycle(_ elapsed: TimeInterval, duration: TimeInterval) -> CGFloat {
        CGFloat((1 - cos(elapsed * .pi * 2 / duration)) / 2)
    }
}

/// Kordi's paper-cut bird. Static is the app icon pose; flying flaps and bobs
/// until reduce motion is on, which shows the static pose instead.
struct KordiMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var size: CGFloat = 44
    var flying = false
    /// Draws exactly this pose instead of animating; for marks driven by their own timeline.
    var pose: KordiBirdPose?
    @State private var animationEpoch = Date()

    var body: some View {
        Group {
            if let pose {
                KordiBirdCanvas(size: size, pose: pose)
            } else if flying && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1 / 60)) { timeline in
                    KordiBirdCanvas(size: size, pose: .flight(KordiBirdFlightMotion.sample(
                        elapsed: timeline.date.timeIntervalSince(animationEpoch)
                    )))
                }
            } else {
                KordiBirdCanvas(size: size, pose: .still)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

enum KordiBirdPose: Equatable {
    case still
    case flight(KordiBirdFlightSample)
}

/// Draws into a canvas larger than the mark so the raised wing and the swoop
/// are never clipped; layout still uses the mark's own size.
private struct KordiBirdCanvas: View {
    static let overflow: CGFloat = 0.25

    let size: CGFloat
    let pose: KordiBirdPose

    var body: some View {
        let canvasSide = size * (1 + (Self.overflow * 2))
        Canvas { context, _ in
            context.translateBy(x: size * Self.overflow, y: size * Self.overflow)
            KordiBirdDrawing.draw(pose: pose, in: &context, side: size)
        }
        .frame(width: canvasSide, height: canvasSide)
        .frame(width: size, height: size)
        .allowsHitTesting(false)
    }
}

private enum KordiBirdDrawing {
    static let ink = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xF4 / 255, green: 0xED / 255, blue: 0xE1 / 255, alpha: 1)
            : UIColor(red: 0x1F / 255, green: 0x1A / 255, blue: 0x17 / 255, alpha: 1)
    })
    static let beakColor = Color(red: 0xF7 / 255, green: 0xB3 / 255, blue: 0x2B / 255)

    /// Places the bird optically centred in the 512-unit box.
    private static let placement = CGAffineTransform(translationX: -270, y: -292)
        .concatenating(CGAffineTransform(scaleX: 0.94, y: 0.94))
        .concatenating(CGAffineTransform(translationX: 256, y: 250))
    private static let bodyCenter = CGPoint(x: 256, y: 250)
    private static let wingRoot = CGPoint(x: 296, y: 262)

    static func draw(pose: KordiBirdPose, in context: inout GraphicsContext, side: CGFloat) {
        context.scaleBy(x: side / 512, y: side / 512)

        if case let .flight(sample) = pose {
            context.translateBy(x: bodyCenter.x + sample.bodyOffsetX, y: bodyCenter.y + sample.bodyOffsetY)
            context.rotate(by: .degrees(sample.bodyRotation))
            context.translateBy(x: -bodyCenter.x, y: -bodyCenter.y)
        }

        let beak = beakPath.applying(placement)
        context.fill(beak, with: .color(beakColor))
        context.stroke(beak, with: .color(beakColor), style: StrokeStyle(lineWidth: 12, lineJoin: .round))

        let tail = tailPath.applying(placement)
        context.fill(bodyPath.applying(placement), with: .color(ink))
        context.fill(tail, with: .color(ink))
        context.stroke(tail, with: .color(ink), style: StrokeStyle(lineWidth: 4, lineJoin: .round))

        var cut = context
        cut.blendMode = .destinationOut
        cut.fill(eyePath.applying(placement), with: .color(.black))

        switch pose {
        case .still:
            cut.fill(staticWingPath.applying(placement), with: .color(.black))
        case let .flight(sample):
            let wingTransform = CGAffineTransform(rotationAngle: sample.wingAngle * .pi / 180)
                .concatenating(CGAffineTransform(translationX: wingRoot.x, y: wingRoot.y))
                .concatenating(placement)
            let wing = flightWingPath.applying(wingTransform)
            cut.stroke(wing, with: .color(.black), style: StrokeStyle(lineWidth: 14, lineJoin: .round))
            context.fill(wing, with: .color(ink))
        }
    }

    private static let bodyPath = Path(ellipseIn: CGRect(x: 262 - 150, y: 292 - 136, width: 300, height: 272))

    private static let tailPath = Path { path in
        path.move(to: CGPoint(x: 400, y: 342))
        path.addCurve(to: CGPoint(x: 470, y: 204), control1: CGPoint(x: 436, y: 322), control2: CGPoint(x: 462, y: 272))
        path.addCurve(to: CGPoint(x: 386, y: 218), control1: CGPoint(x: 448, y: 236), control2: CGPoint(x: 420, y: 244))
        path.closeSubpath()
    }

    private static let eyePath = Path(ellipseIn: CGRect(x: 194 - 17, y: 266 - 17, width: 34, height: 34))

    private static let beakPath = Path { path in
        path.move(to: CGPoint(x: 120, y: 276))
        path.addLine(to: CGPoint(x: 82, y: 294))
        path.addLine(to: CGPoint(x: 120, y: 312))
        path.closeSubpath()
    }

    private static let staticWingPath = Path { path in
        path.move(to: CGPoint(x: 248, y: 326))
        path.addCurve(to: CGPoint(x: 408, y: 266), control1: CGPoint(x: 276, y: 284), control2: CGPoint(x: 346, y: 262))
        path.addCurve(to: CGPoint(x: 272, y: 354), control1: CGPoint(x: 388, y: 316), control2: CGPoint(x: 332, y: 356))
        path.addCurve(to: CGPoint(x: 248, y: 326), control1: CGPoint(x: 252, y: 352), control2: CGPoint(x: 242, y: 340))
        path.closeSubpath()
    }
    .applying(
        CGAffineTransform(translationX: -326, y: -312)
            .concatenating(CGAffineTransform(scaleX: 0.8, y: 0.8))
            .concatenating(CGAffineTransform(translationX: 332, y: 322))
    )

    /// Leaf with its root at the origin, pointing right.
    private static let flightWingPath = Path { path in
        path.move(to: .zero)
        path.addCurve(to: CGPoint(x: 165, y: 0), control1: CGPoint(x: 40, y: -34), control2: CGPoint(x: 120, y: -36))
        path.addCurve(to: .zero, control1: CGPoint(x: 120, y: 30), control2: CGPoint(x: 40, y: 30))
        path.closeSubpath()
    }
}
