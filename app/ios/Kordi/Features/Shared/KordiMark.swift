import SwiftUI

struct KordiColorRelaySample: Equatable {
    let scale: CGFloat
    let opacity: Double
}

enum KordiColorRelayMotion {
    static let cycleDuration: TimeInterval = 1.65
    static let handoffDuration: TimeInterval = 0.24
    private static let phaseDelay = 0.75

    static func sample(index: Int, elapsed: TimeInterval) -> KordiColorRelaySample {
        let safeIndex = min(max(index, 0), 2)
        let safeElapsed = max(0, elapsed)
        let relayElapsed = max(0, safeElapsed - handoffDuration)
        let phase = (relayElapsed * .pi * 2 / cycleDuration)
            - (Double(safeIndex) * phaseDelay)
        let pulse = max(0, sin(phase))
        let targetScale = 0.92 + (CGFloat(pulse) * 0.2)
        let targetOpacity = 0.78 + (pulse * 0.22)
        let progress = min(safeElapsed / handoffDuration, 1)
        let easedProgress = progress * progress * (3 - (2 * progress))
        return KordiColorRelaySample(
            scale: 1 + ((targetScale - 1) * CGFloat(easedProgress)),
            opacity: 1 + ((targetOpacity - 1) * easedProgress)
        )
    }
}

struct KordiMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var size: CGFloat = 44
    var colorRelay = false
    @State private var animationEpoch = Date()

    @ViewBuilder
    var body: some View {
        if colorRelay && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1 / 60)) { timeline in
                mark(elapsed: max(0, timeline.date.timeIntervalSince(animationEpoch)))
            }
        } else {
            mark(elapsed: nil)
        }
    }

    private func mark(elapsed: TimeInterval?) -> some View {
        ZStack {
            markCircle(
                color: KordiTheme.brandPink,
                baseOpacity: 0.94,
                index: 0,
                offset: CGSize(width: 0, height: -size * 0.15),
                elapsed: elapsed
            )
            markCircle(
                color: KordiTheme.brandCyan,
                baseOpacity: 0.94,
                index: 1,
                offset: CGSize(width: -size * 0.17, height: size * 0.15),
                elapsed: elapsed
            )
            markCircle(
                color: KordiTheme.brandAmber,
                baseOpacity: 0.92,
                index: 2,
                offset: CGSize(width: size * 0.17, height: size * 0.15),
                elapsed: elapsed
            )
        }
        .frame(width: size, height: size)
        .compositingGroup()
        .accessibilityHidden(true)
    }

    private func markCircle(
        color: Color,
        baseOpacity: Double,
        index: Int,
        offset: CGSize,
        elapsed: TimeInterval?
    ) -> some View {
        let sample = elapsed.map { KordiColorRelayMotion.sample(index: index, elapsed: $0) }
            ?? KordiColorRelaySample(scale: 1, opacity: 1)
        return Circle()
            .fill(color.opacity(baseOpacity * sample.opacity))
            .frame(width: size * 0.58, height: size * 0.58)
            .scaleEffect(sample.scale)
            .offset(offset)
    }
}
