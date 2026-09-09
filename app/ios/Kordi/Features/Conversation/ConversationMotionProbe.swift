#if DEBUG
import SwiftUI
import UIKit

/// Opt-in geometry probes for synthetic, hosted conversation tests only.
@MainActor
enum ConversationMotionProbeRegistry {
    final class WeakView {
        weak var value: UIView?
        init(_ value: UIView) { self.value = value }
    }
    static var enabled = false
    static var setDraft: ((String) -> Void)?
    static var send: (() -> Void)?
    static var views: [String: WeakView] = [:]

    static func frame(for id: String, in window: UIWindow) -> CGRect? {
        guard let view = views[id]?.value, view.window === window else { return nil }
        guard let layer = view.layer.presentation(), let root = window.layer.presentation(),
              !layer.bounds.isEmpty else { return nil }
        var ancestor: CALayer? = layer
        while let current = ancestor {
            if current.isHidden || current.opacity <= 0.01 { return nil }
            ancestor = current.superlayer
        }
        return layer.convert(layer.bounds, to: root)
    }
}

struct ConversationMotionProbe: UIViewRepresentable {
    let id: String
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        ConversationMotionProbeRegistry.views[id] = .init(view)
    }
}
#endif
