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

// Pixel offsets are bookkeeping, not inputs to transcript rendering.
final class ConversationScrollPosition {
    var contentOffsetY: CGFloat?
}

struct ConversationScrollGeometrySnapshot: Equatable {
    let isAtLatest: Bool
    let contentOffsetY: CGFloat
    let minimumOffsetY: CGFloat
    let maximumOffsetY: CGFloat
    let isValid: Bool
    func matchesInitialOffset(_ viewport: ConversationInitialViewport) -> Bool {
        guard case let .offset(offset) = viewport else { return false }
        let target = min(maximumOffsetY, max(minimumOffsetY, offset))
        return abs(contentOffsetY - target) <= 2
    }
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
