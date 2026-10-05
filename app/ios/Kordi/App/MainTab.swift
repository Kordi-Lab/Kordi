import Foundation
import SwiftUI
import UIKit

enum MainTab: String, CaseIterable, Identifiable {
    case contacts = "Contacts"
    case chats = "Chats"
    case agents = "Agent Chats"
    case digest = "Digest"
    case account = "Account"

    static let contentTabs: [MainTab] = [.contacts, .chats, .agents, .digest, .account]

    var id: Self { self }

    var symbol: String {
        switch self {
        case .contacts:
            "person.2"
        case .chats:
            "bubble.left.and.bubble.right"
        case .agents:
            "text.bubble"
        case .digest:
            "list.bullet.clipboard"
        case .account:
            "person"
        }
    }

    static func destination(for conversationKind: ConversationKind) -> MainTab {
        conversationKind == .agent ? .agents : .chats
    }
}

struct AgentChatTabLabel: View {
    var body: some View {
        Label {
            Text(MainTab.agents.rawValue)
        } icon: {
            Image(uiImage: AgentChatGlyph.image)
        }
    }
}

@MainActor
enum AgentChatGlyph {
    static let image: UIImage = {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 26, height: 26))
        return renderer.image { _ in
            let ink = UIColor.black
            ink.setStroke()
            ink.setFill()
            let bubble = UIBezierPath()
            bubble.move(to: CGPoint(x: 8, y: 3))
            bubble.addLine(to: CGPoint(x: 18, y: 3))
            bubble.addQuadCurve(to: CGPoint(x: 23, y: 8), controlPoint: CGPoint(x: 23, y: 3))
            bubble.addLine(to: CGPoint(x: 23, y: 15))
            bubble.addQuadCurve(to: CGPoint(x: 18, y: 20), controlPoint: CGPoint(x: 23, y: 20))
            bubble.addLine(to: CGPoint(x: 11, y: 20))
            bubble.addQuadCurve(to: CGPoint(x: 6, y: 23), controlPoint: CGPoint(x: 8, y: 22))
            bubble.addLine(to: CGPoint(x: 6, y: 19))
            bubble.addQuadCurve(to: CGPoint(x: 3, y: 15), controlPoint: CGPoint(x: 3, y: 18))
            bubble.addLine(to: CGPoint(x: 3, y: 8))
            bubble.addQuadCurve(to: CGPoint(x: 8, y: 3), controlPoint: CGPoint(x: 3, y: 3))
            bubble.lineWidth = 2
            bubble.lineCapStyle = .round
            bubble.lineJoinStyle = .round
            bubble.stroke()
            UIBezierPath(ovalIn: CGRect(x: 8, y: 9, width: 2.4, height: 3)).fill()
            UIBezierPath(ovalIn: CGRect(x: 16, y: 9, width: 2.4, height: 3)).fill()
            let smile = UIBezierPath()
            smile.move(to: CGPoint(x: 10, y: 15))
            smile.addQuadCurve(to: CGPoint(x: 16, y: 15), controlPoint: CGPoint(x: 13, y: 18))
            smile.lineWidth = 1.8
            smile.lineCapStyle = .round
            smile.stroke()
        }.withRenderingMode(.alwaysTemplate)
    }()
}
