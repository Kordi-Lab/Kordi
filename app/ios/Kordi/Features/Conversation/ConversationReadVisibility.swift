import SwiftUI

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
    let viewportFrame: CGRect
    let update: (Bool) -> Void

    func body(content: Content) -> some View {
        content.onGeometryChange(for: String?.self) { [messageID, isLatest, isEnabled, viewportFrame] geometry in
            guard isEnabled, isLatest else { return nil }
            let frame = geometry.frame(in: .global)
            let intersection = frame.intersection(viewportFrame)
            return frame.height > 0 && !intersection.isNull
                && intersection.height >= frame.height * 0.5 ? messageID : nil
        } action: { visibleID in
            update(visibleID != nil)
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
    var isAtTop: Bool { contentOffsetY <= minimumOffsetY + 2 }
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
    let isAnchor: Bool
    let viewportFrame: CGRect
    let isAtTop: Bool
    let isAtBottom: Bool
    let positioned: () -> Void

    func body(content: Content) -> some View {
        content.onGeometryChange(for: Bool.self) { [isAnchor, viewportFrame, isAtTop, isAtBottom] geometry in
            guard isAnchor else { return false }
            let frame = geometry.frame(in: .global)
            guard frame.intersects(viewportFrame) else { return false }
            let delta = frame.midY - viewportFrame.midY
            return abs(delta) <= 16 || (delta < 0 && isAtTop) || (delta > 0 && isAtBottom)
        } action: { restored in
            if restored { positioned() }
        }
    }
}
