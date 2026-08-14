import SwiftUI

struct DigestMessageRoute: Hashable {
    let conversation: ConversationSummary
    let messageID: String
}

struct DigestMessageReference: Identifiable, Hashable {
    let conversation: ConversationSummary
    let message: ChatMessage

    var id: String { "\(conversation.id):\(message.id)" }
    var route: DigestMessageRoute {
        DigestMessageRoute(conversation: conversation, messageID: message.id)
    }
    var excerpt: String {
        let plainText = message.text
            .replacingOccurrences(
                of: #"```[\s\S]*?```"#,
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"(?m)^\s*#{1,6}\s*"#,
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(of: "- [x]", with: "Completed:")
            .replacingOccurrences(of: "- [ ]", with: "Pending:")
            .replacingOccurrences(
                of: #"[*_`~]"#,
                with: "",
                options: .regularExpression
            )
        let collapsed = plainText
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        if collapsed.isEmpty {
            let attachmentCount = message.attachments.count
            return attachmentCount == 1
                ? "Shared an attachment"
                : "Shared \(attachmentCount) attachments"
        }
        guard collapsed.count > 118 else { return collapsed }
        return String(collapsed.prefix(117)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}

struct DigestInsight: Identifiable, Equatable {
    let id: String
    let text: String
    let detail: String?
    let references: [DigestMessageReference]
}

struct DigestSnapshot: Equatable {
    let unreadMessageCount: Int
    let conversationCount: Int
    let summarizedConversationCount: Int
    let messageCount: Int
    let summaryText: String
    let summaryReferences: [DigestMessageReference]
    let todoItems: [DigestInsight]
    let activeAgentItems: [DigestInsight]
    let attentionItems: [DigestInsight]

    var isEmpty: Bool { conversationCount == 0 }
    var activeAgentCount: Int { activeAgentItems.count }
    var failedSessionCount: Int { attentionItems.count }
}

enum DigestCatalog {
    static func snapshot(
        from conversations: [ConversationSummary],
        messagesByConversation: [String: [ChatMessage]]
    ) -> DigestSnapshot {
        let sorted = conversations.sorted {
            $0.lastActivityAt > $1.lastActivityAt || (
                $0.lastActivityAt == $1.lastActivityAt
                    && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            )
        }

        let referencesByConversation = Dictionary(uniqueKeysWithValues: sorted.map { conversation in
            let references = messagesByConversation[conversation.id, default: []]
                .filter(hasDigestContent)
                .sorted(by: messageSort)
                .map { DigestMessageReference(conversation: conversation, message: $0) }
            return (conversation.id, references)
        })
        let allReferences = referencesByConversation.values.flatMap { $0 }
        let summarizedConversationCount = referencesByConversation.values.filter { !$0.isEmpty }.count
        let latestReferences = sorted.compactMap { conversation in
            referencesByConversation[conversation.id]?.last
        }
        let summaryReferences = prioritizedSummaryReferences(latestReferences)

        let failedConversationIDs = Set(sorted.compactMap { conversation -> String? in
            let hasFailedMessage = referencesByConversation[conversation.id, default: []]
                .contains { $0.message.deliveryState == .failed }
            return conversation.agentActivity == .failed || hasFailedMessage ? conversation.id : nil
        })
        let todoItems = sorted.compactMap { conversation -> DigestInsight? in
            guard conversation.unreadCount > 0,
                  !failedConversationIDs.contains(conversation.id),
                  let reference = latestIncomingReference(
                    in: referencesByConversation[conversation.id, default: []]
                  ) else { return nil }
            let unreadDetail = conversation.unreadCount == 1
                ? "1 unread message"
                : "\(conversation.unreadCount) unread messages"
            return DigestInsight(
                id: "todo:\(reference.id)",
                text: reference.excerpt,
                detail: unreadDetail,
                references: [reference]
            )
        }
        let activeAgentItems = sorted.compactMap { conversation -> DigestInsight? in
            guard conversation.agentActivity == .replying,
                  !failedConversationIDs.contains(conversation.id),
                  let reference = referencesByConversation[conversation.id]?.last else { return nil }
            return DigestInsight(
                id: "active:\(reference.id)",
                text: reference.excerpt,
                detail: "Agent work is still in progress",
                references: [reference]
            )
        }
        let attentionItems = sorted.compactMap { conversation -> DigestInsight? in
            guard failedConversationIDs.contains(conversation.id),
                  let reference = referencesByConversation[conversation.id]?
                    .last(where: { $0.message.deliveryState == .failed })
                    ?? referencesByConversation[conversation.id]?.last else { return nil }
            return DigestInsight(
                id: "attention:\(reference.id)",
                text: reference.excerpt,
                detail: reference.message.errorMessage?.nonEmpty
                    ?? "This session needs review before it can continue.",
                references: [reference]
            )
        }

        return DigestSnapshot(
            unreadMessageCount: conversations.reduce(0) { $0 + $1.unreadCount },
            conversationCount: conversations.count,
            summarizedConversationCount: summarizedConversationCount,
            messageCount: allReferences.count,
            summaryText: summaryText(
                messageCount: allReferences.count,
                summarizedConversationCount: summarizedConversationCount,
                conversationCount: conversations.count
            ),
            summaryReferences: summaryReferences,
            todoItems: todoItems,
            activeAgentItems: activeAgentItems,
            attentionItems: attentionItems
        )
    }

    private static func hasDigestContent(_ message: ChatMessage) -> Bool {
        message.text.nonEmpty != nil || !message.attachments.isEmpty
    }

    private static func messageSort(_ lhs: ChatMessage, _ rhs: ChatMessage) -> Bool {
        lhs.createdAt < rhs.createdAt || (lhs.createdAt == rhs.createdAt && lhs.id < rhs.id)
    }

    private static func latestIncomingReference(
        in references: [DigestMessageReference]
    ) -> DigestMessageReference? {
        references.last(where: { $0.message.author != .me }) ?? references.last
    }

    private static func prioritizedSummaryReferences(
        _ latestReferences: [DigestMessageReference]
    ) -> [DigestMessageReference] {
        let sorted = latestReferences.sorted {
            let leftPriority = summaryPriority($0)
            let rightPriority = summaryPriority($1)
            if leftPriority != rightPriority { return leftPriority > rightPriority }
            if $0.message.createdAt != $1.message.createdAt {
                return $0.message.createdAt > $1.message.createdAt
            }
            return $0.id < $1.id
        }
        return Array(sorted.prefix(3))
    }

    private static func summaryPriority(_ reference: DigestMessageReference) -> Int {
        var priority = reference.conversation.unreadCount > 0 ? 100 : 0
        if reference.conversation.agentActivity == .failed
            || reference.message.deliveryState == .failed {
            priority += 50
        }
        if reference.conversation.agentActivity == .replying { priority += 25 }
        if reference.message.author != .me { priority += 10 }
        return priority
    }

    private static func summaryText(
        messageCount: Int,
        summarizedConversationCount: Int,
        conversationCount: Int
    ) -> String {
        guard conversationCount > 0 else {
            return "Your cross-session summary will appear when conversations begin."
        }
        guard messageCount > 0 else {
            return "No synced message content is available to summarize yet."
        }
        if summarizedConversationCount == conversationCount {
            let sessionLabel = conversationCount == 1 ? "session" : "sessions"
            return "Reviewed \(messageCount) messages across all \(conversationCount) \(sessionLabel). The most recent updates are highlighted below."
        }
        let missingCount = conversationCount - summarizedConversationCount
        let missingLabel = missingCount == 1 ? "session has" : "sessions have"
        return "Reviewed \(messageCount) messages across \(summarizedConversationCount) sessions. \(missingCount) \(missingLabel) no synced message content yet."
    }
}

struct DigestView: View {
    @EnvironmentObject private var model: AppModel

    private var digest: DigestSnapshot {
        DigestCatalog.snapshot(
            from: model.conversations,
            messagesByConversation: model.messagesByConversation
        )
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                DigestSummarySection(digest: digest)

                DigestTodoSection(digest: digest)

                DigestAnalysisSection(digest: digest)

                Divider()
                    .padding(.vertical, 2)

                DigestNeedsAttentionView(digest: digest)
            }
            .padding(.horizontal, 22)
            .padding(.top, 16)
            .padding(.bottom, 40)
        }
        .background(Color(uiColor: .systemBackground))
        .refreshable { await model.refreshWorkspace() }
        .navigationTitle("Digest")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: ConversationSummary.self) { conversation in
            ConversationView(conversation: conversation)
        }
        .navigationDestination(for: DigestMessageRoute.self) { route in
            ConversationView(
                conversation: route.conversation,
                initialMessageID: route.messageID
            )
        }
    }
}

private struct DigestSummarySection: View {
    let digest: DigestSnapshot

    var body: some View {
        DigestDocumentSection(title: "Summary") {
            DigestCallout(systemImage: "text.alignleft") {
                Text(digest.summaryText)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !digest.summaryReferences.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(digest.summaryReferences) { reference in
                        DigestSummaryHighlight(reference: reference)
                    }
                }
            }
        }
    }
}

private struct DigestTodoSection: View {
    let digest: DigestSnapshot

    var body: some View {
        DigestDocumentSection(title: "To-do") {
            if digest.todoItems.isEmpty {
                DigestChecklistBlock(
                    text: "Nothing pending",
                    detail: nil,
                    state: .complete,
                    references: []
                )
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(digest.todoItems) { item in
                        DigestChecklistBlock(
                            text: item.text,
                            detail: item.detail,
                            state: .pending,
                            references: item.references
                        )
                    }
                }
            }
        }
    }
}

private struct DigestAnalysisSection: View {
    let digest: DigestSnapshot

    var body: some View {
        DigestDocumentSection(title: "Analysis") {
            DigestCallout(systemImage: "sparkles") {
                Text(analysisText)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                if !digest.activeAgentItems.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(digest.activeAgentItems) { item in
                            DigestInsightBlock(item: item)
                        }
                    }
                }
            }
        }
    }

    private var analysisText: String {
        let conversationSummary = digest.summarizedConversationCount == 1
            ? "1 session contributed message content."
            : "\(digest.summarizedConversationCount) sessions contributed message content."
        let agentSummary: String
        if digest.activeAgentCount == 0 {
            agentSummary = "No agents are working right now."
        } else if digest.activeAgentCount == 1 {
            agentSummary = "1 agent is still working."
        } else {
            agentSummary = "\(digest.activeAgentCount) agents are still working."
        }
        return "\(conversationSummary) \(agentSummary)"
    }
}

private struct DigestNeedsAttentionView: View {
    let digest: DigestSnapshot

    var body: some View {
        DigestDocumentSection(title: "Needs attention") {
            if digest.attentionItems.isEmpty {
                DigestAttentionStatus(
                    systemImage: "checkmark.circle.fill",
                    title: "All clear",
                    detail: "No blocked chats need your attention.",
                    references: []
                )
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(digest.attentionItems) { item in
                        DigestAttentionStatus(
                            systemImage: "exclamationmark.circle.fill",
                            title: item.text,
                            detail: item.detail ?? "Open the source message to review the failure.",
                            references: item.references
                        )
                    }
                }
            }
        }
    }
}

private struct DigestDocumentSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(
        title: String,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(.primary)

            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

private enum DigestChecklistState {
    case pending
    case complete
}

private struct DigestChecklistBlock: View {
    let text: String
    let detail: String?
    let state: DigestChecklistState
    let references: [DigestMessageReference]

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: state == .complete ? "checkmark.square.fill" : "square")
                .font(.body.weight(.medium))
                .foregroundStyle(state == .complete ? Color.green : .secondary)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 9) {
                Text(text)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                if let detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if !references.isEmpty {
                    DigestMessageCitations(references: references)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(text)
    }
}

private struct DigestCallout<Content: View>: View {
    let systemImage: String
    @ViewBuilder let content: Content

    init(
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) {
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(KordiTheme.agentViolet)
                .frame(width: 20)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 10) {
                content
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: .secondarySystemBackground),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .accessibilityElement(children: .contain)
    }
}

private struct DigestAttentionStatus: View {
    let systemImage: String
    let title: String
    let detail: String
    let references: [DigestMessageReference]

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(references.isEmpty ? Color.green : Color.orange)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if !references.isEmpty {
                    DigestMessageCitations(references: references)
                        .padding(.top, 4)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct DigestSummaryHighlight: View {
    let reference: DigestMessageReference

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Circle()
                    .fill(Color(uiColor: .tertiaryLabel))
                    .frame(width: 5, height: 5)
                    .accessibilityHidden(true)

                Text(reference.excerpt)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            DigestMessageCitation(reference: reference)
                .padding(.leading, 14)
        }
    }
}

private struct DigestInsightBlock: View {
    let item: DigestInsight

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(item.text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            if let detail = item.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            DigestMessageCitations(references: item.references)
        }
    }
}

private struct DigestMessageCitations: View {
    let references: [DigestMessageReference]

    var body: some View {
        DigestReferenceFlowLayout(horizontalSpacing: 6, verticalSpacing: 6) {
            ForEach(references) { reference in
                DigestMessageCitation(reference: reference)
            }
        }
    }
}

private struct DigestMessageCitation: View {
    let reference: DigestMessageReference

    var body: some View {
        NavigationLink(value: reference.route) {
            HStack(spacing: 5) {
                Image(systemName: "bubble.left.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                Text(reference.conversation.displayName)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)

                Text(reference.message.createdAt, format: .dateTime.hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Image(systemName: "arrow.up.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                Color(uiColor: .tertiarySystemFill),
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "Open message from \(reference.conversation.displayName) at "
                + reference.message.createdAt.formatted(.dateTime.hour().minute())
        )
        .accessibilityHint("Jumps to the referenced message")
    }
}

private struct DigestReferenceFlowLayout: Layout {
    let horizontalSpacing: CGFloat
    let verticalSpacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let result = layout(subviews: subviews, width: proposal.width ?? .greatestFiniteMagnitude)
        return result.size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(subviews: subviews, width: bounds.width)

        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                anchor: .topLeading,
                proposal: ProposedViewSize(result.sizes[index])
            )
        }
    }

    private func layout(
        subviews: Subviews,
        width: CGFloat
    ) -> (size: CGSize, positions: [CGPoint], sizes: [CGSize]) {
        guard !subviews.isEmpty else { return (.zero, [], []) }

        let availableWidth = max(0, width)
        var positions: [CGPoint] = []
        var sizes: [CGSize] = []
        var cursorX: CGFloat = 0
        var cursorY: CGFloat = 0
        var lineHeight: CGFloat = 0
        var usedWidth: CGFloat = 0

        for subview in subviews {
            let idealSize = subview.sizeThatFits(.unspecified)
            let proposedWidth = min(idealSize.width, availableWidth)
            let size = subview.sizeThatFits(
                ProposedViewSize(width: proposedWidth, height: nil)
            )

            if cursorX > 0, cursorX + size.width > availableWidth {
                cursorX = 0
                cursorY += lineHeight + verticalSpacing
                lineHeight = 0
            }

            positions.append(CGPoint(x: cursorX, y: cursorY))
            sizes.append(size)
            usedWidth = max(usedWidth, cursorX + size.width)
            cursorX += size.width + horizontalSpacing
            lineHeight = max(lineHeight, size.height)
        }

        return (
            CGSize(width: min(usedWidth, availableWidth), height: cursorY + lineHeight),
            positions,
            sizes
        )
    }
}

#Preview("Digest") {
    NavigationStack {
        DigestView()
    }
    .environmentObject(AppModel(previewMode: true))
    .tint(KordiTheme.signalBlue)
}
