import AVKit
import ImageIO
import SwiftUI
import UIKit

enum MessageBubbleGeometry {
    static func shape(for author: MessageAuthor) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 12,
            bottomLeadingRadius: author == .me ? 12 : 4,
            bottomTrailingRadius: author == .me ? 4 : 12,
            topTrailingRadius: 12,
            style: .continuous
        )
    }
}

struct MessageBubble: View, Equatable {
    static let reactionChipVerticalLift: CGFloat = 14

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.kordiChatTheme) private var chatTheme
    let message: ChatMessage
    let mentionTargets: [ComposerMentionTarget]
    let showAuthor: Bool
    let showAvatar: Bool
    let replySourceMessage: ChatMessage?
    let isHighlighted: Bool
    let isActionPresented: Bool
    let isPinned: Bool
    let selectionMode: Bool
    let isSelected: Bool
    let allowsQuotedReplies: Bool
    let threadReplyCount: Int
    let showsAvatarSlot: Bool
    let authorAvatarName: String
    let authorAvatarSource: String?
    let authorAvatarSeed: String?
    let ownAccountId: String?
    let automaticallyPresentsActions: Bool
    let backgroundSessions: [BackgroundAgentSessionPresentation]
    let fullScreenVideoAttachmentID: String?
    let onOpenAuthorProfile: () -> Void
    let onOpenMentionProfile: (String) -> Void
    let onRetry: () async -> Void
    let onSelect: () -> Void
    let onOpenActions: (CGRect, ChatAttachment?) -> Void
    let onSelectedTextChange: (String?) -> Void
    let onReact: (String) -> Void
    let onNavigateToReply: (String) -> Void
    let onOpenThread: () -> Void
    let onOpenAttachment: (ChatAttachment, UIImage?) -> Void
    let onShareAttachment: (ChatAttachment) -> Void
    let onPrepareVoiceMessage: (VoiceMessage) async -> URL?
    let onPrepareAttachment: (ChatAttachment) async -> URL?
    let onPrepareAttachmentPreview: (ChatAttachment) async -> UIImage?
    let onOpenVideo: (ChatAttachment, AVPlayer, UIImage?) -> Void
    let onAddAttachmentToMediaLibrary: (ChatAttachment) async -> ExpressiveMediaLibraryKind?
    let onOpenBackgroundSession: (BackgroundAgentSession) -> Void
    let onAgentExecutionExpansionChange: (Bool) -> Void
    @State private var isRetrying = false
    @State private var actionFrame = CGRect.zero
    @State private var didAutomaticallyPresentActions = false
    @State private var isRequestingActionFrame = false
    @State private var actionAttachment: ChatAttachment?

    static let actionLongPressDuration = 0.5

    private var showsSelectionHighlight: Bool {
        isHighlighted || isSelected
    }

    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message
            && lhs.mentionTargets == rhs.mentionTargets
            && lhs.showAuthor == rhs.showAuthor
            && lhs.showAvatar == rhs.showAvatar
            && lhs.replySourceMessage == rhs.replySourceMessage
            && lhs.isHighlighted == rhs.isHighlighted
            && lhs.isActionPresented == rhs.isActionPresented
            && lhs.isPinned == rhs.isPinned
            && lhs.selectionMode == rhs.selectionMode
            && lhs.isSelected == rhs.isSelected
            && lhs.allowsQuotedReplies == rhs.allowsQuotedReplies
            && lhs.threadReplyCount == rhs.threadReplyCount
            && lhs.showsAvatarSlot == rhs.showsAvatarSlot
            && lhs.authorAvatarName == rhs.authorAvatarName
            && lhs.authorAvatarSource == rhs.authorAvatarSource
            && lhs.authorAvatarSeed == rhs.authorAvatarSeed
            && lhs.ownAccountId == rhs.ownAccountId
            && lhs.automaticallyPresentsActions == rhs.automaticallyPresentsActions
            && lhs.backgroundSessions == rhs.backgroundSessions
            && lhs.fullScreenVideoAttachmentID == rhs.fullScreenVideoAttachmentID
    }

    var body: some View {
        HStack(alignment: usesBorderlessMediaSurface ? .top : .bottom, spacing: 8) {
            if selectionMode {
                Button(action: onSelect) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? chatTheme.accent : Color.secondary)
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
                            .overlay(alignment: usesBorderlessMediaSurface ? .top : .bottom) {
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
                if showAuthor && message.author == .agent {
                    Text(message.authorName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(KordiTheme.agentViolet)
                        .padding(.horizontal, 4)
                }

                messageSurface
                    .overlay(alignment: .bottomTrailing) {
                        if message.author == .me, !isCallActivity, !message.isEdited {
                            if showsMediaDeliveryStatus {
                                mediaDeliveryStatusOverlay
                            } else {
                                MessageDeliveryGlyph(
                                    state: message.deliveryState,
                                    readByCount: message.readByCount
                                )
                                .font(.caption2)
                                .foregroundStyle(bubbleSecondaryTextColor)
                                .padding(.trailing, 8)
                                .padding(.bottom, 2)
                                .allowsHitTesting(false)
                            }
                        }
                    }
                    .overlay {
                        if showsSelectionHighlight {
                            bubbleShape
                                .fill(chatTheme.accent.opacity(0.10))
                                .allowsHitTesting(false)
                        }
                        bubbleShape
                            .stroke(
                                showsSelectionHighlight ? chatTheme.accent : Color.clear,
                                lineWidth: showsSelectionHighlight ? 2 : 0
                            )
                            .allowsHitTesting(false)
                    }
                    .scaleEffect(
                        reduceMotion
                            ? 1
                            : isActionPresented ? 1.016 : showsSelectionHighlight ? 1.018 : 1
                    )
                    .animation(
                        reduceMotion ? nil : .snappy(duration: 0.24),
                        value: showsSelectionHighlight
                    )
                    .animation(
                        reduceMotion
                            ? nil
                            : isActionPresented
                                ? .smooth(duration: 0.22)
                                : .easeOut(duration: 0.14),
                        value: isActionPresented
                    )
                    .contentShape(.contextMenuPreview, bubbleShape)
                    .background {
                        MessageInteractionGestureBridge(
                            minimumPressDuration: Self.actionLongPressDuration,
                            isEnabled: !selectionMode
                                && !hasImageAttachments
                                && actionAttachment == nil,
                            onTap: nil,
                            onLongPress: { onOpenActions($0, nil) }
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .onGeometryChange(for: CGRect.self) { [
                        automaticallyPresentsActions,
                        isActionPresented,
                        isRequestingActionFrame
                    ] proxy in
                        automaticallyPresentsActions || isActionPresented
                            || isRequestingActionFrame
                            ? proxy.frame(in: .global)
                            : .zero
                    } action: { frame in
                        if !frame.isEmpty, frame != actionFrame { actionFrame = frame }
                        if isActionPresented, actionAttachment == nil, !frame.isEmpty {
                            onOpenActions(frame, actionAttachment)
                        }
                        if isRequestingActionFrame, !frame.isEmpty {
                            isRequestingActionFrame = false
                            onOpenActions(frame, nil)
                        }
                        if automaticallyPresentsActions,
                           !hasImageAttachments,
                           !didAutomaticallyPresentActions,
                           !frame.isEmpty {
                            didAutomaticallyPresentActions = true
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(500))
                                onOpenActions(actionFrame, nil)
                            }
                        }
                    }
                    .accessibilityAction(named: "Show message actions") {
                        guard !selectionMode, !hasImageAttachments else { return }
                        actionAttachment = nil
                        isRequestingActionFrame = true
                    }

                if !message.reactions.isEmpty {
                    MessageReactionChips(
                        reactions: message.reactions,
                        ownAccountId: ownAccountId,
                        scrollAnchor: message.author == .me ? .trailing : .leading,
                        onReact: onReact
                    )
                    .offset(y: -Self.reactionChipVerticalLift)
                    .padding(.bottom, -Self.reactionChipVerticalLift)
                }

                if threadReplyCount > 0 {
                    Button(action: onOpenThread) {
                        Label(
                            "\(threadReplyCount) discussed in thread",
                            systemImage: "bubble.left.and.bubble.right"
                        )
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(chatTheme.accent)
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "Open thread with \(threadReplyCount) discussed in thread"
                    )
                }

                if !backgroundSessions.isEmpty {
                    BackgroundAgentSessionList(
                        sessions: backgroundSessions,
                        agentName: message.authorName,
                        isEnabled: !selectionMode,
                        onOpen: onOpenBackgroundSession
                    )
                }

                if message.deliveryState == .failed, !usesBorderlessMediaSurface {
                    messageRetryControl
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
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .onChange(of: isActionPresented) { wasPresented, isPresented in
            if wasPresented, !isPresented {
                actionAttachment = nil
            }
        }
    }

    static func allowsReactions(
        for message: ChatMessage,
        isPreviewMode: Bool = false
    ) -> Bool {
        !message.isSystemNotice
            && message.callActivity == nil
            && (isPreviewMode
                || message.reactionTargetMessageId.flatMap(UUID.init(uuidString:)) != nil)
            && message.deliveryState != .sending
            && message.deliveryState != .failed
            && (!message.text.isEmpty || !message.attachments.isEmpty)
    }

    @ViewBuilder
    private var messageSurface: some View {
        if isCallActivity {
            ConversationCallActivityCard(message: message)
        } else if usesBorderlessImageSurface {
            imageCollection
        } else if usesDetachedImageGroup {
            VStack(alignment: message.author == .me ? .trailing : .leading, spacing: 7) {
                imageCollection
                bubbleSurface
            }
        } else if usesBorderlessVideoSurface {
            VStack(spacing: 7) {
                ForEach(message.attachments) { attachment in
                    MessageVideoAttachment(
                        attachment: attachment,
                        deliveryState: message.deliveryState,
                        uploadProgress: message.attachmentUploadProgress,
                        onPrepare: onPrepareAttachment,
                        onPreparePreview: onPrepareAttachmentPreview,
                        onExpand: onOpenVideo,
                        isPresentedFullScreen: fullScreenVideoAttachmentID == attachment.id
                    )
                }
            }
        } else {
            bubbleSurface
        }
    }

    private var imageCollection: some View {
        MessageImageCollection(
            attachments: message.attachments,
            author: message.author,
            onOpen: onOpenAttachment,
            onShare: onShareAttachment,
            onPrepare: onPrepareAttachment,
            onAddToMediaLibrary: onAddAttachmentToMediaLibrary,
            actionAttachmentID: actionAttachment?.id,
            onPrepareActions: prepareImageActions,
            onRequestActions: requestImageActions
        )
    }

    private var bubbleSurface: some View {
        AdaptiveBubbleLayout(
            maximumWidth: 360,
            minimumWidth: agentExecutionMinimumWidth
        ) {
            bubbleContents
                .padding(.leading, message.voiceMessage == nil ? 12 : 10)
                .padding(
                    .trailing,
                    message.author == .me
                        ? message.isEdited
                            ? (message.voiceMessage == nil ? 12 : 10)
                            : (message.voiceMessage == nil ? 30 : 26)
                        : (message.voiceMessage == nil ? 12 : 10)
                )
                .padding(.vertical, message.voiceMessage == nil ? 8 : 6)
        }
        .environment(\.colorScheme, bubbleContentColorScheme)
        .foregroundStyle(bubbleTextColor)
        .background {
            bubbleShape.fill(bubbleColor)
            bubbleShape.fill(lightAppearanceBubbleTintColor)
        }
        .clipShape(bubbleShape)
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
            if showAuthor && message.author == .person {
                Text(message.authorName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(chatTheme.accent)
                    .lineLimit(1)
            }

            if let source = visibleForwardSource {
                HStack(spacing: 5) {
                    Image(systemName: "arrowshape.turn.up.right.fill")
                        .font(.caption2.weight(.semibold))
                    Text("Forwarded from \(source.senderLabel)")
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(bubbleSecondaryTextColor)
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

            if let voiceMessage = message.voiceMessage {
                VoiceMessageBubbleContent(
                    voiceMessage: voiceMessage,
                    reservesDeliveryStatus: message.author == .me,
                    onPrepare: onPrepareVoiceMessage
                )
            }

            if hasVisibleMessageText {
                MarkdownMessageContent(
                    text: message.text,
                    mentionTargets: mentionTargets,
                    mentions: message.mentions,
                    inlineAccent: bubbleInlineAccentColor,
                    allowsTextSelection: isActionPresented,
                    onSelectedTextChange: onSelectedTextChange,
                    onOpenPersonMention: onOpenMentionProfile
                )
                    .foregroundStyle(bubbleTextColor)

                if let url = KordiMarkdownParser.firstExternalURL(in: message.text) {
                    MessageLinkPreview(url: url)
                }
            }

            if !message.attachments.isEmpty, !usesDetachedImageGroup {
                if message.attachments.allSatisfy({ $0.kind == .image }) {
                    MessageImageCollection(
                        attachments: message.attachments,
                        author: message.author,
                        onOpen: onOpenAttachment,
                        onShare: onShareAttachment,
                        onPrepare: onPrepareAttachment,
                        onAddToMediaLibrary: onAddAttachmentToMediaLibrary,
                        actionAttachmentID: actionAttachment?.id,
                        onPrepareActions: prepareImageActions,
                        onRequestActions: requestImageActions
                    )
                    .frame(maxWidth: .infinity, alignment: .center)
                } else {
                    VStack(spacing: 7) {
                        ForEach(message.attachments) { attachment in
                            MessageAttachmentCard(
                                attachment: attachment,
                                deliveryState: message.deliveryState,
                                uploadProgress: message.attachmentUploadProgress,
                                onOpen: { previewImage in
                                    onOpenAttachment(attachment, previewImage)
                                },
                                onShare: { onShareAttachment(attachment) },
                                onPrepare: onPrepareAttachment,
                                onPreparePreview: onPrepareAttachmentPreview,
                                onOpenVideo: onOpenVideo,
                                isVideoPresentedFullScreen: fullScreenVideoAttachmentID == attachment.id,
                                onAddToMediaLibrary: onAddAttachmentToMediaLibrary,
                                isActionTarget: actionAttachment?.id == attachment.id,
                                onPrepareActions: { prepareImageActions(attachment) },
                                onRequestActions: { frame in
                                    requestImageActions(attachment, frame: frame)
                                }
                            )
                        }
                    }
                }
            }

            if message.isEdited {
                HStack(spacing: 2) {
                    Spacer(minLength: 0)
                    Text("edited", comment: "Message metadata indicating that its text was changed after sending.")
                    if message.author == .me {
                        MessageDeliveryGlyph(
                            state: message.deliveryState,
                            readByCount: message.readByCount
                        )
                    }
                }
                .font(.caption2)
                .foregroundStyle(bubbleSecondaryTextColor)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var usesBorderlessImageSurface: Bool {
        MessageAttachmentPresentation.usesBorderlessImageSurface(for: message)
    }

    private var usesDetachedImageGroup: Bool {
        MessageAttachmentPresentation.usesDetachedImageGroup(for: message)
    }

    private var usesBorderlessVideoSurface: Bool {
        MessageAttachmentPresentation.usesBorderlessVideoSurface(for: message)
    }

    private var usesBorderlessMediaSurface: Bool {
        usesBorderlessImageSurface || usesBorderlessVideoSurface
    }

    private var hasImageAttachments: Bool {
        message.attachments.contains { $0.kind == .image }
    }

    private func prepareImageActions(_ attachment: ChatAttachment?) {
        actionAttachment = attachment
    }

    private func requestImageActions(_ attachment: ChatAttachment, frame: CGRect) {
        actionAttachment = attachment
        onOpenActions(frame, attachment)
    }

    private var showsMediaDeliveryStatus: Bool {
        MessageMediaStatusPresentation.showsOverlay(
            for: message
        )
    }

    @ViewBuilder
    private var mediaDeliveryStatusOverlay: some View {
        if message.deliveryState == .failed || isRetrying {
            Button(action: startRetry) {
                if isRetrying {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.red)
                        .accessibilityHidden(true)
                } else {
                    Text("!")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(.red)
                        .shadow(color: .black.opacity(0.72), radius: 2, y: 1)
                }
            }
            .frame(width: 44, height: 44, alignment: .bottomTrailing)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
            .disabled(isRetrying)
            .padding(.trailing, 6)
            .padding(.bottom, 6)
            .accessibilityLabel(isRetrying ? "Retrying image" : "Retry sending image")
            .sensoryFeedback(.selection, trigger: isRetrying) { oldValue, newValue in
                !oldValue && newValue
            }
        } else {
            HStack(spacing: 4) {
                Text(message.createdAt, format: .dateTime.hour().minute())
                MessageDeliveryGlyph(
                    state: message.deliveryState,
                    readByCount: message.readByCount
                )
            }
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.72), radius: 2, y: 1)
            .padding(.horizontal, usesBorderlessVideoSurface ? 8 : 0)
            .padding(.vertical, usesBorderlessVideoSurface ? 5 : 0)
            .background(
                usesBorderlessVideoSurface ? Color.black.opacity(0.58) : Color.clear,
                in: Capsule()
            )
            .padding(.trailing, 8)
            .padding(.bottom, 8)
            .allowsHitTesting(false)
            .accessibilityElement(children: .combine)
        }
    }

    private var messageRetryControl: some View {
        Button(action: startRetry) {
            HStack(spacing: 4) {
                if isRetrying {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.red)
                        .accessibilityHidden(true)
                    Text("Retrying…")
                } else {
                    Text("Retry")
                        .fontWeight(.bold)
                }
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.red)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(minHeight: 28)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isRetrying)
        .accessibilityLabel(isRetrying ? "Retrying message" : "Retry sending message")
        .sensoryFeedback(.selection, trigger: isRetrying) { oldValue, newValue in
            !oldValue && newValue
        }
    }

    private func startRetry() {
        guard !isRetrying else { return }
        isRetrying = true
        Task {
            await onRetry()
            isRetrying = false
        }
    }

    private var hasVisibleMessageText: Bool {
        if message.voiceMessage != nil { return false }
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && (
            message.agentExecution == nil
                || Self.hasVisibleAgentResponseText(text)
        )
    }

    static func hasVisibleAgentResponseText(_ responseText: String) -> Bool {
        let text = responseText.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && !CloudMessageCodec.isAgentProcessingPlaceholder(text)
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
        MessageBubbleGeometry.shape(for: message.author)
    }

    private func replyPreview(_ source: MessageActionSource) -> some View {
        let accessibilityText = ComposerMentionTargetCatalog.accessibilityText(
            in: source.textPreview,
            mentions: source.mentions ?? [],
            targets: mentionTargets
        )
        return Button {
            onNavigateToReply(source.sourceMessageId)
        } label: {
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.senderLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(bubbleInlineAccentColor)
                    MarkdownMessageContent(
                        text: source.textPreview.nonEmpty ?? attachmentCountText(source.attachmentCount),
                        density: .compact,
                        mentionTargets: mentionTargets,
                        mentions: source.mentions ?? [],
                        inlineAccent: bubbleInlineAccentColor
                    )
                        .foregroundStyle(bubbleSecondaryTextColor)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                replyPreviewBackgroundColor,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Reply to \(source.senderLabel): \(accessibilityText)")
    }

    private var bubbleColor: Color {
        switch message.author {
        case .me: chatTheme.ownBubble
        case .agent: chatTheme.agentBubble
        case .person: chatTheme.peerBubble
        }
    }

    private var lightAppearanceBubbleTintColor: Color {
        guard colorScheme == .light else { return .clear }
        return switch message.author {
        case .me: chatTheme == .quiet ? .clear : chatTheme.accent.opacity(0.12)
        case .person: chatTheme == .quiet
            ? chatTheme.peerText.opacity(0.12)
            : chatTheme.accent.opacity(0.16)
        case .agent: .clear
        }
    }

    private var bubbleInlineAccentColor: Color {
        switch message.author {
        case .me: chatTheme.ownText
        case .person: chatTheme.accent
        case .agent: KordiTheme.agentMention
        }
    }

    private var replyPreviewBackgroundColor: Color {
        switch message.author {
        case .me: bubbleTextColor.opacity(0.16)
        case .person: colorScheme == .light && chatTheme == .quiet
            ? chatTheme.peerText.opacity(0.12)
            : chatTheme.accent.opacity(0.22)
        case .agent: KordiTheme.agentViolet.opacity(0.22)
        }
    }

    private var bubbleTextColor: Color {
        message.author == .me ? chatTheme.ownText : chatTheme.peerText
    }

    private var bubbleSecondaryTextColor: Color {
        bubbleTextColor.opacity(
            message.author == .me
                ? KordiChatTheme.ownMetadataOpacity
                : KordiChatTheme.otherMetadataOpacity
        )
    }

    private var bubbleContentColorScheme: ColorScheme {
        if colorScheme == .light,
           message.author == .me,
           chatTheme.usesLightOwnTextInLightAppearance {
            return .dark
        }
        return colorScheme
    }

    private var accessibilityLabel: String {
        let receipt = if message.deliveryState == .read, let count = message.readByCount, count > 0 {
            "Seen by \(count)"
        } else {
            message.deliveryState.label
        }
        let attachmentLabel = message.voiceMessage != nil
            ? ", voice message"
            : message.attachments.contains(where: { $0.isMP4Video })
                ? ", video message"
                : message.attachments.isEmpty ? "" : ", \(attachmentCountText(message.attachments.count))"
        let messageText = ComposerMentionTargetCatalog.accessibilityText(
            in: message.text,
            mentions: message.mentions,
            targets: mentionTargets
        )
        let editedLabel = message.isEdited ? ", edited" : ""
        return "\(message.authorName), \(messageText)\(attachmentLabel)\(editedLabel), \(receipt)"
    }

    private func attachmentCountText(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }

}

private struct MessageReactionChips: View {
    let reactions: [MessageReaction]
    let ownAccountId: String?
    let scrollAnchor: UnitPoint
    let onReact: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(reactions) { reaction in
                    Button {
                        onReact(reaction.value)
                    } label: {
                        HStack(spacing: 4) {
                            if let emoji = BlobEmojiCatalog.emoji(
                                forReactionValue: reaction.value
                            ) {
                                BlobEmojiView(emoji: emoji, size: 22)
                            } else {
                                Text(reaction.value)
                            }
                            Text("\(reaction.accountIds.count)")
                                .font(.caption2.weight(.semibold))
                        }
                        .padding(.horizontal, 9)
                        .frame(minHeight: 32)
                        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .accessibilityLabel(
                        "\(reactionAccessibilityName(reaction.value)) reaction, \(reaction.accountIds.count) people"
                    )
                    .accessibilityValue(
                        reaction.includes(accountId: ownAccountId) ? "You reacted" : ""
                    )
                    .accessibilityHint("Double tap to toggle this reaction")
                }
            }
        }
        .defaultScrollAnchor(scrollAnchor)
        .frame(maxWidth: 310)
    }

    private func reactionAccessibilityName(_ value: String) -> String {
        BlobEmojiCatalog.emoji(forReactionValue: value)?.accessibilityName ?? value
    }
}

private struct BackgroundAgentSessionList: View {
    let sessions: [BackgroundAgentSessionPresentation]
    let agentName: String
    let isEnabled: Bool
    let onOpen: (BackgroundAgentSession) -> Void

    var body: some View {
        VStack(spacing: 2) {
            ForEach(sessions) { presentation in
                BackgroundAgentSessionRow(
                    presentation: presentation,
                    agentName: agentName,
                    isEnabled: isEnabled,
                    onOpen: onOpen
                )
            }
        }
        .padding(.leading, 16)
        .frame(maxWidth: 360, alignment: .leading)
        .overlay(alignment: .topLeading) {
            BackgroundSessionThreadConnector()
                .stroke(
                    Color(uiColor: .separator).opacity(0.6),
                    style: StrokeStyle(lineWidth: 0.75, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 12, height: 28)
                .offset(x: 4, y: -12)
                .accessibilityHidden(true)
        }
    }
}

private struct BackgroundSessionThreadConnector: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let radius = min(9, min(rect.width, rect.height))
        path.move(to: .zero)
        path.addLine(to: CGPoint(x: 0, y: rect.maxY - radius))
        path.addQuadCurve(
            to: CGPoint(x: radius, y: rect.maxY),
            control: CGPoint(x: 0, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        return path
    }
}

private struct BackgroundAgentSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let presentation: BackgroundAgentSessionPresentation
    let agentName: String
    let isEnabled: Bool
    let onOpen: (BackgroundAgentSession) -> Void

    var body: some View {
        Button {
            onOpen(presentation.session)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(presentation.session.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                            .layoutPriority(1)

                        Spacer(minLength: 8)

                        HStack(spacing: 2) {
                            Text("Open")
                            Image(systemName: "chevron.right")
                                .accessibilityHidden(true)
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(KordiTheme.signalBlue)
                        .fixedSize()
                    }

                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 2) {
                            metadataLabel
                            statusLabel
                        }
                    } else {
                        HStack(spacing: 5) {
                            metadataLabel
                            Spacer(minLength: 6)
                            statusLabel
                        }
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(presentation.session.title), \(agentName), background session, \(presentation.state.label)"
        )
        .accessibilityHint("Opens the linked agent session")
    }

    private var metadataLabel: some View {
        HStack(spacing: 5) {
            Text(agentName)
                .fontWeight(.medium)
                .foregroundStyle(.primary)
            Text("·")
                .accessibilityHidden(true)
            Text("Background session")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }

    private var statusLabel: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(presentation.state.label)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .fixedSize()
    }

    private var statusColor: Color {
        switch presentation.state {
        case .running: KordiTheme.signalBlue
        case .done: .green
        case .failed: .red
        case .stopped: .secondary
        }
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
    static func usesBorderlessImageSurface(for message: ChatMessage) -> Bool {
        !message.attachments.isEmpty
            && message.attachments.allSatisfy { $0.kind == .image }
            && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && message.replyToMessageId == nil
            && message.messageAction == nil
    }

    static func usesBorderlessVideoSurface(for message: ChatMessage) -> Bool {
        !message.attachments.isEmpty
            && message.attachments.allSatisfy(\.isMP4Video)
            && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && message.replyToMessageId == nil
            && message.messageAction == nil
    }

    static func usesDetachedImageGroup(for message: ChatMessage) -> Bool {
        message.attachments.count > 1
            && message.attachments.allSatisfy { $0.kind == .image }
            && !usesBorderlessImageSurface(for: message)
    }

    static func usesBorderlessMediaSurface(for message: ChatMessage) -> Bool {
        usesBorderlessImageSurface(for: message) || usesBorderlessVideoSurface(for: message)
    }
}

enum MessageMediaStatusPresentation {
    static func showsOverlay(for message: ChatMessage) -> Bool {
        message.author == .me
            && MessageAttachmentPresentation.usesBorderlessMediaSurface(for: message)
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
        let compactWidth = min(width, max(minimumWidth, fitted.width))
        return CGSize(width: ceil(compactWidth), height: ceil(fitted.height))
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
    let deliveryState: MessageDeliveryState
    let uploadProgress: Double?
    let onOpen: (UIImage?) -> Void
    let onShare: () -> Void
    let onPrepare: (ChatAttachment) async -> URL?
    let onPreparePreview: (ChatAttachment) async -> UIImage?
    let onOpenVideo: (ChatAttachment, AVPlayer, UIImage?) -> Void
    let isVideoPresentedFullScreen: Bool
    let onAddToMediaLibrary: (ChatAttachment) async -> ExpressiveMediaLibraryKind?
    let isActionTarget: Bool
    let onPrepareActions: () -> Void
    let onRequestActions: (CGRect) -> Void

    @ViewBuilder
    var body: some View {
        if attachment.kind == .image {
            MessageImageAttachment(
                attachment: attachment,
                presentation: .natural,
                onOpen: onOpen,
                onShare: onShare,
                onPrepare: onPrepare,
                onAddToMediaLibrary: onAddToMediaLibrary,
                isActionTarget: isActionTarget,
                onPrepareActions: onPrepareActions,
                onRequestActions: onRequestActions
            )
        } else if attachment.isMP4Video {
            MessageVideoAttachment(
                attachment: attachment,
                deliveryState: deliveryState,
                uploadProgress: uploadProgress,
                onPrepare: onPrepare,
                onPreparePreview: onPreparePreview,
                onExpand: onOpenVideo,
                isPresentedFullScreen: isVideoPresentedFullScreen
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let attachments: [ChatAttachment]
    let author: MessageAuthor
    let onOpen: (ChatAttachment, UIImage?) -> Void
    let onShare: (ChatAttachment) -> Void
    let onPrepare: (ChatAttachment) async -> URL?
    let onAddToMediaLibrary: (ChatAttachment) async -> ExpressiveMediaLibraryKind?
    let actionAttachmentID: String?
    let onPrepareActions: (ChatAttachment?) -> Void
    let onRequestActions: (ChatAttachment, CGRect) -> Void

    @State private var isExpanded = ProcessInfo.processInfo.arguments.contains("--preview-media-expanded")
    @State private var selectedImageIndex = 0
    @State private var flipProgress: CGFloat = 0
    @State private var flipDirection = 1
    @State private var isCompletingFlip = false

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
            } else if !attachments.isEmpty {
                ZStack {
                    ForEach(
                        visibleBackdropIndices,
                        id: \.self
                    ) { index in
                        let depth = (index - currentImageIndex + attachments.count) % attachments.count
                        image(attachments[index], presentation: .stackPreview)
                            .rotationEffect(.degrees(depth == 1 ? -2.5 : 4))
                            .offset(x: depth == 1 ? 4 : 10, y: depth == 1 ? -1 : 3)
                            .shadow(
                                color: .black.opacity(depth == 1 ? 0.10 : 0.14),
                                radius: depth == 1 ? 3 : 4,
                                y: 2
                            )
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }

                    image(attachments[flipTargetIndex], presentation: .stackPreview)
                        .rotationEffect(.degrees(targetBackdropAngle * Double(1 - flipProgress)))
                        .offset(
                            x: targetBackdropOffset.width * (1 - flipProgress),
                            y: targetBackdropOffset.height * (1 - flipProgress)
                        )
                        .scaleEffect(0.98 + 0.02 * flipProgress)
                        .shadow(color: .black.opacity(0.12), radius: 3.5, y: 2)
                        .opacity(reduceMotion ? flipProgress : 1)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)

                    image(attachments[currentImageIndex], presentation: .stackPreview)
                        .rotationEffect(
                            .degrees(reduceMotion ? 0 : -12 * Double(flipDirection) * Double(flipProgress))
                        )
                        .offset(
                            x: reduceMotion ? 0 : -MessageImageMetrics.stackSide * 0.6
                                * CGFloat(flipDirection) * flipProgress,
                            y: reduceMotion ? 0 : 8 * flipProgress
                        )
                        .scaleEffect(reduceMotion ? 1 : 1 - 0.03 * flipProgress)
                        .shadow(
                            color: .black.opacity(
                                reduceMotion ? 0.14 : 0.14 + 0.08 * Double(flipProgress)
                            ),
                            radius: reduceMotion ? 4 : 4 + 4 * flipProgress,
                            y: reduceMotion ? 2 : 2 + 3 * flipProgress
                        )
                        .opacity(1 - (reduceMotion ? 1 : 0.72) * Double(flipProgress))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)

                    collapsedInteractionSurface
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 8)
                .clipped()
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .frame(
            width: MessageImageCollectionLayout.fixedWidth(
                attachmentCount: attachments.count
            ),
            alignment: author == .me ? .trailing : .leading
        )
    }

    private var showsExpansionControl: Bool {
        attachments.count > 1
    }

    private var currentImageIndex: Int {
        min(selectedImageIndex, max(0, attachments.count - 1))
    }

    private var visibleBackdropIndices: [Int] {
        MessageImageStack.backdropIndices(
            count: attachments.count,
            selectedIndex: currentImageIndex
        ).filter { $0 != flipTargetIndex }
    }

    private var flipTargetIndex: Int {
        MessageImageStack.targetIndex(
            count: attachments.count,
            selectedIndex: currentImageIndex,
            direction: flipDirection
        )
    }

    private var targetBackdropDepth: Int {
        min(2, max(1, (flipTargetIndex - currentImageIndex + attachments.count) % attachments.count))
    }

    private var targetBackdropAngle: Double {
        targetBackdropDepth == 1 ? -2.5 : 4
    }

    private var targetBackdropOffset: CGSize {
        targetBackdropDepth == 1 ? CGSize(width: 4, height: -1) : CGSize(width: 10, height: 3)
    }

    private var flipGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard attachments.count > 1, !isCompletingFlip,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                flipDirection = value.translation.width < 0 ? 1 : -1
                flipProgress = min(0.92, abs(value.translation.width) / MessageImageMetrics.stackSide)
            }
            .onEnded { value in
                guard flipProgress > 0 else { return }
                let shouldComplete = flipProgress >= 0.3
                    || abs(value.predictedEndTranslation.width) >= MessageImageMetrics.stackSide * 0.5
                if shouldComplete {
                    completeFlip()
                } else {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
                        flipProgress = 0
                    }
                }
            }
    }

    private var collapsedInteractionSurface: some View {
        Button {
            isExpanded = true
        } label: {
            Color.clear
                .frame(
                    width: MessageImageMetrics.stackSide,
                    height: MessageImageMetrics.stackSide
                )
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .simultaneousGesture(flipGesture)
        .accessibilityLabel("Expand \(attachments.count) grouped photos")
        .accessibilityValue("Photo \(currentImageIndex + 1) of \(attachments.count)")
        .accessibilityHint("Double tap to expand, or swipe left or right to flip photos")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment:
                startFlip(direction: 1)
            case .decrement:
                startFlip(direction: -1)
            @unknown default:
                break
            }
        }
    }

    private func startFlip(direction: Int) {
        guard attachments.count > 1, !isCompletingFlip else { return }
        flipDirection = direction
        completeFlip()
    }

    private func completeFlip() {
        let targetIndex = flipTargetIndex
        if reduceMotion {
            selectedImageIndex = targetIndex
            flipProgress = 0
            return
        }
        isCompletingFlip = true
        withAnimation(.easeIn(duration: 0.18)) {
            flipProgress = 1
        } completion: {
            selectedImageIndex = targetIndex
            flipProgress = 0
            isCompletingFlip = false
        }
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
                if presentation.isStackPreview {
                    isExpanded = true
                } else {
                    onOpen(attachment, previewImage)
                }
            },
            onShare: { onShare(attachment) },
            onPrepare: onPrepare,
            onAddToMediaLibrary: onAddToMediaLibrary,
            isActionTarget: actionAttachmentID == attachment.id,
            onPrepareActions: {
                if presentation.isStackPreview {
                    onPrepareActions(nil)
                    isExpanded = true
                } else {
                    onPrepareActions(attachment)
                }
            },
            onRequestActions: { frame in
                guard !presentation.isStackPreview else { return }
                onRequestActions(attachment, frame)
            }
        )
    }
}

enum MessageImageStack {
    static func backdropIndices(count: Int, selectedIndex: Int) -> [Int] {
        guard count > 1 else { return [] }
        return (1..<min(count, 3)).reversed().map { (selectedIndex + $0) % count }
    }

    static func targetIndex(count: Int, selectedIndex: Int, direction: Int) -> Int {
        guard count > 0 else { return 0 }
        return (selectedIndex + (direction < 0 ? count - 1 : 1)) % count
    }
}

enum MessageImageCollectionLayout {
    static func fixedWidth(attachmentCount: Int) -> CGFloat? {
        attachmentCount > 1 ? MessageImageMetrics.collectionWidth : nil
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

struct VideoPreviewPresentation: Identifiable {
    let attachment: ChatAttachment
    let player: AVPlayer
    let poster: UIImage?
    var id: ObjectIdentifier { ObjectIdentifier(player) }

    init(attachment: ChatAttachment, inlinePlayer: AVPlayer, poster: UIImage?) {
        self.attachment = attachment
        self.player = inlinePlayer
        self.poster = poster
    }
}

private struct NativeFullScreenVideoPlayer: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = true
        controller.videoGravity = .resizeAspect
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }

    static func dismantleUIViewController(
        _ controller: AVPlayerViewController,
        coordinator: ()
    ) {
        controller.player?.pause()
        controller.player = nil
    }
}

private struct MessageVideoAttachment: View {
    let attachment: ChatAttachment
    let deliveryState: MessageDeliveryState
    let uploadProgress: Double?
    let onPrepare: (ChatAttachment) async -> URL?
    let onPreparePreview: (ChatAttachment) async -> UIImage?
    let onExpand: (ChatAttachment, AVPlayer, UIImage?) -> Void
    let isPresentedFullScreen: Bool

    @State private var player: AVPlayer?
    @State private var poster: UIImage?
    @State private var posterAspectRatio: CGFloat?
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var playbackHasStarted = false
    @State private var playbackTimeObserver: Any?

    var body: some View {
        Group {
            if resolvedVideoAspectRatio == nil {
                resolvingSurface
            } else if deliveryState == .sending && (uploadProgress ?? 0) < 1 {
                sendingSurface
            } else if let player {
                ZStack(alignment: .topTrailing) {
                    if isPresentedFullScreen {
                        if let poster {
                            Image(uiImage: poster)
                                .resizable()
                                .scaledToFill()
                        } else {
                            Color(uiColor: .secondarySystemBackground)
                        }
                    } else {
                        VideoPlayer(player: player)
                            .aspectRatio(videoAspectRatio, contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .background(.black)
                            .accessibilityLabel("Play \(attachment.name)")
                        if !playbackHasStarted {
                            ZStack {
                                if let poster {
                                    Image(uiImage: poster)
                                        .resizable()
                                        .scaledToFill()
                                } else {
                                    Color(uiColor: .secondarySystemBackground)
                                }
                                Color.black.opacity(poster == nil ? 0 : 0.18)
                                ProgressView()
                                    .controlSize(.large)
                                    .tint(.white)
                            }
                            .clipped()
                            .allowsHitTesting(false)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Loading \(attachment.name)")
                        } else {
                            Button {
                                onExpand(attachment, player, poster)
                            } label: {
                                Image(systemName: "arrow.up.left.and.arrow.down.right")
                                    .font(.caption.weight(.semibold))
                                    .frame(width: 34, height: 34)
                                    .foregroundStyle(.white)
                                    .background(Color.black.opacity(0.44), in: Circle())
                                    .overlay {
                                        Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.5)
                                    }
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .padding(4)
                            .zIndex(1)
                            .accessibilityLabel("Play \(attachment.name) in full screen")
                        }
                    }
                }
            } else {
                Button(action: loadAndPlay) {
                    ZStack {
                        Color(uiColor: .secondarySystemBackground)
                        if let poster {
                            Image(uiImage: poster)
                                .resizable()
                                .scaledToFill()
                                .accessibilityHidden(true)
                        }
                        Color.black.opacity(poster == nil ? 0 : 0.18)
                        Group {
                            if isLoading {
                                ProgressView()
                                    .controlSize(.large)
                                    .tint(.white)
                            } else {
                                Image(systemName: loadFailed ? "arrow.clockwise" : "play.fill")
                                    .font(.title2.weight(.semibold))
                                    .offset(x: loadFailed ? 0 : 1)
                            }
                        }
                        .frame(width: 56, height: 56)
                        .foregroundStyle(.white)
                        .background(Color.black.opacity(0.58), in: Circle())
                        .overlay {
                            Circle()
                                .stroke(Color.white.opacity(0.2), lineWidth: 0.5)
                        }
                        .accessibilityHidden(true)
                    }
                    .aspectRatio(videoAspectRatio, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
                .accessibilityLabel(
                    isLoading
                        ? "Loading \(attachment.name)"
                        : loadFailed ? "Retry loading \(attachment.name)" : "Play \(attachment.name)"
                )
            }
        }
        .frame(
            width: resolvedVideoAspectRatio == nil ? nil : videoDisplaySize.width,
            height: resolvedVideoAspectRatio == nil ? nil : videoDisplaySize.height
        )
        .background(poster == nil ? Color(uiColor: .secondarySystemBackground) : .black)
        .compositingGroup()
        .clipShape(.rect(cornerRadius: 13))
        .task(id: attachment.id) {
            let image = await onPreparePreview(attachment)
            if !Task.isCancelled {
                poster = image
                if let image, image.size.width > 0, image.size.height > 0 {
                    posterAspectRatio = image.size.width / image.size.height
                }
            }
        }
        .onDisappear {
            clearPlaybackTimeObserver()
            player?.pause()
        }
    }

    private var sendingSurface: some View {
        ZStack {
            Color(uiColor: .secondarySystemBackground)
            if let poster {
                Image(uiImage: poster)
                    .resizable()
                    .scaledToFill()
                    .accessibilityHidden(true)
            }
            Color.black.opacity(poster == nil ? 0 : 0.5)
            VStack(spacing: 8) {
                if let uploadProgress {
                    ZStack {
                        Circle()
                            .stroke(
                                poster == nil ? Color.secondary.opacity(0.25) : Color.white.opacity(0.25),
                                lineWidth: 3
                            )
                        Circle()
                            .trim(from: 0, to: min(1, max(0, uploadProgress)))
                            .stroke(
                                poster == nil ? Color.secondary : Color.white,
                                style: StrokeStyle(lineWidth: 3, lineCap: .round)
                            )
                            .rotationEffect(.degrees(-90))
                        Text("\(Int((uploadProgress * 100).rounded()))%")
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(poster == nil ? Color.primary : .white)
                    }
                    .frame(width: 56, height: 56)
                    if let sizeLabel = uploadSizeProgressLabel {
                        Text(sizeLabel)
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(poster == nil ? Color.secondary : .white.opacity(0.9))
                    }
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .tint(poster == nil ? Color.secondary : .white)
                    Text("Sending…")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(poster == nil ? Color.primary : .white)
                }
            }
        }
        .aspectRatio(videoAspectRatio, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipped()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sending \(attachment.name)")
        .accessibilityValue(uploadProgress.map {
            "\(Int(($0 * 100).rounded())) percent"
        } ?? "In progress")
    }

    private var uploadSizeProgressLabel: String? {
        guard let uploadProgress, let totalBytes = attachment.sizeBytes, totalBytes > 0 else {
            return nil
        }
        let uploadedBytes = Int64((Double(totalBytes) * min(1, max(0, uploadProgress))).rounded())
        return "\(ByteCountFormatter.string(fromByteCount: uploadedBytes, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file))"
    }

    private var resolvingSurface: some View {
        Button(action: loadAndPlay) {
            ZStack {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
                Circle()
                    .fill(Color(uiColor: .systemBackground).opacity(0.9))
                    .frame(width: 56, height: 56)
                    .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
                    .overlay {
                        if isLoading {
                            ProgressView()
                                .controlSize(.large)
                                .tint(.secondary)
                        } else {
                            Image(systemName: loadFailed ? "arrow.clockwise" : "play.fill")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(.primary)
                        }
                    }
            }
            .frame(width: 244, height: 154)
            .compositingGroup()
            .clipShape(.rect(cornerRadius: 13))
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel(
            isLoading
                ? "Loading \(attachment.name)"
                : loadFailed ? "Retry loading \(attachment.name)" : "Play \(attachment.name)"
        )
    }

    private func loadAndPlay() {
        guard !isLoading else { return }
        if let player {
            player.play()
            return
        }
        isLoading = true
        loadFailed = false
        Task {
            guard let url = await onPrepare(attachment) else {
                isLoading = false
                loadFailed = true
                return
            }
            let asset = AVURLAsset(url: url)
            if let tracks = try? await asset.loadTracks(withMediaType: .video),
               let track = tracks.first,
               let naturalSize = try? await track.load(.naturalSize),
               let transform = try? await track.load(.preferredTransform) {
                let transformedSize = naturalSize.applying(transform)
                let width = abs(transformedSize.width)
                let height = abs(transformedSize.height)
                if width > 0, height > 0 {
                    posterAspectRatio = width / height
                }
            }
            let preparedPlayer = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            observePlaybackStart(preparedPlayer)
            player = preparedPlayer
            isLoading = false
            preparedPlayer.play()
        }
    }

    private func observePlaybackStart(_ player: AVPlayer) {
        clearPlaybackTimeObserver()
        playbackHasStarted = false
        playbackTimeObserver = player.addBoundaryTimeObserver(
            forTimes: [NSValue(time: CMTime(seconds: 0.05, preferredTimescale: 600))],
            queue: .main
        ) { [weak player] in
            playbackHasStarted = true
            if let observer = playbackTimeObserver {
                player?.removeTimeObserver(observer)
                playbackTimeObserver = nil
            }
        }
    }

    private func clearPlaybackTimeObserver() {
        guard let playbackTimeObserver else { return }
        player?.removeTimeObserver(playbackTimeObserver)
        self.playbackTimeObserver = nil
    }

    private var videoAspectRatio: CGFloat {
        resolvedVideoAspectRatio ?? 16 / 9
    }

    private var videoDisplaySize: CGSize {
        MessageImageInteraction.displaySize(
            for: attachment,
            decodedSize: poster?.size,
            defaultSize: CGSize(width: 244, height: 154),
            maximumWidth: 244,
            maximumHeight: 320
        )
    }

    private var resolvedVideoAspectRatio: CGFloat? {
        guard let width = attachment.widthPixels,
              let height = attachment.heightPixels,
              width > 0,
              height > 0 else { return posterAspectRatio }
        return VideoAttachmentLayout.aspectRatio(
            widthPixels: width,
            heightPixels: height
        )
    }
}

struct FullScreenMessageVideo: View {
    @Environment(\.dismiss) private var dismiss
    let player: AVPlayer
    let name: String
    let poster: UIImage?
    @State private var playbackHasStarted = false
    @State private var playbackTimeObserver: Any?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            NativeFullScreenVideoPlayer(player: player)
                .ignoresSafeArea()
                .accessibilityLabel("Play \(name)")
            if !playbackHasStarted {
                ZStack {
                    if let poster {
                        Image(uiImage: poster)
                            .resizable()
                            .scaledToFit()
                    } else {
                        Color(uiColor: .secondarySystemBackground)
                            .ignoresSafeArea()
                    }
                    Color.black.opacity(poster == nil ? 0 : 0.12)
                        .ignoresSafeArea()
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                }
                .allowsHitTesting(false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading \(name)")
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(.white)
                    .background(.black.opacity(0.62), in: Circle())
            }
            .buttonStyle(.plain)
            .padding(16)
            .accessibilityLabel("Exit full screen video")
        }
        .onAppear {
            observePlaybackStart()
            player.play()
        }
        .onDisappear {
            clearPlaybackTimeObserver()
            player.pause()
        }
    }

    private func observePlaybackStart() {
        clearPlaybackTimeObserver()
        playbackHasStarted = false
        let revealTime = CMTimeAdd(
            player.currentTime(),
            CMTime(seconds: 0.05, preferredTimescale: 600)
        )
        playbackTimeObserver = player.addBoundaryTimeObserver(
            forTimes: [NSValue(time: revealTime)],
            queue: .main
        ) { [weak player] in
            playbackHasStarted = true
            if let observer = playbackTimeObserver {
                player?.removeTimeObserver(observer)
                playbackTimeObserver = nil
            }
        }
    }

    private func clearPlaybackTimeObserver() {
        guard let playbackTimeObserver else { return }
        player.removeTimeObserver(playbackTimeObserver)
        self.playbackTimeObserver = nil
    }
}

enum MessageGestureArbitration {
    static func allowsSimultaneousRecognition(with recognizer: UIGestureRecognizer) -> Bool {
        !(recognizer is UIPanGestureRecognizer)
    }
}

private struct MessageInteractionGestureBridge: UIViewRepresentable {
    let minimumPressDuration: TimeInterval
    let isEnabled: Bool
    let onTap: (() -> Void)?
    let onLongPress: (CGRect) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> AttachmentView {
        let view = AttachmentView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        context.coordinator.attachmentView = view
        view.onSuperviewChange = { [weak coordinator = context.coordinator, weak view] in
            if let view { coordinator?.attachToEnclosingScrollView(from: view) }
        }
        return view
    }

    func updateUIView(_ uiView: AttachmentView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.updateMinimumPressDuration()
        context.coordinator.attachToEnclosingScrollView(from: uiView)
    }

    static func dismantleUIView(_ uiView: AttachmentView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class AttachmentView: UIView {
        var onSuperviewChange: (() -> Void)?

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            onSuperviewChange?()
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            onSuperviewChange?()
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: MessageInteractionGestureBridge
        weak var attachmentView: UIView?
        weak var targetView: UIView?

        private lazy var longPressRecognizer: UILongPressGestureRecognizer = {
            let recognizer = UILongPressGestureRecognizer(
                target: self,
                action: #selector(handleLongPress(_:))
            )
            recognizer.minimumPressDuration = parent.minimumPressDuration
            recognizer.allowableMovement = 10
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            return recognizer
        }()

        private lazy var tapRecognizer: UITapGestureRecognizer = {
            let recognizer = UITapGestureRecognizer(
                target: self,
                action: #selector(handleTap(_:))
            )
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            recognizer.require(toFail: longPressRecognizer)
            return recognizer
        }()

        init(parent: MessageInteractionGestureBridge) {
            self.parent = parent
            super.init()
        }

        func updateMinimumPressDuration() {
            longPressRecognizer.minimumPressDuration = parent.minimumPressDuration
        }

        func attachToEnclosingScrollView(from view: UIView) {
            var candidate = view.superview
            while let current = candidate {
                if let scrollView = current as? UIScrollView {
                    attach(to: scrollView)
                    return
                }
                candidate = current.superview
            }
        }

        private func attach(to view: UIView) {
            guard targetView !== view else { return }
            detach()
            targetView = view
            view.addGestureRecognizer(longPressRecognizer)
            view.addGestureRecognizer(tapRecognizer)
        }

        func detach() {
            targetView?.removeGestureRecognizer(longPressRecognizer)
            targetView?.removeGestureRecognizer(tapRecognizer)
            targetView = nil
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard parent.isEnabled,
                  let attachmentView,
                  let targetView else { return false }
            if gestureRecognizer === tapRecognizer, parent.onTap == nil { return false }
            let frame = attachmentView.convert(attachmentView.bounds, to: targetView)
            return frame.contains(gestureRecognizer.location(in: targetView))
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            MessageGestureArbitration.allowsSimultaneousRecognition(
                with: otherGestureRecognizer
            )
        }

        @objc private func handleLongPress(_ gestureRecognizer: UILongPressGestureRecognizer) {
            guard gestureRecognizer.state == .began,
                  let attachmentView,
                  let window = attachmentView.window else { return }
            let frame = attachmentView.convert(attachmentView.bounds, to: window)
            guard !frame.isEmpty else { return }
            parent.onLongPress(frame)
        }

        @objc private func handleTap(_ gestureRecognizer: UITapGestureRecognizer) {
            guard gestureRecognizer.state == .ended else { return }
            parent.onTap?()
        }
    }
}

private struct MessageImageAttachment: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let attachment: ChatAttachment
    let presentation: MessageImagePresentation
    let onOpen: (UIImage?) -> Void
    let onShare: () -> Void
    let onPrepare: (ChatAttachment) async -> URL?
    let onAddToMediaLibrary: (ChatAttachment) async -> ExpressiveMediaLibraryKind?
    let isActionTarget: Bool
    let onPrepareActions: () -> Void
    let onRequestActions: (CGRect) -> Void

    @State private var image: UIImage?
    @State private var loadedContentIdentity: String?
    @State private var isLoading = true
    @State private var loadFailed = false
    @State private var reloadToken = 0
    @State private var addedMediaKind: ExpressiveMediaLibraryKind?
    @State private var isAddingToMediaLibrary = false

    var body: some View {
        interactiveImage
        .background {
            MessageInteractionGestureBridge(
                minimumPressDuration: MessageBubble.actionLongPressDuration,
                isEnabled: !isActionTarget,
                onTap: opensPreview ? activate : nil,
                onLongPress: openActions
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: "\(attachment.id):\(reloadToken):\(reduceMotion)") {
            await loadImage()
        }
        .accessibilityLabel(
            attachment.subtype == .sticker
                ? "Sticker \(attachment.name)"
                : attachment.altText?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                    ?? (image == nil ? "Image attachment" : "Review image attachment")
        )
        .accessibilityHint(
            presentation.isStackPreview
                ? "Expands this image group."
                : loadFailed
                ? "Double tap to retry loading"
                : attachment.subtype == .sticker
                    ? "Touch and hold for sticker actions."
                    : "\(attachment.name). Touch and hold for image actions."
        )
        .accessibilityAddTraits(opensPreview ? .isButton : [])
        .accessibilityAction(.default) { activate() }
        .accessibilityAction(named: "Download or save to Files", onShare)
        .accessibilityActions {
            if mediaKind != nil {
                Button(mediaLibraryActionLabel, action: addToMediaLibrary)
            }
        }
        .sensoryFeedback(.success, trigger: addedMediaKind)
    }

    private var interactiveImage: some View {
        imageContent
            .contentShape(
                .contextMenuPreview,
                RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.2),
                value: loadedContentIdentity
            )
    }

    private var opensPreview: Bool {
        presentation.isStackPreview || MessageImageInteraction.opensPreview(for: attachment)
    }

    private func activate() {
        guard opensPreview else { return }
        if presentation.isStackPreview {
            onOpen(image)
        } else if loadFailed {
            reloadToken += 1
        } else if image != nil {
            onOpen(image)
        }
    }

    private func openActions(frame: CGRect) {
        onPrepareActions()
        onRequestActions(frame)
    }

    @ViewBuilder
    private var imageContent: some View {
        if let image {
            if presentation == .stackPreview {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: MessageImageMetrics.stackSide, height: MessageImageMetrics.stackSide)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .transition(.opacity)
            } else {
                let size = displaySize(for: image)
                if image.images?.count ?? 0 > 1, !reduceMotion {
                    AnimatedUIImage(image: image)
                        .frame(width: size.width, height: size.height)
                        .background(
                            AttachmentImageDecoder.hasTransparency(image)
                                ? Color.clear
                                : Color(uiColor: .secondarySystemBackground)
                        )
                        .compositingGroup()
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .transition(.opacity)
                } else {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: size.width, height: size.height)
                        .background(
                            AttachmentImageDecoder.hasTransparency(image)
                                ? Color.clear
                                : Color(uiColor: .secondarySystemBackground)
                        )
                        .compositingGroup()
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .transition(.opacity)
                }
            }
        } else {
            let size = presentation.displaySize(for: attachment)
            ZStack {
                if attachment.subtype != .sticker || !isLoading {
                    Color(uiColor: .secondarySystemBackground)
                }
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
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func loadImage() async {
        let contentIdentity = AttachmentImageDecoder.contentIdentity(attachment)
        if loadedContentIdentity != contentIdentity {
            image = nil
            loadedContentIdentity = nil
        }
        isLoading = image == nil
        loadFailed = false

        let isAnimatedGIF = MessageImageInteraction.isAnimatedGIF(attachment)
        if MessageImageInteraction.usesInlinePreview(for: attachment),
           let source = attachment.previewURL,
           let preview = await AvatarImageLoader.image(from: source) {
            guard !Task.isCancelled else { return }
            image = preview
            loadedContentIdentity = contentIdentity
            isLoading = false
            return
        }

        guard !attachment.attachmentId.hasPrefix("pending:"),
              let url = await onPrepare(attachment) else {
            guard !Task.isCancelled else { return }
            isLoading = false
            loadFailed = image == nil
            return
        }

        let shouldAnimateGIF = !reduceMotion
        let loaded = await Task.detached(priority: .utility) {
            isAnimatedGIF
                ? AnimatedImageDecoder.image(
                    at: url,
                    animated: shouldAnimateGIF,
                    maximumPixelSize: 512
                )
                : AttachmentImageDecoder.downsampledImage(at: url, maximumPixelSize: 1_200)
        }.value
        guard !Task.isCancelled else { return }
        if let loaded {
            image = loaded
            loadedContentIdentity = contentIdentity
        }
        isLoading = false
        loadFailed = image == nil
    }

    private func displaySize(for image: UIImage) -> CGSize {
        MessageImageInteraction.displaySize(
            for: attachment,
            decodedSize: image.size,
            defaultSize: presentation.placeholderSize,
            maximumWidth: presentation.maximumWidth,
            maximumHeight: presentation.maximumHeight
        )
    }

    private var mediaKind: ExpressiveMediaLibraryKind? {
        ExpressiveMediaLibraryKind.supportedKind(
            name: attachment.name,
            mimeType: attachment.mimeType
        )
    }

    private var mediaLibraryActionLabel: String {
        guard let mediaKind else { return "Add to media library" }
        return MessageImageInteraction.mediaLibraryActionLabel(
            for: attachment,
            libraryName: mediaKind.libraryName,
            isSaved: addedMediaKind == mediaKind
        )
    }

    private func addToMediaLibrary() {
        guard mediaKind != nil, !isAddingToMediaLibrary, addedMediaKind == nil else { return }
        isAddingToMediaLibrary = true
        Task {
            addedMediaKind = await onAddToMediaLibrary(attachment)
            isAddingToMediaLibrary = false
        }
    }
}

enum MessageImageInteraction {
    static let maximumPixelDimension = 100_000

    static func isAnimatedGIF(_ attachment: ChatAttachment) -> Bool {
        attachment.mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            == "image/gif"
            || URL(fileURLWithPath: attachment.name).pathExtension.lowercased() == "gif"
    }

    static func maximumDisplayDimension(for attachment: ChatAttachment) -> CGFloat? {
        attachment.subtype == .sticker || isAnimatedGIF(attachment) ? 180 : nil
    }

    static func placeholderSize(
        for attachment: ChatAttachment,
        defaultSize: CGSize
    ) -> CGSize {
        guard let maximum = maximumDisplayDimension(for: attachment) else { return defaultSize }
        return CGSize(width: maximum, height: maximum)
    }

    static func declaredPixelSize(for attachment: ChatAttachment) -> CGSize? {
        guard let width = attachment.widthPixels,
              let height = attachment.heightPixels,
              (1...maximumPixelDimension).contains(width),
              (1...maximumPixelDimension).contains(height) else { return nil }
        return CGSize(width: width, height: height)
    }

    static func displaySize(
        for attachment: ChatAttachment,
        decodedSize: CGSize?,
        defaultSize: CGSize,
        maximumWidth: CGFloat,
        maximumHeight: CGFloat
    ) -> CGSize {
        let source = declaredPixelSize(for: attachment) ?? decodedSize
        guard let source, source.width > 0, source.height > 0 else {
            return placeholderSize(for: attachment, defaultSize: defaultSize)
        }
        let ratio = min(2.4, max(0.42, source.width / source.height))
        let expressiveMaximum = maximumDisplayDimension(for: attachment)
        let boundedWidth = expressiveMaximum ?? maximumWidth
        let boundedHeight = expressiveMaximum ?? maximumHeight
        if ratio >= 1 {
            return CGSize(width: boundedWidth, height: boundedWidth / ratio)
        }
        let height = min(boundedHeight, boundedWidth / ratio)
        return CGSize(width: height * ratio, height: height)
    }

    static func usesInlinePreview(for attachment: ChatAttachment) -> Bool {
        !isAnimatedGIF(attachment) || attachment.attachmentId.hasPrefix("pending:")
    }

    static func stickerAttachment(
        in message: ChatMessage,
        matching knownStickerSignatures: Set<String> = []
    ) -> ChatAttachment? {
        if let explicit = message.attachments.first(where: { $0.subtype == .sticker }) {
            return explicit
        }
        if message.messageKind == "sticker" {
            return message.attachments.first(where: { $0.kind == .image })
        }
        guard message.attachments.count == 1,
              let attachment = message.attachments.first,
              attachment.kind == .image,
              let signature = ExpressiveMediaAttachmentSignature.value(
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes
              ),
              knownStickerSignatures.contains(signature) else { return nil }
        return attachment
    }

    static func markingKnownStickers(
        in messages: [ChatMessage],
        matching knownStickerSignatures: Set<String>
    ) -> [ChatMessage] {
        messages.map { message in
            guard let sticker = stickerAttachment(
                in: message,
                matching: knownStickerSignatures
            ), sticker.subtype != .sticker else { return message }
            var marked = message
            marked.messageKind = "sticker"
            marked.attachments = message.attachments.map { attachment in
                guard attachment.id == sticker.id else { return attachment }
                return ChatAttachment(
                    attachmentId: attachment.attachmentId,
                    name: attachment.name,
                    kind: attachment.kind,
                    subtype: .sticker,
                    altText: attachment.altText,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                    widthPixels: attachment.widthPixels,
                    heightPixels: attachment.heightPixels,
                    previewURL: attachment.previewURL
                )
            }
            return marked
        }
    }

    static func opensPreview(for attachment: ChatAttachment) -> Bool {
        attachment.subtype != .sticker
    }

    static func mediaLibraryActionLabel(
        for attachment: ChatAttachment,
        libraryName: String,
        isSaved: Bool
    ) -> String {
        if isSaved { return "Saved to \(libraryName)" }
        return attachment.subtype == .sticker
            ? "Save to \(libraryName)"
            : "Add to \(libraryName)"
    }
}

private enum MessageImagePresentation {
    case natural
    case groupedNatural
    case stackPreview

    var isStackPreview: Bool {
        if case .stackPreview = self { return true }
        return false
    }

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

    func placeholderSize(for attachment: ChatAttachment) -> CGSize {
        if isStackPreview { return placeholderSize }
        return MessageImageInteraction.displaySize(
            for: attachment,
            decodedSize: nil,
            defaultSize: placeholderSize,
            maximumWidth: maximumWidth,
            maximumHeight: maximumHeight
        )
    }

    func displaySize(for attachment: ChatAttachment) -> CGSize {
        placeholderSize(for: attachment)
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
    static func contentIdentity(_ attachment: ChatAttachment) -> String {
        [
            attachment.name,
            attachment.mimeType ?? "",
            attachment.sizeBytes.map(String.init) ?? "",
            attachment.widthPixels.map(String.init) ?? "",
            attachment.heightPixels.map(String.init) ?? "",
        ].joined(separator: "\u{0}")
    }

    static func hasTransparency(_ image: UIImage) -> Bool {
        guard let alphaInfo = (image.cgImage ?? image.images?.first?.cgImage)?.alphaInfo else {
            return false
        }
        switch alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return false
        default:
            return true
        }
    }

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

struct MessageDeliveryGlyph: View {
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
            return "Seen by \(readByCount)"
        }
        return state.label
    }
}
