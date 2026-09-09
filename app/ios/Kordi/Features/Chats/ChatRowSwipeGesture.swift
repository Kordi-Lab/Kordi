import SwiftUI
import UIKit

// Classify before recognition so a row can own horizontal movement without
// taking the List's vertical pan. This also handles indirect Mirroring input.
enum ChatRowSwipeDirection {
    static func isHorizontal(_ movement: CGPoint) -> Bool {
        abs(movement.x) > 0 && abs(movement.x) > abs(movement.y) * 1.25
    }
}

// A drag stays on the side it began on. Closing an open row must stop at
// neutral; revealing the opposite actions requires lifting and dragging again.
struct ChatRowSwipeSession {
    private let leading: Bool

    init?(restingOffset: CGFloat, firstTranslation: CGFloat) {
        let direction = restingOffset == 0 ? firstTranslation : restingOffset
        guard direction != 0 else { return nil }
        leading = direction > 0
    }

    func limitedOffset(_ offset: CGFloat, leadingWidth: CGFloat, trailingWidth: CGFloat) -> CGFloat {
        leading ? min(leadingWidth, max(0, offset)) : max(-trailingWidth, min(0, offset))
    }
}

@MainActor
final class ChatRowPanCoordinator: NSObject, UIGestureRecognizerDelegate {
    func makeRecognizer() -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.allowedScrollTypesMask = .all
        recognizer.delegate = self
        return recognizer
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
        let velocity = pan.velocity(in: pan.view)
        let movement = velocity == .zero ? pan.translation(in: pan.view) : velocity
        return ChatRowSwipeDirection.isHorizontal(movement)
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        // The scroll view waits for the row's direction decision. Vertical
        // movement fails the row recognizer immediately and proceeds normally.
        otherGestureRecognizer is UIPanGestureRecognizer
            && otherGestureRecognizer.view is UIScrollView
    }
}

@available(iOS 18.0, *)
private struct ChatRowDirectionalPan: UIGestureRecognizerRepresentable {
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat) -> Void
    let onCancelled: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> ChatRowPanCoordinator {
        ChatRowPanCoordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        context.coordinator.makeRecognizer()
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let translation = context.converter.localTranslation ?? recognizer.translation(in: recognizer.view)
        switch recognizer.state {
        case .began, .changed:
            onChanged(translation.x)
        case .ended:
            let velocity = context.converter.localVelocity ?? recognizer.velocity(in: recognizer.view)
            onEnded(translation.x + velocity.x * 0.2)
        case .cancelled, .failed:
            onCancelled()
        default:
            break
        }
    }
}

private struct ChatRowSwipeGestureModifier: ViewModifier {
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat) -> Void
    let onCancelled: () -> Void
    @GestureState private var legacyDragging = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(ChatRowDirectionalPan(
                onChanged: onChanged, onEnded: onEnded, onCancelled: onCancelled
            ))
        } else {
            content.simultaneousGesture(
                DragGesture(minimumDistance: 10)
                    .updating($legacyDragging) { _, dragging, _ in dragging = true }
                    .onChanged { value in
                        guard ChatRowSwipeDirection.isHorizontal(CGPoint(
                            x: value.translation.width, y: value.translation.height
                        )) else { return }
                        onChanged(value.translation.width)
                    }
                    .onEnded { value in
                        if ChatRowSwipeDirection.isHorizontal(CGPoint(
                            x: value.translation.width, y: value.translation.height
                        )) {
                            onEnded(value.predictedEndTranslation.width)
                        } else {
                            onCancelled()
                        }
                    }
            )
            .onChange(of: legacyDragging) {
                if !legacyDragging { onCancelled() }
            }
        }
    }
}

extension View {
    func chatRowSwipeGesture(
        onChanged: @escaping (CGFloat) -> Void,
        onEnded: @escaping (CGFloat) -> Void,
        onCancelled: @escaping () -> Void
    ) -> some View {
        modifier(ChatRowSwipeGestureModifier(
            onChanged: onChanged, onEnded: onEnded, onCancelled: onCancelled
        ))
    }
}
