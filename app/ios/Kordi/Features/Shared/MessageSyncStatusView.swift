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

enum KordiSyncMarkGeometry {
    static let birdSize: CGFloat = 40

    static func pullProgress(for distance: CGFloat, triggerDistance: CGFloat) -> CGFloat {
        guard triggerDistance > 0 else { return 0 }
        return min(max(distance / triggerDistance, 0), 1)
    }

    /// Bird pose for a sync state: flying while syncing, the wing lifting with the pull,
    /// and the still icon pose otherwise or when motion is reduced.
    static func pose(
        motion: KordiSyncMarkMotion,
        elapsed: TimeInterval,
        reduceMotion: Bool
    ) -> KordiBirdPose {
        switch motion {
        case .idle, .offline:
            return .still
        case let .pulling(progress):
            return .flight(.holding(wingAngle: KordiBirdFlightMotion.wingAngle(progress: Double(progress))))
        case .refreshing, .syncing:
            return reduceMotion ? .still : .flight(KordiBirdFlightMotion.sample(elapsed: elapsed))
        }
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
            if isLoadingMessages { return "Syncing" }
            switch model.messageSyncState {
            case .syncing: return "Syncing"
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
    let motion: KordiSyncMarkMotion
    @State private var animationEpoch = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: !shouldRunTimeline)) { timeline in
            KordiMark(
                size: KordiSyncMarkGeometry.birdSize,
                pose: KordiSyncMarkGeometry.pose(
                    motion: motion,
                    elapsed: max(0, timeline.date.timeIntervalSince(animationEpoch)),
                    reduceMotion: reduceMotion
                )
            )
            .frame(width: 48, height: 40)
            .opacity(motion == .offline ? 0.42 : 1)
        }
        .onChange(of: motion) { oldMotion, newMotion in
            if newMotion.runsContinuously && oldMotion != newMotion {
                animationEpoch = Date()
            }
        }
        .animation(.smooth(duration: 0.24), value: motion == .offline)
    }

    private var shouldRunTimeline: Bool {
        !reduceMotion && motion.runsContinuously
    }
}
