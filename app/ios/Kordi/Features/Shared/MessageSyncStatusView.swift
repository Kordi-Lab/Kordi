import SwiftUI

enum ChatPullRefreshVisualState: Equatable {
    case idle
    case pulling(progress: CGFloat)
    case refreshing
}

enum KordiSyncMarkMotion: Equatable {
    case idle
    case pulling(progress: CGFloat)
    case refreshing
    case syncing
    case offline

    var runsContinuously: Bool {
        self == .refreshing || self == .syncing
    }
}

enum MessageSyncStatusBehavior {
    static func motion(
        pullState: ChatPullRefreshVisualState,
        messageSyncState: MessageSyncState,
        isLoadingMessages: Bool
    ) -> KordiSyncMarkMotion {
        switch pullState {
        case .refreshing:
            return .refreshing
        case let .pulling(progress):
            return .pulling(progress: progress)
        case .idle:
            if isLoadingMessages { return .syncing }
            switch messageSyncState {
            case .syncing: return .syncing
            case .upToDate: return .idle
            case .offline: return .offline
            }
        }
    }
}

struct KordiSyncMarkSample: Equatable {
    let offset: CGSize
    let scale: CGFloat
}

enum KordiSyncMarkGeometry {
    static let ballDiameter: CGFloat = 8
    static let ballSpacing: CGFloat = 10
    static let expandedBallSpacing: CGFloat = 16
    static let refreshBounceDelay: TimeInterval = 0.22

    static func pullProgress(for distance: CGFloat, triggerDistance: CGFloat) -> CGFloat {
        guard triggerDistance > 0 else { return 0 }
        return min(max(distance / triggerDistance, 0), 1)
    }

    static func sample(
        index: Int,
        motion: KordiSyncMarkMotion,
        elapsed: TimeInterval
    ) -> KordiSyncMarkSample {
        let safeIndex = min(max(index, 0), 2)

        switch motion {
        case .idle, .offline:
            return lineSample(index: safeIndex, angle: 0, spacing: ballSpacing)
        case let .pulling(progress):
            let clampedProgress = min(max(progress, 0), 1)
            let spacing = ballSpacing
                + ((expandedBallSpacing - ballSpacing) * clampedProgress)
            return lineSample(
                index: safeIndex,
                angle: (.pi / 2) * clampedProgress,
                spacing: spacing
            )
        case .refreshing:
            return bounceSample(
                index: safeIndex,
                elapsed: max(0, elapsed - refreshBounceDelay)
            )
        case .syncing:
            return bounceSample(index: safeIndex, elapsed: elapsed)
        }
    }

    private static func bounceSample(index: Int, elapsed: TimeInterval) -> KordiSyncMarkSample {
        let phase = (elapsed * .pi * 2 / 0.96) - (Double(index) * 0.72)
        let lift = CGFloat(max(0, sin(phase))) * 3.6
        let base = lineSample(index: index, angle: 0, spacing: ballSpacing)
        return KordiSyncMarkSample(
            offset: CGSize(width: base.offset.width, height: base.offset.height - lift),
            scale: 1 + (lift / 36)
        )
    }

    private static func lineSample(
        index: Int,
        angle: CGFloat,
        spacing: CGFloat
    ) -> KordiSyncMarkSample {
        let distance = CGFloat(index - 1) * spacing
        return KordiSyncMarkSample(
            offset: CGSize(width: cos(angle) * distance, height: sin(angle) * distance),
            scale: 1
        )
    }
}

struct MessageSyncStatusView: View {
    @EnvironmentObject private var model: AppModel
    let pullState: ChatPullRefreshVisualState

    init(pullState: ChatPullRefreshVisualState = .idle) {
        self.pullState = pullState
    }

    var body: some View {
        KordiAnimatedSyncMark(motion: motion)
            .frame(width: 52, height: 44)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
    }

    private var motion: KordiSyncMarkMotion {
        MessageSyncStatusBehavior.motion(
            pullState: pullState,
            messageSyncState: model.messageSyncState,
            isLoadingMessages: isLoadingMessages
        )
    }

    private var accessibilityLabel: String {
        switch pullState {
        case .refreshing: return "Refreshing messages"
        case let .pulling(progress):
            return progress >= 1 ? "Release to refresh messages" : "Pull to refresh messages"
        case .idle:
            if isLoadingMessages { return "Syncing messages" }
            switch model.messageSyncState {
            case .syncing: return "Syncing messages"
            case .upToDate:
                if let date = model.lastMessageSyncAt {
                    return "Messages up to date as of \(date.formatted(date: .omitted, time: .shortened))"
                }
                return "Messages up to date"
            case .offline: return "Message sync offline"
            }
        }
    }

    private var isLoadingMessages: Bool {
        !model.loadingConversationIDs.isEmpty
    }
}

private struct KordiAnimatedSyncMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    let motion: KordiSyncMarkMotion
    @State private var animationEpoch = Date()

    private var colors: [Color] {
        if colorScheme == .dark {
            return [
                Color(uiColor: .systemGray),
                Color(uiColor: .systemGray3),
                Color(uiColor: .white)
            ]
        }
        return [KordiTheme.brandPink, KordiTheme.brandCyan, KordiTheme.brandAmber]
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: !shouldRunTimeline)) { timeline in
            let elapsed = max(0, timeline.date.timeIntervalSince(animationEpoch))

            ZStack {
                ForEach(0..<3, id: \.self) { index in
                    let sample = KordiSyncMarkGeometry.sample(
                        index: index,
                        motion: renderedMotion,
                        elapsed: elapsed
                    )
                    Circle()
                        .fill(colors[index].opacity(0.96))
                        .frame(
                            width: KordiSyncMarkGeometry.ballDiameter,
                            height: KordiSyncMarkGeometry.ballDiameter
                        )
                        .scaleEffect(sample.scale)
                        .offset(sample.offset)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: 38, height: 34)
            .opacity(motion == .offline ? 0.42 : 1)
        }
        .onChange(of: motion) { oldMotion, newMotion in
            if newMotion.runsContinuously && !oldMotion.runsContinuously {
                animationEpoch = Date()
            } else if newMotion == .refreshing && oldMotion != .refreshing {
                animationEpoch = Date()
            } else if newMotion == .syncing && oldMotion != .syncing {
                animationEpoch = Date()
            }
        }
        .animation(.smooth(duration: 0.24), value: transitionKey)
    }

    private var renderedMotion: KordiSyncMarkMotion {
        guard reduceMotion else { return motion }
        switch motion {
        case .refreshing, .syncing: return .idle
        default: return motion
        }
    }

    private var shouldRunTimeline: Bool {
        !reduceMotion && motion.runsContinuously
    }

    private var transitionKey: String {
        switch motion {
        case .idle: "idle"
        case .pulling: "pulling"
        case .refreshing: "refreshing"
        case .syncing: "syncing"
        case .offline: "offline"
        }
    }
}
