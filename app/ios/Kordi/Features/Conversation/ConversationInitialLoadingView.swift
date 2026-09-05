import SwiftUI

struct ConversationInitialPlaceholder: Identifiable, Equatable {
    enum Kind: Equatable {
        case message
        case link
        case image
        case agent
        case system
    }

    enum Width: Equatable {
        case short
        case medium
        case long

        var points: CGFloat {
            switch self {
            case .short: 140
            case .medium: 210
            case .long: 270
            }
        }
    }

    let id: String
    let author: MessageAuthor
    let kind: Kind
    let lineCount: Int
    let width: Width
    let presentation: ConversationMessagePresentation
}

enum ConversationInitialPlaceholderCatalog {
    static let limit = 8

    static func make(from messages: [ChatMessage]) -> [ConversationInitialPlaceholder] {
        guard !messages.isEmpty else { return [] }
        let presentations = ConversationTimelinePresentation.make(
            messages: messages,
            selfAccountId: nil,
            participants: []
        )
        let start = max(messages.startIndex, messages.endIndex - limit)
        return messages.indices.suffix(from: start).map { index in
            let message = messages[index]
            let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let length = text.count
            let imageOnly = text.isEmpty
                && !message.attachments.isEmpty
                && message.attachments.allSatisfy { $0.kind == .image }
            let kind: ConversationInitialPlaceholder.Kind
            if message.isSystemNotice {
                kind = .system
            } else if imageOnly {
                kind = .image
            } else if message.author == .agent {
                kind = .agent
            } else if text.range(
                of: #"(?:https?://|www\.)\S+"#,
                options: .regularExpression
            ) != nil {
                kind = .link
            } else {
                kind = .message
            }
            return ConversationInitialPlaceholder(
                id: message.id,
                author: message.author,
                kind: kind,
                lineCount: length <= 34 ? 1 : length <= 88 ? 2 : 3,
                width: length <= 18 ? .short : length <= 54 ? .medium : .long,
                presentation: presentations[index]
            )
        }
    }
}

struct ConversationInitialLoadingView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.kordiChatTheme) private var chatTheme

    private let placeholders: [ConversationInitialPlaceholder]

    init(messages: [ChatMessage]) {
        placeholders = ConversationInitialPlaceholderCatalog.make(from: messages)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            KordiChatWallpaper(theme: chatTheme)
            if placeholders.isEmpty {
                ProgressView("Loading conversation…")
                    .controlSize(.large)
                    .foregroundStyle(.secondary)
            } else {
                TimelineView(
                    .animation(
                        minimumInterval: 1 / 30,
                        paused: reduceMotion
                    )
                ) { timeline in
                    let phase = reduceMotion
                        ? CGFloat(0.5)
                        : CGFloat(
                            timeline.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: 1.45) / 1.45
                        )
                    VStack(spacing: 0) {
                        ForEach(placeholders) { placeholder in
                            ConversationInitialPlaceholderRow(
                                placeholder: placeholder,
                                phase: phase
                            )
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 14)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
    }
}

private struct ConversationInitialPlaceholderRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let placeholder: ConversationInitialPlaceholder
    let phase: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            if placeholder.presentation.showsTimestamp {
                ConversationLoadingSurface(shape: Capsule(), phase: phase)
                    .frame(width: 72, height: 8)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
                    .padding(.bottom, 5)
            }

            if placeholder.kind == .system {
                ConversationLoadingSurface(shape: Capsule(), phase: phase)
                    .frame(width: 150, height: 10)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            } else {
                messageRow
                    .padding(.top, placeholder.presentation.groupedWithPrevious ? 2 : 7)
                    .padding(.bottom, placeholder.presentation.groupedWithNext ? 0 : 2)
            }
        }
    }

    private var messageRow: some View {
        HStack(alignment: placeholder.kind == .image ? .top : .bottom, spacing: 8) {
            if placeholder.author != .agent, placeholder.author != .me {
                avatarSlot
            }

            if placeholder.author == .me {
                Spacer(minLength: 34)
            }

            VStack(
                alignment: placeholder.author == .me ? .trailing : .leading,
                spacing: 4
            ) {
                if placeholder.kind == .agent {
                    ConversationLoadingSurface(shape: Capsule(), phase: phase)
                        .frame(width: 82, height: 8)
                        .padding(.horizontal, 4)
                }
                messageSurface
            }

            if placeholder.author == .me {
                ownAvatarSlot
            } else {
                Spacer(minLength: 34)
            }
        }
    }

    @ViewBuilder
    private var messageSurface: some View {
        if placeholder.kind == .image {
            ConversationLoadingSurface(
                shape: RoundedRectangle(cornerRadius: 12, style: .continuous),
                phase: phase
            )
            .frame(width: 244, height: 154)
        } else {
            ZStack(alignment: .leading) {
                bubbleShape
                    .fill(bubbleColor)
                HStack(spacing: 7) {
                    if placeholder.kind == .link {
                        ConversationLoadingSurface(
                            shape: RoundedRectangle(cornerRadius: 3, style: .continuous),
                            phase: phase
                        )
                        .frame(width: 14, height: 14)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(0..<placeholder.lineCount, id: \.self) { index in
                            ConversationLoadingSurface(shape: Capsule(), phase: phase)
                                .frame(
                                    width: lineWidth(index: index),
                                    height: 10
                                )
                        }
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, placeholder.author == .me ? 30 : 12)
                .padding(.vertical, 8)
            }
            .frame(width: placeholder.width.points)
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    private var avatarSlot: some View {
        Color.clear
            .frame(
                width: 44,
                height: placeholder.presentation.showsAvatar ? 44 : 28
            )
            .overlay(alignment: placeholder.kind == .image ? .top : .bottom) {
                if placeholder.presentation.showsAvatar {
                    ConversationLoadingSurface(shape: Circle(), phase: phase)
                        .frame(width: 28, height: 28)
                }
            }
            .padding(.bottom, 2)
    }

    private var ownAvatarSlot: some View {
        Group {
            if placeholder.presentation.showsAvatar {
                ConversationLoadingSurface(shape: Circle(), phase: phase)
                    .frame(width: 28, height: 28)
            } else {
                Color.clear.frame(width: 28, height: 28)
            }
        }
        .padding(.bottom, 2)
    }

    private var bubbleShape: UnevenRoundedRectangle {
        if placeholder.author == .me {
            UnevenRoundedRectangle(
                topLeadingRadius: 12,
                bottomLeadingRadius: 12,
                bottomTrailingRadius: 4,
                topTrailingRadius: 12,
                style: .continuous
            )
        } else {
            UnevenRoundedRectangle(
                topLeadingRadius: 12,
                bottomLeadingRadius: 4,
                bottomTrailingRadius: 12,
                topTrailingRadius: 12,
                style: .continuous
            )
        }
    }

    private var bubbleColor: Color {
        switch placeholder.author {
        case .me: chatTheme.ownBubble
        case .agent: chatTheme.agentBubble
        case .person: chatTheme.peerBubble
        }
    }

    private func lineWidth(index: Int) -> CGFloat {
        let available = placeholder.width.points
            - 24
            - (placeholder.author == .me ? 18 : 0)
            - (placeholder.kind == .link ? 21 : 0)
        return index == placeholder.lineCount - 1 && placeholder.lineCount > 1
            ? max(56, available * 0.44)
            : available
    }
}

private struct ConversationLoadingSurface<LoadingShape: Shape>: View {
    let shape: LoadingShape
    let phase: CGFloat

    var body: some View {
        shape
            .fill(Color.secondary.opacity(0.16))
            .overlay {
                GeometryReader { geometry in
                    LinearGradient(
                        colors: [
                            .clear,
                            Color.white.opacity(0.24),
                            .clear,
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: max(32, geometry.size.width * 0.52))
                    .offset(
                        x: -geometry.size.width
                            + phase * geometry.size.width * 2.1
                    )
                }
            }
            .clipShape(shape)
            .accessibilityHidden(true)
    }
}
