import ImageIO
import SwiftUI
import UIKit

struct MessageBubble: View, Equatable {
    let message: ChatMessage
    let mentionTargets: [ComposerMentionTarget]
    let showAuthor: Bool
    let showAvatar: Bool
    let replySourceMessage: ChatMessage?
    let isHighlighted: Bool
    let isPinned: Bool
    let selectionMode: Bool
    let isSelected: Bool
    let allowsQuotedReplies: Bool
    let showsAvatarSlot: Bool
    let authorAvatarName: String
    let authorAvatarSource: String?
    let authorAvatarSeed: String?
    let readByNames: [String]
    let isCallActive: Bool
    let onOpenAuthorProfile: () -> Void
    let onJoinCall: () -> Void
    let onRetry: () -> Void
    let onReply: () -> Void
    let onPin: () -> Void
    let onForward: () -> Void
    let onDetails: () -> Void
    let onSelect: () -> Void
    let onNavigateToReply: (String) -> Void
    let onOpenAttachment: (ChatAttachment, UIImage?) -> Void
    let onShareAttachment: (ChatAttachment) -> Void
    let onAgentExecutionExpansionChange: (Bool) -> Void

    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message
            && lhs.mentionTargets == rhs.mentionTargets
            && lhs.showAuthor == rhs.showAuthor
            && lhs.showAvatar == rhs.showAvatar
            && lhs.replySourceMessage == rhs.replySourceMessage
            && lhs.isHighlighted == rhs.isHighlighted
            && lhs.isPinned == rhs.isPinned
            && lhs.selectionMode == rhs.selectionMode
            && lhs.isSelected == rhs.isSelected
            && lhs.allowsQuotedReplies == rhs.allowsQuotedReplies
            && lhs.showsAvatarSlot == rhs.showsAvatarSlot
            && lhs.authorAvatarName == rhs.authorAvatarName
            && lhs.authorAvatarSource == rhs.authorAvatarSource
            && lhs.authorAvatarSeed == rhs.authorAvatarSeed
            && lhs.readByNames == rhs.readByNames
            && lhs.isCallActive == rhs.isCallActive
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if selectionMode {
                Button(action: onSelect) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? KordiTheme.signalBlue : Color.secondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isSelected ? "Deselect message" : "Select message")
            }

            if showsAvatarSlot && message.author != .me {
                if showAvatar {
                    Button(action: onOpenAuthorProfile) {
                        Color.clear
                            .frame(width: 44, height: 44)
                            .overlay(alignment: .bottom) {
                                IdentityAvatar(
                                    name: authorAvatarName,
                                    imageSource: authorAvatarSource,
                                    kind: message.author == .agent ? .agent : .person,
                                    size: 28,
                                    seed: authorAvatarSeed ?? authorAvatarName
                                )
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(selectionMode)
                    .accessibilityLabel("Open profile for \(authorAvatarName)")
                    .padding(.bottom, 2)
                } else {
                    Color.clear
                        .frame(width: 44, height: 28)
                        .padding(.bottom, 2)
                        .accessibilityHidden(true)
                }
            }

            if message.author == .me { Spacer(minLength: 34) }

            VStack(alignment: message.author == .me ? .trailing : .leading, spacing: 4) {
                if showAuthor && message.author != .me {
                    Text(message.authorName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(message.author == .agent ? KordiTheme.agentViolet : .secondary)
                        .padding(.horizontal, 4)
                }

                messageSurface
                .overlay(alignment: .bottomTrailing) {
                    if message.author == .me,
                       !isCallActivity,
                       deliveryGlyphPlacement == .overlay {
                        MessageDeliveryGlyph(
                            state: message.deliveryState,
                            readByCount: message.readByCount
                        )
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.trailing, 8)
                        .padding(.bottom, 2)
                    }
                }
                .overlay {
                    if isHighlighted {
                        bubbleShape
                            .fill(KordiTheme.signalBlue.opacity(0.10))
                    }
                    bubbleShape
                        .stroke(
                            isHighlighted ? KordiTheme.signalBlue : Color.clear,
                            lineWidth: isHighlighted ? 2 : 0
                        )
                }
                .scaleEffect(isHighlighted ? 1.018 : 1)
                .animation(.snappy(duration: 0.24), value: isHighlighted)
                .contentShape(.contextMenuPreview, bubbleShape)
                .contextMenu {
                    if allowsQuotedReplies {
                        Button(action: onReply) {
                            Label("Reply", systemImage: "arrowshape.turn.up.left")
                        }
                    }
                    Button(action: onPin) {
                        Label(isPinned ? "Unpin" : "Pin", systemImage: "pin")
                    }
                    .disabled(message.deliveryState == .sending || message.deliveryState == .failed)
                    if !message.text.isEmpty {
                        Button {
                            UIPasteboard.general.string = message.text
                        } label: {
                            Label("Copy Text", systemImage: "doc.on.doc")
                        }
                    }
                    Button(action: onForward) {
                        Label("Forward", systemImage: "arrowshape.turn.up.right")
                    }
                    .disabled(message.deliveryState == .sending || message.deliveryState == .failed)
                    Button(action: onDetails) {
                        Label("Details", systemImage: "info.circle")
                    }
                    if message.author == .me, message.deliveryState == .read,
                       (message.readByCount ?? 0) > 0 {
                        Button(action: onDetails) {
                            Label(readReceiptMenuLabel, systemImage: "eye")
                        }
                    }
                    Button(action: onSelect) {
                        Label("Select", systemImage: "checkmark.circle")
                    }
                }

                if message.deliveryState == .failed {
                    Button("Retry", action: onRetry)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 4)
                }

                if message.author == .me,
                   !isCallActivity,
                   deliveryGlyphPlacement == .belowSurface {
                    MessageDeliveryGlyph(
                        state: message.deliveryState,
                        readByCount: message.readByCount
                    )
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 2)
                }
            }

            if showsAvatarSlot && message.author == .me {
                Group {
                    if showAvatar {
                        IdentityAvatar(
                            name: authorAvatarName,
                            imageSource: authorAvatarSource,
                            kind: .person,
                            size: 28,
                            seed: authorAvatarSeed ?? authorAvatarName
                        )
                    } else {
                        Color.clear.frame(width: 28, height: 28)
                    }
                }
                .padding(.bottom, 2)
                .accessibilityHidden(!showAvatar)
            }

            if message.author != .me { Spacer(minLength: 34) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var messageSurface: some View {
        if isCallActivity {
            ConversationCallActivityCard(
                message: message,
                isActive: isCallActive,
                onJoin: onJoinCall
            )
        } else if usesBorderlessImageSurface {
            MessageImageCollection(
                attachments: message.attachments,
                author: message.author,
                onOpen: onOpenAttachment,
                onShare: onShareAttachment
            )
        } else {
            AdaptiveBubbleLayout(
                maximumWidth: 360,
                minimumWidth: agentExecutionMinimumWidth
            ) {
                bubbleContents
                    .padding(.leading, 12)
                    .padding(.trailing, message.author == .me ? 30 : 12)
                    .padding(.vertical, 8)
            }
            .background(bubbleColor, in: bubbleShape)
            .compositingGroup()
            .clipShape(bubbleShape)
        }
    }

    private var agentExecutionMinimumWidth: CGFloat {
        guard let execution = message.agentExecution else { return 0 }
        let presentation = AgentExecutionTimelinePresentation(execution: execution)
        if !execution.completed, !presentation.hasExpandableContent {
            return 0
        }
        return 248
    }

    @ViewBuilder
    private var bubbleContents: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let source = visibleForwardSource {
                HStack(spacing: 5) {
                    Image(systemName: "arrowshape.turn.up.right.fill")
                        .font(.caption2.weight(.semibold))
                    Text("Forwarded from \(source.senderLabel)")
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
            }

            if let source = visibleReplySource {
                replyPreview(source)
            }

            if let execution = message.agentExecution {
                AgentExecutionTimeline(
                    execution: execution,
                    showsWaitingIndicator: Self.showsAgentWaitingIndicator(
                        execution: execution,
                        responseText: message.text
                    ),
                    onExpansionChange: onAgentExecutionExpansionChange
                )
            }

            if hasVisibleMessageText {
                MarkdownMessageContent(
                    text: message.text,
                    mentionTargets: mentionTargets
                )
                    .foregroundStyle(Color.primary)
            }

            if !message.attachments.isEmpty {
                if message.attachments.allSatisfy({ $0.kind == .image }) {
                    MessageImageCollection(
                        attachments: message.attachments,
                        author: message.author,
                        onOpen: onOpenAttachment,
                        onShare: onShareAttachment
                    )
                } else {
                    VStack(spacing: 7) {
                        ForEach(message.attachments) { attachment in
                            MessageAttachmentCard(
                                attachment: attachment,
                                onOpen: { previewImage in
                                    onOpenAttachment(attachment, previewImage)
                                },
                                onShare: { onShareAttachment(attachment) }
                            )
                        }
                    }
                }
            }
        }
    }

    private var usesBorderlessImageSurface: Bool {
        MessageAttachmentPresentation.usesBorderlessImageSurface(for: message)
    }

    private var deliveryGlyphPlacement: MessageAttachmentPresentation.DeliveryGlyphPlacement {
        MessageAttachmentPresentation.deliveryGlyphPlacement(for: message)
    }

    private var hasVisibleMessageText: Bool {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && (
            message.agentExecution == nil
                || Self.hasVisibleAgentResponseText(text)
        )
    }

    static func hasVisibleAgentResponseText(_ responseText: String) -> Bool {
        let text = responseText.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && text != "processing..."
    }

    static func showsAgentWaitingIndicator(
        execution: AgentExecutionSnapshot,
        responseText: String
    ) -> Bool {
        !execution.completed
            && !hasVisibleAgentResponseText(responseText)
            && !AgentExecutionTimelinePresentation(execution: execution).hasExpandableContent
    }

    private var isCallActivity: Bool {
        message.callActivity != nil
    }

    private var visibleReplySource: MessageActionSource? {
        guard allowsQuotedReplies else { return nil }
        if let action = message.messageAction, action.kind == "quote" {
            return action.source
        }
        return replySourceMessage?.actionSource
    }

    private var visibleForwardSource: MessageActionSource? {
        guard let action = message.messageAction, action.kind == "forward" else { return nil }
        return action.source
    }

    private var bubbleShape: UnevenRoundedRectangle {
        if message.author == .me {
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

    private func replyPreview(_ source: MessageActionSource) -> some View {
        Button {
            onNavigateToReply(source.sourceMessageId)
        } label: {
            HStack(spacing: 8) {
                Capsule()
                    .fill(message.author == .me ? KordiTheme.signalBlue : KordiTheme.agentViolet)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.senderLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(message.author == .me ? KordiTheme.signalBlue : KordiTheme.agentViolet)
                    Text(source.textPreview.nonEmpty ?? attachmentCountText(source.attachmentCount))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Reply to \(source.senderLabel): \(source.textPreview)")
    }

    private var bubbleColor: Color {
        switch message.author {
        case .me: KordiTheme.ownBubble
        case .agent: KordiTheme.agentWash
        case .person: Color(uiColor: .secondarySystemGroupedBackground)
        }
    }

    private var accessibilityLabel: String {
        let receipt = if message.deliveryState == .read, let count = message.readByCount, count > 0 {
            "Read by \(count)"
        } else {
            message.deliveryState.label
        }
        let attachmentLabel = message.attachments.isEmpty ? "" : ", \(attachmentCountText(message.attachments.count))"
        return "\(message.authorName), \(message.text)\(attachmentLabel), \(receipt)"
    }

    private func attachmentCountText(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }

    private var readReceiptMenuLabel: String {
        guard !readByNames.isEmpty else {
            return "Read by \(message.readByCount ?? 0) people"
        }
        if readByNames.count <= 2 {
            return "Read by \(readByNames.joined(separator: ", "))"
        }
        return "Read by \(readByNames[0]) and \(readByNames.count - 1) others"
    }
}

struct AgentExecutionTimelineExpansion {
    var isExpanded = false

    mutating func updateCompletion(from wasCompleted: Bool, to isCompleted: Bool) {
        guard !wasCompleted, isCompleted else { return }
        isExpanded = false
    }
}

private struct AgentExecutionTimeline: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let execution: AgentExecutionSnapshot
    let showsWaitingIndicator: Bool
    let onExpansionChange: (Bool) -> Void
    @State private var expansion = AgentExecutionTimelineExpansion()

    private var presentation: AgentExecutionTimelinePresentation {
        AgentExecutionTimelinePresentation(execution: execution)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if showsWaitingIndicator {
                AgentExecutionActivityIndicator(
                    accessibilityStatus: presentation.headline
                )
                .frame(minHeight: 24, alignment: .leading)
            } else if let activeOutputStatus = presentation.activeOutputStatus {
                Button(action: toggleExpansion) {
                    HStack(spacing: 8) {
                        if let completionLabel = presentation.completionLabel {
                            Text(completionLabel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                        } else {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(KordiTheme.signalBlue)
                                    .frame(width: 7, height: 7)
                                    .accessibilityHidden(true)
                                Text(activeOutputStatus)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(expansion.isExpanded ? 180 : 0))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(presentation.completionLabel ?? activeOutputStatus)
                .accessibilityValue(expansion.isExpanded ? "Expanded" : "Collapsed")
            }

            if expansion.isExpanded && presentation.hasExpandableContent {
                VStack(alignment: .leading, spacing: 5) {
                    if let thinkingText = presentation.thinkingText {
                        reasoningSection(thinkingText)
                    } else if let planningStep = presentation.planningStep {
                        planningSection(planningStep)
                    }

                    if !presentation.tools.isEmpty || !presentation.toolSteps.isEmpty {
                        executionSection
                    }

                    if let responseStep = presentation.responseStep {
                        timelineRow(
                            title: "Response",
                            detail: responseStep.label,
                            state: responseStep.state
                        )
                    }

                    if presentation.failedToolCount > 0 {
                        Label(
                            "\(presentation.failedToolCount) \(presentation.failedToolCount == 1 ? "tool failed" : "tools failed")",
                            systemImage: "exclamationmark.circle"
                        )
                        .font(.caption)
                        .foregroundStyle(.red)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: expansion.isExpanded)
        .onChange(of: execution.completed) { wasCompleted, isCompleted in
            expansion.updateCompletion(from: wasCompleted, to: isCompleted)
        }
    }

    private func planningSection(_ step: AgentExecutionStep) -> some View {
        timelineRow(
            title: "Planning",
            detail: step.label,
            state: step.state
        )
    }

    private func reasoningSection(_ thinkingText: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Reasoning")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
            MarkdownMessageContent(text: thinkingText, density: .compact)
                .foregroundStyle(.secondary)
        }
    }

    private var executionSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Execution × \(max(presentation.tools.count, presentation.toolSteps.count))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
            if !presentation.tools.isEmpty {
                ForEach(presentation.tools) { tool in
                    toolRow(tool)
                }
            } else {
                ForEach(presentation.toolSteps) { step in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(step.label)
                            .font(.caption)
                            .foregroundStyle(step.state == .failed ? Color.red : Color.secondary)
                            .lineLimit(2)
                        Spacer(minLength: 4)
                        stepStatusSymbol(step.state)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(step.label)
                    .accessibilityValue(accessibilityStatusLabel(for: step.state))
                }
            }
        }
    }

    private func toolRow(_ tool: AgentExecutionTool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(tool.detail?.nonEmpty ?? tool.name)
                    .font(.caption)
                    .foregroundStyle(tool.state == .failed ? Color.red : Color.secondary)
                    .lineLimit(2)
                Spacer(minLength: 4)
                stepStatusSymbol(tool.state)
            }
            if let details = toolDetails(tool) {
                Text(details)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(8)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func toolDetails(_ tool: AgentExecutionTool) -> String? {
        [tool.arguments, tool.liveOutput, tool.resultText ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            .nonEmpty
    }

    private func timelineRow(
        title: String,
        detail: String,
        state: AgentExecutionStep.State
    ) -> some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(state == .failed ? Color.red : Color.secondary)
                    .lineLimit(3)
            }
            Spacer(minLength: 4)
            stepStatusSymbol(state)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(detail)")
        .accessibilityValue(accessibilityStatusLabel(for: state))
    }

    @ViewBuilder
    private func stepStatusSymbol(_ state: AgentExecutionStep.State) -> some View {
        Group {
            switch state {
            case .pending:
                Image(systemName: "circle")
                    .foregroundStyle(.tertiary)
            case .running:
                Circle()
                    .fill(KordiTheme.signalBlue)
                    .frame(width: 7, height: 7)
            case .complete:
                Image(systemName: "checkmark")
                    .foregroundStyle(.secondary)
            case .failed:
                Image(systemName: "exclamationmark")
                    .foregroundStyle(.red)
            }
        }
        .font(.caption2.weight(.semibold))
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
    }

    private func accessibilityStatusLabel(for state: AgentExecutionStep.State) -> String {
        switch state {
        case .pending:
            "Pending"
        case .running:
            "Running"
        case .complete:
            "Complete"
        case .failed:
            "Failed"
        }
    }

    private func toggleExpansion() {
        if reduceMotion {
            expansion.isExpanded.toggle()
        } else {
            withAnimation(.snappy(duration: 0.24)) {
                expansion.isExpanded.toggle()
            }
        }
        onExpansionChange(expansion.isExpanded)
    }
}

struct AgentExecutionActivityIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let accessibilityStatus: String
    var color: Color = .secondary

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 15.0, paused: reduceMotion)) { context in
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(color)
                        .frame(width: 3, height: 12)
                        .scaleEffect(
                            x: 1,
                            y: reduceMotion ? 0.34 : scale(for: index, at: context.date),
                            anchor: .center
                        )
                }
            }
            .frame(width: 24, height: 16, alignment: .leading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityStatus)
        .accessibilityValue("In progress")
    }

    private func scale(for index: Int, at date: Date) -> CGFloat {
        let elapsed = date.timeIntervalSinceReferenceDate
        let phase = elapsed * 5.4 - Double(index) * 0.9
        return 0.34 + 0.66 * CGFloat((sin(phase) + 1) / 2)
    }
}

private struct ConversationCallActivityCard: View {
    let message: ChatMessage
    let isActive: Bool
    let onJoin: () -> Void

    private var activity: ChatCallActivity {
        message.callActivity ?? ChatCallActivity(messageKind: "call")!
    }

    private var isVoiceCall: Bool {
        message.text.localizedCaseInsensitiveContains("voice call")
    }

    private var isMeeting: Bool {
        message.text.localizedCaseInsensitiveContains("video chat")
    }

    private var callLabel: String {
        if isVoiceCall { return "Voice call" }
        if isMeeting { return "Video chat" }
        return "Video call"
    }

    private var title: String {
        if activity.event == .ended {
            return "\(callLabel) ended"
        }
        if isActive {
            return "\(callLabel) in progress"
        }
        if activity.callId == nil {
            return "\(callLabel) ended"
        }
        return "\(callLabel) started"
    }

    private var detail: String {
        guard activity.event == .ended,
              let range = message.text.range(
                  of: "Duration ",
                  options: [.caseInsensitive]
              ) else { return message.text }
        return String(message.text[range.lowerBound...])
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: isVoiceCall ? "phone.fill" : "video.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(activity.event == .ended ? Color.secondary : KordiTheme.signalBlue)
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .layoutPriority(1)

            if isActive && activity.event == .started {
                Button("Join", action: onJoin)
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(detail)")
    }
}

enum MessageAttachmentPresentation {
    enum DeliveryGlyphPlacement: Equatable {
        case overlay
        case belowSurface
    }

    static func usesBorderlessImageSurface(for message: ChatMessage) -> Bool {
        !message.attachments.isEmpty
            && message.attachments.allSatisfy { $0.kind == .image }
            && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && message.replyToMessageId == nil
            && message.messageAction == nil
    }

    static func deliveryGlyphPlacement(for message: ChatMessage) -> DeliveryGlyphPlacement {
        usesBorderlessImageSurface(for: message) ? .belowSurface : .overlay
    }
}

/// Lets short messages keep their intrinsic width while capping long content
/// to the readable chat column. A fixed `maxWidth` alone expands every bubble.
private struct AdaptiveBubbleLayout: Layout {
    let maximumWidth: CGFloat
    let minimumWidth: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let availableWidth = min(maximumWidth, proposal.width ?? maximumWidth)
        let ideal = subview.sizeThatFits(.unspecified)
        let width = min(availableWidth, max(minimumWidth, ideal.width))
        let fitted = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
        return CGSize(width: ceil(width), height: ceil(fitted.height))
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        subviews.first?.place(
            at: bounds.origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

private struct MessageAttachmentCard: View {
    let attachment: ChatAttachment
    let onOpen: (UIImage?) -> Void
    let onShare: () -> Void

    @ViewBuilder
    var body: some View {
        if attachment.kind == .image {
            MessageImageAttachment(
                attachment: attachment,
                presentation: .natural,
                onOpen: onOpen,
                onShare: onShare
            )
        } else {
            MessageFileAttachmentCard(
                attachment: attachment,
                onOpen: { onOpen(nil) },
                onShare: onShare
            )
        }
    }
}

private struct MessageImageCollection: View {
    let attachments: [ChatAttachment]
    let author: MessageAuthor
    let onOpen: (ChatAttachment, UIImage?) -> Void
    let onShare: (ChatAttachment) -> Void

    @State private var isExpanded = ProcessInfo.processInfo.arguments.contains("--preview-media-expanded")

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if showsExpansionControl, author == .me {
                expansionButton
            }

            imageContent

            if showsExpansionControl, author != .me {
                expansionButton
            }
        }
        .animation(.snappy(duration: 0.24), value: isExpanded)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var imageContent: some View {
        Group {
            if attachments.count == 1, let attachment = attachments.first {
                image(attachment, presentation: .natural)
            } else if isExpanded {
                VStack(alignment: author == .me ? .trailing : .leading, spacing: 6) {
                    ForEach(attachments) { attachment in
                        image(attachment, presentation: .groupedNatural)
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
            } else if let attachment = attachments.first {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(uiColor: .tertiarySystemGroupedBackground))
                        .frame(width: MessageImageMetrics.stackSide, height: MessageImageMetrics.stackSide)
                        .rotationEffect(.degrees(4))
                        .offset(x: 10, y: 3)
                        .shadow(color: .black.opacity(0.14), radius: 4, y: 2)

                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemGroupedBackground))
                        .frame(width: MessageImageMetrics.stackSide, height: MessageImageMetrics.stackSide)
                        .rotationEffect(.degrees(-2.5))
                        .offset(x: 4, y: -1)
                        .shadow(color: .black.opacity(0.10), radius: 3, y: 2)

                    image(attachment, presentation: .stackPreview)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 8)
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .frame(
            width: MessageImageMetrics.collectionWidth,
            alignment: author == .me ? .trailing : .leading
        )
    }

    private var showsExpansionControl: Bool {
        attachments.count > 1
    }

    private var expansionButton: some View {
        Button {
            isExpanded.toggle()
        } label: {
            Text(isExpanded ? "Collapse" : "Expand \(attachments.count)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .frame(
                    width: MessageImageMetrics.expansionControlWidth,
                    height: MessageImageMetrics.expansionControlHeight
                )
                .background(.regularMaterial, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.top, MessageImageMetrics.expansionControlTopInset)
        .accessibilityLabel(isExpanded
                            ? "Collapse grouped photos"
                            : "Expand \(attachments.count) grouped photos")
        .accessibilityHint(isExpanded
                           ? "Shows the photos as a stack"
                           : "Shows every photo in this message")
    }

    private func image(
        _ attachment: ChatAttachment,
        presentation: MessageImagePresentation
    ) -> some View {
        MessageImageAttachment(
            attachment: attachment,
            presentation: presentation,
            onOpen: { previewImage in
                onOpen(attachment, previewImage)
            },
            onShare: { onShare(attachment) }
        )
    }
}

private struct MessageFileAttachmentCard: View {
    let attachment: ChatAttachment
    let onOpen: () -> Void
    let onShare: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onOpen) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.secondary.opacity(0.1))
                    Image(systemName: "doc.text.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .frame(width: 50, height: 50)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Review \(attachment.name)")

            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(attachment.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Menu {
                Button(action: onOpen) {
                    Label("Review", systemImage: "eye")
                }
                Button(action: onShare) {
                    Label("Download / Save to Files", systemImage: "arrow.down.circle")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 44)
            }
            .accessibilityLabel("More actions for \(attachment.name)")
        }
        .padding(.leading, 6)
        .padding(.trailing, 2)
        .padding(.vertical, 5)
        .frame(maxWidth: 310)
        .background(Color(uiColor: .systemBackground).opacity(0.72), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.22), lineWidth: 0.5)
        }
    }

    private var subtitle: String {
        [attachment.formatLabel, attachment.sizeLabel].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct MessageImageAttachment: View {
    @EnvironmentObject private var model: AppModel
    let attachment: ChatAttachment
    let presentation: MessageImagePresentation
    let onOpen: (UIImage?) -> Void
    let onShare: () -> Void

    @State private var image: UIImage?
    @State private var isLoading = true
    @State private var loadFailed = false
    @State private var reloadToken = 0
    @State private var addedMediaKind: ExpressiveMediaLibraryKind?
    @State private var isAddingToMediaLibrary = false

    var body: some View {
        Button {
            if loadFailed {
                reloadToken += 1
            } else if image != nil {
                onOpen(image)
            }
        } label: {
            imageContent
        }
        .buttonStyle(.plain)
        .contentShape(
            .contextMenuPreview,
            RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .contextMenu {
            Button {
                onOpen(image)
            } label: {
                Label("Review", systemImage: "eye")
            }
            Button(action: onShare) {
                Label("Download / Save to Files", systemImage: "arrow.down.circle")
            }
            if let mediaKind {
                Button(action: addToMediaLibrary) {
                    Label(
                        addedMediaKind == mediaKind
                            ? "Added to \(mediaKind.libraryName)"
                            : "Add to \(mediaKind.libraryName)",
                        systemImage: addedMediaKind == mediaKind ? "checkmark.circle" : "square.stack.3d.up"
                    )
                }
                .disabled(isAddingToMediaLibrary || addedMediaKind == mediaKind)
            }
        }
        .task(id: "\(attachment.id):\(reloadToken)") {
            await loadImage()
        }
        .accessibilityLabel(
            attachment.altText?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? (image == nil ? "Image attachment" : "Review image attachment")
        )
        .accessibilityHint(
            loadFailed
                ? "Double tap to retry loading"
                : "\(attachment.name). Touch and hold for image actions."
        )
        .accessibilityAction(named: "Download or save to Files", onShare)
        .accessibilityActions {
            if mediaKind != nil {
                Button(mediaLibraryActionLabel, action: addToMediaLibrary)
            }
        }
        .sensoryFeedback(.success, trigger: addedMediaKind)
    }

    @ViewBuilder
    private var imageContent: some View {
        if let image {
            if presentation == .stackPreview {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: MessageImageMetrics.stackSide, height: MessageImageMetrics.stackSide)
                    .compositingGroup()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .transition(.opacity)
            } else {
                let size = displaySize(for: image)
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .compositingGroup()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .transition(.opacity)
            }
        } else {
            ZStack {
                Color(uiColor: .secondarySystemBackground)
                if isLoading {
                    ProgressView()
                } else {
                    VStack(spacing: 7) {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.title2)
                        Text("Image unavailable")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .frame(
                width: presentation.placeholderSize.width,
                height: presentation.placeholderSize.height
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func loadImage() async {
        image = nil
        isLoading = true
        loadFailed = false

        if let source = attachment.previewURL,
           let preview = await AvatarImageLoader.image(from: source) {
            guard !Task.isCancelled else { return }
            image = preview
            isLoading = false
            return
        }

        guard !attachment.attachmentId.hasPrefix("pending:"),
              let url = await model.prepareAttachmentForPresentation(attachment) else {
            guard !Task.isCancelled else { return }
            isLoading = false
            loadFailed = true
            return
        }

        let loaded = await Task.detached(priority: .utility) {
            AttachmentImageDecoder.downsampledImage(at: url, maximumPixelSize: 1_200)
        }.value
        guard !Task.isCancelled else { return }
        image = loaded
        isLoading = false
        loadFailed = loaded == nil
    }

    private func displaySize(for image: UIImage) -> CGSize {
        guard image.size.width > 0, image.size.height > 0 else {
            return presentation.placeholderSize
        }
        let ratio = min(2.4, max(0.42, image.size.width / image.size.height))
        let maximumWidth = presentation.maximumWidth
        if ratio >= 1 {
            return CGSize(width: maximumWidth, height: maximumWidth / ratio)
        }
        let height = min(presentation.maximumHeight, maximumWidth / ratio)
        return CGSize(width: height * ratio, height: height)
    }

    private var mediaKind: ExpressiveMediaLibraryKind? {
        ExpressiveMediaLibraryKind.supportedKind(
            name: attachment.name,
            mimeType: attachment.mimeType
        )
    }

    private var mediaLibraryActionLabel: String {
        guard let mediaKind else { return "Add to media library" }
        return "Add to \(mediaKind.libraryName)"
    }

    private func addToMediaLibrary() {
        guard mediaKind != nil, !isAddingToMediaLibrary, addedMediaKind == nil else { return }
        isAddingToMediaLibrary = true
        Task {
            addedMediaKind = await model.addAttachmentToExpressiveMediaLibrary(attachment)
            isAddingToMediaLibrary = false
        }
    }
}

private enum MessageImagePresentation {
    case natural
    case groupedNatural
    case stackPreview

    var maximumWidth: CGFloat {
        switch self {
        case .natural:
            244
        case .groupedNatural, .stackPreview:
            MessageImageMetrics.stackSide
        }
    }

    var maximumHeight: CGFloat {
        switch self {
        case .natural:
            320
        case .groupedNatural, .stackPreview:
            236
        }
    }

    var placeholderSize: CGSize {
        switch self {
        case .natural:
            CGSize(width: 244, height: 154)
        case .groupedNatural:
            CGSize(width: MessageImageMetrics.stackSide, height: 142)
        case .stackPreview:
            CGSize(width: MessageImageMetrics.stackSide, height: MessageImageMetrics.stackSide)
        }
    }
}

private enum MessageImageMetrics {
    static let stackSide: CGFloat = 180
    static let collectionWidth: CGFloat = 192
    static let expansionControlWidth: CGFloat = 82
    static let expansionControlHeight: CGFloat = 44
    static let expansionControlTopInset: CGFloat = 76
}

enum AttachmentImageDecoder {
    static func downsampledImage(data: Data, maximumPixelSize: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        return downsampledImage(from: source, maximumPixelSize: maximumPixelSize)
    }

    static func downsampledImage(at url: URL, maximumPixelSize: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else { return nil }
        return downsampledImage(from: source, maximumPixelSize: maximumPixelSize)
    }

    private static func downsampledImage(
        from source: CGImageSource,
        maximumPixelSize: CGFloat
    ) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }
}

private struct MessageDeliveryGlyph: View {
    let state: MessageDeliveryState
    let readByCount: Int?

    var body: some View {
        Group {
            switch state {
            case .sending:
                Image(systemName: "clock")
                    .symbolEffect(.pulse)
            case .sent, .delivered:
                Image(systemName: "checkmark")
            case .read:
                ZStack {
                    Image(systemName: "checkmark").offset(x: -2)
                    Image(systemName: "checkmark").offset(x: 2)
                }
            case .failed:
                Image(systemName: "exclamationmark")
                    .foregroundStyle(.red)
            case .cancelled:
                Image(systemName: "xmark")
            }
        }
        .font(.caption2.weight(.semibold))
        .frame(width: 16, height: 14)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        if state == .read, let readByCount, readByCount > 0 {
            return "Read by \(readByCount)"
        }
        return state.label
    }
}
