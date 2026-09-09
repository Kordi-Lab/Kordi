import SwiftUI

struct ConversationOutgoingAvatarAnchor {
    let bounds: Anchor<CGRect>
    let name: String
    let source: String?
    let seed: String
    let isPositionPending: Bool
}

struct ConversationOutgoingAvatarPreference: PreferenceKey {
    static var defaultValue: [String: ConversationOutgoingAvatarAnchor] { [:] }

    static func reduce(value: inout [String: ConversationOutgoingAvatarAnchor], nextValue: () -> [String: ConversationOutgoingAvatarAnchor]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

struct ConversationOutgoingAvatarPlacement: Identifiable, Equatable {
    let id: String
    let frame: CGRect
    let name: String
    let source: String?
    let seed: String
    let isPositionPending: Bool
}

struct ConversationOutgoingAvatarOverlay: ViewModifier {
    func body(content: Content) -> some View {
        content.overlayPreferenceValue(ConversationOutgoingAvatarPreference.self) { anchors in
            GeometryReader { geometry in
                ConversationOutgoingAvatars(placements: anchors.map { id, anchor in
                    ConversationOutgoingAvatarPlacement(
                        id: id, frame: geometry[anchor.bounds],
                        name: anchor.name, source: anchor.source, seed: anchor.seed,
                        isPositionPending: anchor.isPositionPending
                    )
                })
            }
            .allowsHitTesting(false)
            .clipped()
        }
    }
}

/// A group's avatar outlives its last message row and the send-positioning gate.
struct ConversationOutgoingAvatars: View {
    let placements: [ConversationOutgoingAvatarPlacement]

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(placements) { placement in
                ConversationOutgoingAvatar(placement: placement)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}

private struct ConversationOutgoingAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let placement: ConversationOutgoingAvatarPlacement
    @State private var settledFrame: CGRect?

    var body: some View {
        let frame = placement.isPositionPending ? settledFrame : placement.frame
        IdentityAvatar(name: placement.name, imageSource: placement.source, kind: .person,
                       size: 28, seed: placement.seed)
            #if DEBUG
            .background {
                if ConversationMotionProbeRegistry.enabled {
                    ConversationMotionProbe(id: "avatar-" + placement.id)
                }
            }
            #endif
            .position(x: (frame ?? placement.frame).midX, y: (frame ?? placement.frame).midY)
            .opacity(frame == nil ? 0 : 1)
            .animation(
                reduceMotion ? nil : .timingCurve(0.23, 1, 0.32, 1, duration: 0.22),
                value: placement.isPositionPending
            )
            .onChange(of: placement, initial: true) { _, value in
                if !value.isPositionPending { settledFrame = value.frame }
            }
    }
}

/// Emit layout anchors outside the equatable bubble so lazy row reuse refreshes them.
struct ConversationOutgoingAvatarAnchorView: View {
    let groupID: String
    let name: String
    let source: String?
    let seed: String
    let isPositionPending: Bool

    var body: some View {
        Color.clear
            .frame(width: 28, height: 28)
            .anchorPreference(key: ConversationOutgoingAvatarPreference.self, value: .bounds) { bounds in
                [groupID: ConversationOutgoingAvatarAnchor(
                    bounds: bounds, name: name, source: source, seed: seed,
                    isPositionPending: isPositionPending
                )]
            }
    }
}
