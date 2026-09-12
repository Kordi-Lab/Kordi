import SwiftUI

enum ConversationTimelineVirtualization {
    // iOS 26 can continuously relayout LazyVStack during accessibility reads.
    // Retain lightweight row slots, but construct content only near the viewport.
    static var usesCompatibilityLayout: Bool {
        if #available(iOS 27, *) { return false }
        if #available(iOS 26, *) { return true }
        return false
    }
}

struct ConversationTimelineStack<Content: View>: View {
    var usesCompatibilityLayout = ConversationTimelineVirtualization.usesCompatibilityLayout
    @ViewBuilder var content: () -> Content

    var body: some View {
        if usesCompatibilityLayout {
            VStack(spacing: 0, content: content)
        } else {
            LazyVStack(spacing: 0, content: content)
        }
    }
}

/// A slot keeps its measured height after evicting the message view. Scroll IDs
/// belong to the slot so distant targets can be reached before materialization.
struct ConversationTimelineRowSlot<Content: View>: View {
    let viewportFrame: CGRect
    var isRetained = false
    var usesCompatibilityLayout = ConversationTimelineVirtualization.usesCompatibilityLayout
    @ViewBuilder var content: () -> Content

    @State private var isNearViewport = false
    @State private var measuredHeight: CGFloat = 120

    var body: some View {
        if usesCompatibilityLayout {
            Group {
                if isRetained || isNearViewport {
                    content()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                            guard height.isFinite, height > 0,
                                  abs(measuredHeight - height) > 0.5 else { return }
                            measuredHeight = height
                        }
                } else {
                    Color.clear.frame(height: measuredHeight).accessibilityHidden(true)
                }
            }
            .onGeometryChange(for: Bool.self) { [viewportFrame, isRetained, isNearViewport] geometry in
                let frame = geometry.frame(in: .global)
                // Retain a little beyond the entry boundary so subpixel height
                // refinements cannot repeatedly mount and evict the same row.
                let overscan = viewportFrame.height + (isNearViewport ? 64 : 0)
                // A horizontal navigation transition must not evict the reading
                // anchor before the conversation records its departure position.
                return isRetained || (!viewportFrame.isEmpty
                    && frame.maxY >= viewportFrame.minY - overscan
                    && frame.minY <= viewportFrame.maxY + overscan)
            } action: { isNear in
                if isNearViewport != isNear { isNearViewport = isNear }
            }
        } else {
            content()
        }
    }
}
