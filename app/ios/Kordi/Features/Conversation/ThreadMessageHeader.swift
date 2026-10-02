import SwiftUI

struct ThreadMessageHeader: View {
    let message: ChatMessage
    let authorName: String
    let avatarSeed: String?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) { author; timestamp }
            VStack(alignment: .leading, spacing: 2) { author; timestamp }
        }
        .accessibilityElement(children: .combine)
    }

    private var author: some View {
        HStack(spacing: 5) {
            Text(authorName).font(.footnote.weight(.semibold))
            if KordiPipIdentity.matches(name: authorName, seed: avatarSeed) {
                Text(KordiPipIdentity.tag).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
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
