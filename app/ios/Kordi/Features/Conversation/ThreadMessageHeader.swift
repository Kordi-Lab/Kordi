import SwiftUI

struct ThreadMessageHeader: View {
    /// The mark after the author's name, matching the Chat layout: the "AI"
    /// chip on agent messages and PiP's tag on PiP's messages.
    enum Mark: Equatable {
        case ai
        case pip
    }

    let message: ChatMessage
    let authorName: String
    let avatarSeed: String?
    /// Opens "About this reply" from the mark, when the reply offers it.
    var onOpenReplyDisclosure: (() -> Void)? = nil

    static func mark(for message: ChatMessage, avatarSeed: String?) -> Mark? {
        if message.author == .agent { return .ai }
        return AgentMessageLabels.isPip(message, avatarSeed: avatarSeed) ? .pip : nil
    }

    private var mark: Mark? { Self.mark(for: message, avatarSeed: avatarSeed) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) { author; timestamp }
            VStack(alignment: .leading, spacing: 2) { author; timestamp }
        }
        // A mark stays its own element, so the chip or tag remains a button.
        .accessibilityElement(children: mark == nil ? .combine : .contain)
    }

    private var author: some View {
        HStack(spacing: 5) {
            Text(authorName).font(.footnote.weight(.semibold))
            switch mark {
            case .ai: AgentAIChip(action: onOpenReplyDisclosure)
            case .pip: PipIdentityTag(action: onOpenReplyDisclosure)
            case nil: EmptyView()
            }
            if let ownerName = message.senderOwnerName?.nonEmpty {
                Text("Owner · \(ownerName)").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var timestamp: some View {
        Text(message.createdAt, format: .dateTime.hour().minute())
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("thread-message-time-\(message.id)")
    }
}

struct ThreadQuoteConnector: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX + 5, y: rect.minY))
            path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.minY + 5),
                              control: CGPoint(x: rect.minX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        }
    }
}
