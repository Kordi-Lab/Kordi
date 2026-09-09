import SwiftUI
import QuickLook
import UniformTypeIdentifiers
import UIKit

private struct ConversationTimelineRow: Identifiable {
    let id: String
    let offset: Int
    let message: ChatMessage
}

private struct CameraPhotoReview: Identifiable {
    let id = UUID()
    let image: UIImage
}

// Keep the source row in layout until both the server and the menu dismissal finish.
// Sync can remove it before the delete request returns (including catalog rebuilding).
struct MessageDeletionPresentation {
    let message: ChatMessage
    let precedingIDs: [String]
    let followingIDs: [String]
    var isConfirmed = false
    var isMenuDismissed = false
    var isSourceHidden = false

    init(message: ChatMessage, messages: [ChatMessage]) {
        self.message = message
        let index = messages.firstIndex(where: { $0.id == message.id }) ?? messages.endIndex
        precedingIDs = messages[..<index].map(\.id)
        followingIDs = index < messages.endIndex ? messages[(index + 1)...].map(\.id) : []
    }

    var canAnimateRemoval: Bool { isConfirmed && isMenuDismissed && !isSourceHidden }

    func retainingMessage(in messages: [ChatMessage]) -> [ChatMessage] {
        guard !messages.contains(where: { $0.id == message.id }) else { return messages }
        let indices = Dictionary(uniqueKeysWithValues: messages.enumerated().map { ($0.element.id, $0.offset) })
        let insertionIndex = followingIDs.lazy.compactMap { indices[$0] }.first
            ?? precedingIDs.reversed().lazy.compactMap { indices[$0].map { $0 + 1 } }.first
            ?? 0
        var result = messages
        result.insert(message, at: insertionIndex)
        return result
    }
}

enum ConversationThreadPresentationMode: Equatable {
    case navigation
    case inspector

    static func resolve(horizontalSizeClass: UserInterfaceSizeClass?) -> Self {
        horizontalSizeClass == .compact ? .navigation : .inspector
    }
}

enum ConversationThreadLoadPolicy {
    static func usesCachedTimeline(rootMessageID: String?, messageCount: Int) -> Bool {
        rootMessageID != nil && messageCount > 0
    }
}

private struct ConversationScrollAnchorPolicy: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                // Preserve the visible bottom during keyboard and input-view resizing.
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .defaultScrollAnchor(.bottom, for: .alignment)
        } else {
            // iOS 17 combines initial positioning, resize anchoring, and alignment.
            content.defaultScrollAnchor(.bottom)
        }
    }
}

private struct ConversationThreadPresentationModifier: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Binding var activeRootMessageID: String?
    let conversation: ConversationSummary
    let firstMessageID: String?
    let showsUnreadDivider: Bool
    let onNavigateThread: (String, String?) -> Void
    let onReplyInConversation: (MessageActionSource) -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        switch ConversationThreadPresentationMode.resolve(
            horizontalSizeClass: horizontalSizeClass
        ) {
        case .navigation:
            content.navigationDestination(item: $activeRootMessageID) { threadRootID in
                threadDestination(rootID: threadRootID)
            }
        case .inspector:
            content.inspector(isPresented: threadIsPresented) {
                if let threadRootID = activeRootMessageID {
                    threadContainer(rootID: threadRootID)
                        .inspectorColumnWidth(min: 320, ideal: 390, max: 480)
                }
            }
        }
    }

    private var threadIsPresented: Binding<Bool> {
        Binding(
            get: { activeRootMessageID != nil },
            set: { if !$0 { activeRootMessageID = nil } }
        )
    }

    private func threadContainer(rootID: String) -> some View {
        NavigationStack {
            threadDestination(rootID: rootID)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { activeRootMessageID = nil }
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func threadDestination(rootID: String) -> some View {
        ConversationView(
            conversation: conversation,
            initialMessageID: firstMessageID,
            showsThreadUnreadDivider: showsUnreadDivider,
            allowsCompanionPanel: false,
            showsNavigationChrome: false,
            scopedThreadRootMessageID: rootID,
            onNavigateThread: onNavigateThread,
            onReplyInConversation: { source in
                onReplyInConversation(source)
                activeRootMessageID = nil
            }
        )
        .id(rootID)
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("Thread")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }
}

enum ConversationIdentityResolver {
    static func current(
        _ initial: ConversationSummary,
        in conversations: [ConversationSummary]
    ) -> ConversationSummary {
        conversations.first(where: { $0.id == initial.id })
            ?? conversations.first(where: { $0.sessionId == initial.sessionId })
            ?? initial
    }

    static func loadingTaskID(for conversation: ConversationSummary) -> String {
        conversation.sessionId
    }
}

struct ConversationView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let initialConversation: ConversationSummary
    private let initialMessageID: String?
    private let showsThreadUnreadDivider: Bool
    private let companionContext: CompanionChatContext?
    private let linkedBackgroundSession: BackgroundAgentSession?
    private let allowsCompanionPanel: Bool
    private let showsNavigationChrome: Bool
    private let scopedThreadRootMessageID: String?
    private let onNavigateThread: ((String, String?) -> Void)?
    private let onReplyInConversation: ((MessageActionSource) -> Void)?
    private let onOpenSessionDetails: ((ConversationSummary) -> Void)?
    @State private var draft = ""
    @State private var isSending = false
    @State private var stagedMessageIDs: [String] = []
    @State private var visibleMessageLimit = ConversationTimelineWindow.initialLimit
    @State private var lastTimelineCount = 0
    @State private var isLoadingEarlier = false
    @State private var isAtBottom = false
    @State private var hasPositionedInitialTimeline = false
    @State private var initialViewport = ConversationInitialViewport.latest
    @State private var hasPreparedInitialViewport = false
    @State private var hasRevealedInitialViewport = false
    @State private var initialLoadFailed = false
    @State private var trackedMessageID: String?
    @State private var immediateBottomRequest = 0
    @State private var animateBottomScroll = false
    @State private var attachments: [PendingAttachment] = []
    @State private var photoGrouping: PhotoSendGrouping = .combined
    @State private var replySource: MessageActionSource?
    @State private var selectedMention: ComposerMentionTarget?
    @State private var isComposerFocused = false
    @State private var isExpressivePickerPresented = false
    @State private var shouldFollowLatestAfterInputSurfaceChange = false
    @State private var showFileImporter = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var cameraPhotoReview: CameraPhotoReview?
    @State private var videoReview: PendingAttachment?
    @State private var queuedVideoReviews: [PendingAttachment] = []
    @State private var isPreparingAttachments = false
    @State private var voiceRecorder = VoiceMessageRecorder()
    @State private var voiceGestureIntent = VoiceRecordingGestureIntent.hold
    @State private var previewURL: URL?
    @State private var mediaPreview: MediaPreviewPresentation?
    @State private var videoPreview: VideoPreviewPresentation?
    @State private var fullScreenVideoAttachmentID: String?
    @State private var liveShareURLs: [URL] = []
    @State private var showLiveShare = false
    @State private var shareItem: SharedFileItem?
    @State private var messageShareItem: SharedMessageItem?
    @State private var showSessionDetails = false
    @State private var authorProfileConversation: ConversationSummary?
    @State private var selectedBackgroundSession: BackgroundAgentSession?
    @State private var callJoinTask: Task<Void, Never>?
    @State private var showAgentModel = false
    @State private var highlightedMessageID: String?
    @State private var selectedMessageIDs = Set<String>()
    @State private var forwardRequest: MessageForwardRequest?
    @State private var detailsMessage: ChatMessage?
    @State private var pinTarget: ChatMessage?
    @State private var editTarget: ChatMessage?
    @State private var draftBeforeEditing = ""
    @State private var isEditingMessage = false
    @State private var pendingMessageDeletion: MessageDeletionPresentation?
    @State private var deleteCaptureFrames = MessageDeleteCaptureFrames()
    @State private var activeDeleteSnapshots: [MessageDeleteSnapshot] = []
    @State private var deleteReflowID: UUID?
    @State private var deleteReflowBaseline: [String: CGRect] = [:]
    @State private var deleteReflowOffsets: [String: CGFloat] = [:]
    @State private var messageMutationError: String?
    @State private var messageActionMessage: ChatMessage?
    @State private var messageActionFrame = CGRect.zero
    @State private var messageActionPreviewFrame = CGRect.zero
    @State private var messageActionAllowsTextSelection = true
    @State private var messageActionViewportFrame = CGRect.zero
    @State private var messageActionAttachment: ChatAttachment?
    @State private var selectedMessageText: String?
    @State private var messageActionFeedback = 0

    private var navigationBarVisibility: Visibility {
        showsNavigationChrome ? .visible : .automatic
    }
    private var messageMutationErrorPresented: Binding<Bool> {
        Binding(
            get: { messageMutationError != nil },
            set: { if !$0 { messageMutationError = nil } }
        )
    }
    @State private var forwardedDestination: ConversationSummary?
    @State private var selectedCompanionConversation: ConversationSummary?
    @State private var showsCompanionPanel = false
    @State private var showsProviderAuthentication = false
    @State private var hasOpenedCompanionPreview = false
    @State private var readPresentationID = UUID()
    @State private var isReadPresentationVisible = false
    @State private var isNavigatingToMention = false
    @State private var activeThreadRootMessageID: String?
    @State private var activeThreadFirstMessageID: String?
    @State private var activeThreadShowsUnreadDivider = false
    @State private var isNavigatingThread = false
    @State private var threadNavigationError: String?
    @State private var threadNotificationHandled = false
    @State private var threadNotificationAttempt = 0
    @State private var threadPageRetrySequence: Int64?
    @State private var pendingThreadMessageID: String?
    @State private var threadReturnMessageID: String?
    @State private var scrollPosition = ConversationScrollPosition()
    @State private var threadReturnScrollOffsetY: CGFloat?
    @State private var threadReturnWasAtBottom = false
    @State private var exactScrollRestoreRequest: ConversationScrollRestoreRequest?
    @State private var nextScrollRestoreRequest = 0
    @State private var isRestoringThreadPosition = false

    init(
        conversation: ConversationSummary,
        initialMessageID: String? = nil,
        showsThreadUnreadDivider: Bool = true,
        companionContext: CompanionChatContext? = nil,
        linkedBackgroundSession: BackgroundAgentSession? = nil,
        allowsCompanionPanel: Bool = true,
        showsNavigationChrome: Bool = true,
        scopedThreadRootMessageID: String? = nil,
        onNavigateThread: ((String, String?) -> Void)? = nil,
        onReplyInConversation: ((MessageActionSource) -> Void)? = nil,
        onOpenSessionDetails: ((ConversationSummary) -> Void)? = nil
    ) {
        initialConversation = conversation
        self.initialMessageID = initialMessageID
        self.showsThreadUnreadDivider = showsThreadUnreadDivider
        self.companionContext = companionContext
        self.linkedBackgroundSession = linkedBackgroundSession
        self.allowsCompanionPanel = allowsCompanionPanel
        self.showsNavigationChrome = showsNavigationChrome
        self.scopedThreadRootMessageID = scopedThreadRootMessageID
        self.onNavigateThread = onNavigateThread
        self.onReplyInConversation = onReplyInConversation
        self.onOpenSessionDetails = onOpenSessionDetails
    }

    /// Navigation can outlive a sync pass. Resolve the current summary by its
    /// stable id so title, participant names, and avatars update while the
    /// conversation is already open instead of requiring a back/reopen cycle.
    private var conversation: ConversationSummary {
        if let id = initialConversation.subsessionId, let snapshot = model.subsessions[id] {
            return snapshot.conversation
        }
        return ConversationIdentityResolver.current(
            initialConversation,
            in: model.conversations
        )
    }

    private var allMessages: [ChatMessage] {
        let current = ChatCallActivityTimeline.collapsingStatuses(in: model.messages(for: conversation))
        return pendingMessageDeletion?.retainingMessage(in: current) ?? current
    }
    private var threadProjection: MessageThreadProjection {
        MessageThreadProjection(messages: allMessages)
    }
    private var messages: [ChatMessage] {
        guard let scopedThreadRootMessageID else { return threadProjection.mainMessages }
        return threadProjection.thread(rootID: scopedThreadRootMessageID)?.messages ?? []
    }
    private var scopedThreadMessageAction: MessageActionMetadata? {
        guard let scopedThreadRootMessageID,
              let root = threadProjection.thread(rootID: scopedThreadRootMessageID)?.root else {
            return nil
        }
        return .thread(root.actionSource(sessionId: conversation.sessionId))
    }
    private var linkedBackgroundSessionState: BackgroundAgentSession.State? {
        linkedBackgroundSession?.resolvedState(in: model.conversations)
    }
    private var isWaitingForLinkedBackgroundSession: Bool {
        linkedBackgroundSessionState == .running && messages.isEmpty
    }
    private var mentionTargetRefreshID: [String] {
        [conversation.id] + ComposerMentionTargetCatalog.ownerAccountIDs(
            for: conversation,
            currentAccountID: model.account?.accountId ?? ""
        )
    }
    private let bottomAnchorID = "conversation-bottom"
    private let timelineVerticalInset: CGFloat = 14

    var body: some View {
        let renderedMessages = allMessages
        let projection = MessageThreadProjection(messages: renderedMessages)
        let threadReadCursors = model.threadReadCursors[conversation.sessionId]
        let timeline: [ChatMessage]
        if let scopedThreadRootMessageID {
            timeline = projection.thread(rootID: scopedThreadRootMessageID)?.messages ?? []
        } else {
            timeline = projection.mainMessages
        }
        let usesCachedThreadTimeline = ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: scopedThreadRootMessageID,
            messageCount: timeline.count
        )
        let showsTimeline = hasRevealedInitialViewport || usesCachedThreadTimeline
        let visibleTimeline = ConversationTimelineWindow.visibleMessages(
            in: timeline,
            limit: ConversationTimelineWindow.limitAfterAppending(
                currentLimit: visibleMessageLimit,
                oldCount: lastTimelineCount,
                newCount: timeline.count,
                isInitialViewportRevealed: hasRevealedInitialViewport
            )
        )
        let visibleTimelineRows = visibleTimeline.enumerated().map { offset, message in
            ConversationTimelineRow(
                id: model.timelineIdentity(for: message),
                offset: offset,
                message: message
            )
        }
        let firstVisibleTimelineIdentity = visibleTimelineRows.first?.id
        let previewActionMessageID: String?
        if model.isPreviewMode, ProcessInfo.processInfo.arguments.contains("--preview-message-delete-photo") {
            previewActionMessageID = visibleTimeline.last(where: { $0.id == "preview-captioned-images-own" })?.id
        } else if ProcessInfo.processInfo.arguments.contains("--preview-message-delete") {
            previewActionMessageID = visibleTimeline.last(where: { $0.id == "m5" })?.id
        } else {
            previewActionMessageID = visibleTimeline.last(where: {
                !$0.text.isEmpty && $0.attachments.isEmpty && !$0.isSystemNotice
            })?.id
        }
        let visibleStartIndex = timeline.count - visibleTimeline.count
        let messagesById = Dictionary(uniqueKeysWithValues: renderedMessages.map { ($0.id, $0) })
        let presentationStartIndex = max(timeline.startIndex, visibleStartIndex - 1)
        let timelinePresentation = ConversationTimelinePresentation.make(
            messages: Array(timeline[presentationStartIndex..<timeline.endIndex]),
            selfAccountId: model.account?.accountId,
            participants: conversation.groupParticipants
        )
        let sessionPin = model.sessionPinsByID[conversation.sessionId]
        let pinnedMessages = [
            (sessionPin?.privateMessageId, "private"),
            (sessionPin?.sharedMessageId, "shared"),
        ].compactMap { entry -> PinnedMessageItem? in
            let (messageID, scope) = entry
            guard let messageID, let message = messagesById[messageID] else { return nil }
            return PinnedMessageItem(message: message, scope: scope)
        }
        let pinnedMessageIDs = Set(pinnedMessages.map(\.message.id))
        let pinActivityText = sessionPin.flatMap { pinActivityText(for: $0) }
        let pinActivityID = "pin-activity:\(sessionPin?.lastAction?.updatedAt ?? pinActivityText ?? "")"
        let activeConversationCall = model.activeCall(for: conversation)
        let coordinatorOwnsConversationCall = callCoordinator.activeCall?.call.id
            == activeConversationCall?.id
        let mentionTargets = model.mentionTargets(for: conversation)
        let pendingMentionMessageIDs = Set(
            model.pendingMentionMessages(for: conversation).map(\.id)
        )
        let pendingMentionCount = model.pendingMentionCount(for: conversation)
        let newMessageCount = max(0, conversation.unreadCount)
        let pinTargetPresentation = Binding(
            get: { pinTarget != nil },
            set: { if !$0 { pinTarget = nil } }
        )
        let conversationTimeline = ScrollViewReader { proxy in
            let timelineContent = VStack(spacing: 0) {
                if !coordinatorOwnsConversationCall,
                   let activeCall = activeConversationCall,
                   activeCall.kind == .meeting {
                    ConversationCallBanner(
                        call: activeCall,
                        title: "Meeting in progress",
                        subtitle: ConversationCallBanner.connectedLabel(for: activeCall),
                        onJoin: { joinCall(activeCall) }
                    )
                } else if !coordinatorOwnsConversationCall,
                          let activeCall = activeConversationCall,
                          activeCall.state == .ringing,
                          activeCall.createdByAccountId != model.account?.accountId,
                          activeCall.participants.contains(where: {
                              $0.accountId == model.account?.accountId && $0.state == "invited"
                          }) {
                    ConversationCallBanner(
                        call: activeCall,
                        title: activeCall.kind == .video
                            ? "Incoming video call"
                            : "Incoming voice call",
                        subtitle: "\(conversation.displayName) is calling",
                        onJoin: { joinCall(activeCall) }
                    )
                }
                if !pinnedMessages.isEmpty {
                    PinnedMessageBar(
                        items: pinnedMessages,
                        onOpen: { item in
                            navigateToMessage(item.message.id, in: timeline, proxy: proxy)
                        },
                        onUnpin: { item in
                            Task {
                                _ = await model.unpin(
                                    item.message,
                                    in: conversation,
                                    scope: item.scope
                                )
                            }
                        }
                    )
                }
                if hasPreparedInitialViewport || usesCachedThreadTimeline {
                    ZStack {
                        GeometryReader { viewport in
                            ZStack(alignment: .bottomTrailing) {
                            // History pages retain their data, not every offscreen message view.
                            ScrollView {
                                LazyVStack(spacing: 0) {
                                    if timeline.isEmpty {
                                        EmptyConversation(
                                            conversation: conversation,
                                            backgroundSessionState: linkedBackgroundSession.map {
                                                $0.resolvedState(in: model.conversations)
                                            }
                                        )
                                            .padding(.top, 70)
                                    } else {
                                        if visibleStartIndex > 0 || model.hasEarlierMessages(for: conversation) {
                                            EarlierMessagesLoader(
                                                remainingCount: visibleStartIndex > 0 ? visibleStartIndex : nil,
                                                isLoading: isLoadingEarlier
                                            )
                                                .id("earlier:\(firstVisibleTimelineIdentity ?? conversation.id)")
                                                .onGeometryChange(for: Bool.self) { [isPositioned = hasPositionedInitialTimeline, viewportFrame = viewport.frame(in: .global)] geometry in
                                                    isPositioned && geometry.frame(in: .global).intersects(viewportFrame)
                                                } action: { isVisible in
                                                    guard isVisible else { return }
                                                    loadEarlierMessages(
                                                        preserving: firstVisibleTimelineIdentity,
                                                        totalCount: timeline.count,
                                                        proxy: proxy
                                                    )
                                                }
                                        }
                                        ForEach(visibleTimelineRows) { row in
                                            let message = row.message
                                            let index = visibleStartIndex + row.offset
                                            let presentation = timelinePresentation[index - presentationStartIndex]
                                            let thread = projection.threadsByRootID[message.id]
                                            let threadReplyCount = scopedThreadRootMessageID == nil
                                                ? projection.replyCount(rootID: message.id)
                                                : 0
                                            VStack(spacing: 0) {
                                                if scopedThreadRootMessageID != nil, showsThreadUnreadDivider, message.id == initialMessageID {
                                                    HStack { Rectangle().frame(height: 1); Text("New replies").font(.caption); Rectangle().frame(height: 1) }
                                                        .foregroundStyle(KordiTheme.signalBlue).padding(.vertical, 8)
                                                }
                                                timelineMessageRow(
                                                    row: row,
                                                    presentation: presentation,
                                                    timeline: timeline,
                                                    messagesByID: messagesById,
                                                    mentionTargets: mentionTargets,
                                                    isPendingMention: pendingMentionMessageIDs.contains(message.id),
                                                    pinnedMessageIDs: pinnedMessageIDs,
                                                    previewActionMessageID: previewActionMessageID,
                                                    threadReplyCount: threadReplyCount,
                                                    threadHasUnread: threadReadCursors.map { thread?.hasUnread(cursors: $0) ?? false } ?? false,
                                                    threadAgentState: thread?.agentState,
                                                    viewportFrame: viewport.frame(in: .global),
                                                    proxy: proxy
                                                )
                                            }
                                            #if DEBUG
                                            .background {
                                                if ConversationMotionProbeRegistry.enabled {
                                                    ConversationMotionProbe(id: row.id)
                                                }
                                            }
                                            #endif
                                            .accessibilityElement(children: .contain)
                                            .accessibilityIdentifier("message-\(message.id)")
                                            .opacity(pendingMessageDeletion?.message.id == message.id
                                                && pendingMessageDeletion?.isSourceHidden == true ? 0 : 1)
                                            .allowsHitTesting(pendingMessageDeletion?.message.id != message.id)
                                            .transition(.identity)
                                            .offset(y: deleteReflowOffsets[row.id] ?? 0)
                                            .background {
                                                Color.clear.onGeometryChange(for: CGRect.self) { [
                                                    tracksReflow = messageActionMessage != nil
                                                        || pendingMessageDeletion != nil || !activeDeleteSnapshots.isEmpty
                                                ] geometry in
                                                    tracksReflow ? geometry.frame(in: .global) : .zero
                                                } action: { frame in
                                                    if !frame.isEmpty { deleteCaptureFrames.rows[row.id] = frame }
                                                }
                                            }
                                            .zIndex(messageActionMessage?.id == message.id ? 1 : 0)
                                            .modifier(OutgoingMessageEntrance(
                                                pendingPosition: stagedMessageIDs.contains(message.clientMessageId ?? message.id)
                                            ))
                                        }
                                    }

                                        if let pinActivityText {
                                            SystemNoticeRow(text: pinActivityText)
                                                .padding(.vertical, 8)
                                                .id(pinActivityID)
                                        }

                                    Color.clear
                                        .frame(height: 1)
                                        .padding(.bottom, timelineVerticalInset)
                                        .id(bottomAnchorID)
                                }
                                .scrollTargetLayout()
                                .background(
                                    ConversationScrollCommandBridge(
                                        preservesReadingPosition: hasRevealedInitialViewport
                                            && stagedMessageIDs.isEmpty
                                            && messageActionMessage == nil
                                            && threadReturnMessageID == nil
                                            && threadReturnScrollOffsetY == nil,
                                        scrollToBottomRequest: immediateBottomRequest,
                                        animateBottomScroll: animateBottomScroll,
                                        reduceMotion: reduceMotion,
                                        exactRestoreRequest: $exactScrollRestoreRequest,
                                        onScrollGeometryChange: recordScrollGeometry,
                                        onTailPositioned: stagedMessageIDs.isEmpty ? nil : { [messageIDs = stagedMessageIDs] in
                                            stagedMessageIDs.removeAll { messageIDs.contains($0) }
                                            isAtBottom = true
                                            trackedMessageID = bottomAnchorID
                                        }
                                    )
                                )
                                .frame(
                                    minHeight: max(
                                        0,
                                        viewport.size.height - timelineVerticalInset
                                    ),
                                    alignment: timeline.isEmpty ? .top : .bottom
                                )
                                .padding(.horizontal, 12)
                                .padding(.top, timelineVerticalInset)
                            }
                            .modifier(ConversationOutgoingAvatarOverlay())
                            .modifier(ConversationScrollAnchorPolicy())
                            .scrollDismissesKeyboard(.interactively)
                            .scrollDisabled(messageActionMessage != nil)
                            .simultaneousGesture(
                                TapGesture().onEnded {
                                    dismissKeyboard()
                                    dismissComposerPickers()
                                }
                            )

                            VStack(spacing: 8) {
                                if pendingMentionCount > 0 {
                                    MentionNavigationButton(
                                        count: pendingMentionCount,
                                        isLoading: isNavigatingToMention,
                                        action: { navigateToNextMention(using: proxy) }
                                    )
                                    .transition(.scale(scale: 0.82).combined(with: .opacity))
                                }
                                if (model.threadAttentionBySession[conversation.sessionId]?.threadCount ?? 0) > 0 {
                                    ThreadNavigationButton(count: model.threadAttentionBySession[conversation.sessionId]?.threadCount ?? 0, isLoading: isNavigatingThread) {
                                        Task { await navigateToUnreadThread() }
                                    }
                                }
                                if ConversationTimelineScrollBehavior.shouldShowLatestButton(
                                    isAtBottom: isAtBottom,
                                    messageCount: timeline.count
                                ) {
                                    LatestMessageButton(count: newMessageCount) {
                                        scrollToBottom(animated: true)
                                    }
                                    #if DEBUG
                                    .background {
                                        if ConversationMotionProbeRegistry.enabled {
                                            ConversationMotionProbe(id: "latest-message-button")
                                        }
                                    }
                                    #endif
                                    .transition(.scale(scale: 0.82).combined(with: .opacity))
                                }
                            }
                            .padding(.trailing, 10)
                            .padding(.bottom, 16)
                            .animation(.snappy(duration: 0.2), value: pendingMentionCount)
                            .animation(.snappy(duration: 0.2), value: isAtBottom)
                        }

                            .opacity(showsTimeline ? 1 : 0)
                            .allowsHitTesting(showsTimeline)
                            .accessibilityHidden(!showsTimeline)
                        }
                        if !showsTimeline {
                            if initialLoadFailed {
                                ConversationInitialFailureView {
                                    initialLoadFailed = false
                                    Task {
                                        await loadAndRevealInitialConversation(using: proxy)
                                    }
                                }
                            } else {
                                ConversationInitialLoadingView(messages: visibleTimeline)
                            }
                        }
                    }
                } else {
                    ConversationInitialLoadingView(messages: visibleTimeline)
                }

                if selectedMessageIDs.isEmpty {
                    if !isWaitingForLinkedBackgroundSession {
                        ComposerView(
                            text: $draft,
                            attachments: $attachments,
                            photoGrouping: $photoGrouping,
                            replySource: $replySource,
                            editingMessage: editTarget,
                            selectedMention: $selectedMention,
                            isFocused: $isComposerFocused,
                            isExpressivePickerPresented: Binding(
                                get: { isExpressivePickerPresented },
                                set: { isPresented in
                                    if isPresented {
                                        shouldFollowLatestAfterInputSurfaceChange =
                                            ConversationTimelineScrollBehavior
                                                .shouldFollowLatestWhenPresentingInputSurface(
                                                    hasRevealedInitialViewport: hasRevealedInitialViewport,
                                                    wasAtLatest: ConversationTimelineScrollBehavior.isFollowingLatest(
                                                        isAtBottom: isAtBottom,
                                                        trackedMessageID: trackedMessageID,
                                                        bottomAnchorID: bottomAnchorID
                                                    ),
                                                    isPresented: true
                                                )
                                    }
                                    isExpressivePickerPresented = isPresented
                                }
                            ),
                            isAgentModelPickerPresented: $showAgentModel,
                            voiceGestureIntent: $voiceGestureIntent,
                            conversation: conversation,
                            mentionTargets: mentionTargets,
                            isSending: isSending || isEditingMessage,
                            isPreparingAttachments: isPreparingAttachments,
                            voiceRecorder: voiceRecorder,
                            destinationName: conversation.displayName,
                            cameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
                            onTakePhoto: {
                                dismissComposerPickers()
                                dismissKeyboard()
                                guard canPresentPhotoPicker() else { return }
                                showCamera = true
                            },
                            onChoosePhotos: presentPhotoLibrary,
                            onChooseFiles: { showFileImporter = true },
                            onSendExpressiveMedia: sendExpressiveMedia,
                            onSend: {
                                if let editTarget {
                                    saveMessageEdit(editTarget)
                                } else {
                                    Task { await send() }
                                }
                            },
                            onSendVoice: { Task { await sendVoiceMessage() } },
                            onCancelEdit: cancelMessageEdit
                        )
                    }
                } else {
                    ConversationSelectionBar(
                        count: selectedMessageIDs.count,
                        onCancel: { selectedMessageIDs.removeAll() },
                        onCopy: { copySelectedMessages(from: timeline) },
                        onForward: {
                            let selected = timeline.filter { selectedMessageIDs.contains($0.id) }
                            forwardRequest = MessageForwardRequest(
                                sourceConversation: conversation,
                                messages: selected
                            )
                        }
                    )
                }
            }
            let presentedTimeline = timelineContent
            .background(
                KordiChatWallpaper(theme: chatTheme)
                    .ignoresSafeArea(edges: .bottom)
            )
            .overlay {
                ForEach(activeDeleteSnapshots) { snapshot in
                    WindowOverlayPresenter(passthroughFrame: nil, allowsInteraction: false, animatesRemoval: false) { _ in
                        MessageDeleteParticleOverlay(
                            snapshot: snapshot, reduceMotion: reduceMotion,
                            onRemoveSource: {
                                guard pendingMessageDeletion?.message.id == snapshot.messageID else { return false }
                                deleteReflowID = snapshot.id
                                deleteReflowBaseline = deleteCaptureFrames.rows
                                var transaction = Transaction(animation: nil)
                                transaction.disablesAnimations = true
                                withTransaction(transaction) { pendingMessageDeletion = nil }
                                return true
                            },
                            onInstallOffsets: {
                                guard deleteReflowID == snapshot.id else { return false }
                                let offsets = MessageDeleteReflow.offsets(
                                    before: deleteReflowBaseline, after: deleteCaptureFrames.rows
                                )
                                var transaction = Transaction(animation: nil)
                                transaction.disablesAnimations = true
                                withTransaction(transaction) { deleteReflowOffsets = offsets }
                                return true
                            },
                            onAnimate: { duration in
                                guard deleteReflowID == snapshot.id else { return false }
                                withAnimation(.timingCurve(0.77, 0, 0.175, 1, duration: duration)) {
                                    deleteReflowOffsets.removeAll()
                                }
                                return true
                            },
                            onComplete: {
                                activeDeleteSnapshots.removeAll { $0.id == snapshot.id }
                                if deleteReflowID == snapshot.id {
                                    deleteReflowID = nil
                                    deleteReflowBaseline.removeAll()
                                    deleteReflowOffsets.removeAll()
                                }
                                animateConfirmedMessageDeletion()
                            }
                        )
                    }
                }
            }
            .overlay {
                if let messageActionMessage, !messageActionFrame.isEmpty {
                    messageActionsOverlay(
                        for: messageActionMessage,
                        pinnedMessageIDs: pinnedMessageIDs,
                        timeline: timeline
                    )
                }
            }
            .overlay {
                if voiceRecorder.phase == .recording, !voiceRecorder.isLocked {
                    VoiceHoldToTalkOverlay(
                        recorder: voiceRecorder,
                        gestureIntent: voiceGestureIntent
                    )
                    .transition(.opacity)
                }
            }
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.16),
                value: voiceRecorder.phase == .recording && !voiceRecorder.isLocked
            )
            #if DEBUG
            .onAppear {
                if ConversationMotionProbeRegistry.enabled {
                    ConversationMotionProbeRegistry.setDraft = { draft = $0 }
                    ConversationMotionProbeRegistry.send = { Task { await send() } }
                    ConversationMotionProbeRegistry.goToLatest = { scrollToBottom(animated: true) }
                }
            }
            #endif
            .sensoryFeedback(.selection, trigger: messageActionFeedback)
            .confirmationDialog(
                "Pin this message?",
                isPresented: pinTargetPresentation,
                titleVisibility: .visible,
                presenting: pinTarget
            ) { target in
                Button("Pin for me") {
                    pinMessage(target, shared: false)
                }
                Button("Pin for everyone") {
                    pinMessage(target, shared: true)
                }
                Button("Cancel", role: .cancel) {
                    pinTarget = nil
                }
            } message: { _ in
                Text("Pinned messages stay visible above this session on synced Kordi devices.")
            }
            let observedTimeline = presentedTimeline
            .onChange(of: timeline.count, initial: true) { oldCount, newCount in
                lastTimelineCount = newCount
                handleTimelineCountChange(oldCount: oldCount, newCount: newCount, proxy: proxy)
            }
            .onChange(of: pendingMentionCount) {
                synchronizeReadPresentation()
            }
            .onChange(of: timeline.last) { previousLatestMessage, currentLatestMessage in
                let previousLatestMessageID = previousLatestMessage.map(model.timelineIdentity(for:))
                let currentLatestMessageID = currentLatestMessage.map(model.timelineIdentity(for:))
                let isFollowingLatest = ConversationTimelineScrollBehavior.isFollowingLatest(
                    isAtBottom: isAtBottom,
                    trackedMessageID: trackedMessageID,
                    bottomAnchorID: bottomAnchorID
                )
                if ConversationTimelineScrollBehavior.shouldFollowLatest(
                    hasPositionedInitialTimeline: hasPositionedInitialTimeline,
                    isAtBottom: isFollowingLatest,
                    previousLatestMessageID: previousLatestMessageID,
                    currentLatestMessageID: currentLatestMessageID,
                    isDeletingLatestMessage: previousLatestMessage.map { previous in
                        activeDeleteSnapshots.contains { $0.messageID == previous.id }
                            && !timeline.contains { $0.id == previous.id }
                    } ?? false,
                    isNavigationReturnPending: threadReturnMessageID != nil
                        || threadReturnScrollOffsetY != nil
                ) {
                    // Insertion has already laid out the new row. A second scroll
                    // animation would replay the old position after its first paint.
                    scrollToBottom()
                }
            }
            .onChange(of: isExpressivePickerPresented) { _, isPresented in
                guard isPresented, shouldFollowLatestAfterInputSurfaceChange else {
                    if !isPresented { shouldFollowLatestAfterInputSurfaceChange = false }
                    return
                }
                Task { @MainActor in
                    let transitionDuration = reduceMotion
                        ? Duration.zero
                        : ComposerInputSurfaceMotion.duration
                    try? await Task.sleep(for: transitionDuration)
                    guard isExpressivePickerPresented,
                          shouldFollowLatestAfterInputSurfaceChange else { return }
                    isAtBottom = true
                    trackedMessageID = bottomAnchorID
                    scrollToBottom()
                    shouldFollowLatestAfterInputSurfaceChange = false
                }
            }
            .task(id: "thread-route:\(initialMessageID ?? ""):\(threadNotificationAttempt)") {
                guard scopedThreadRootMessageID == nil, let initialMessageID, !threadNotificationHandled else { return }
                threadNotificationHandled = true
                do {
                    let destination = try await model.loadThread(in: conversation, messageId: initialMessageID)
                    if destination.isThread {
                        activeThreadFirstMessageID = destination.first ?? destination.target
                        activeThreadShowsUnreadDivider = destination.first != nil
                        openThread(rootMessageID: destination.root)
                    } else { navigateToMessage(destination.root, in: messages, proxy: proxy) }
                } catch { threadNavigationError = "Could not open this message. Please retry."; threadNotificationHandled = false }
            }
            .onChange(of: pendingThreadMessageID) { _, messageID in
                guard let messageID else { return }
                navigateToMessage(messageID, in: messages, proxy: proxy)
                pendingThreadMessageID = nil
            }
            .onChange(of: activeThreadRootMessageID) { previousRootID, currentRootID in
                guard previousRootID != nil, currentRootID == nil else { return }
                restoreThreadReturnPosition(using: proxy)
            }
            .onChange(of: exactScrollRestoreRequest) { previousRequest, currentRequest in
                guard previousRequest != nil, currentRequest == nil else { return }
                threadReturnMessageID = nil
                threadReturnScrollOffsetY = nil
                threadReturnWasAtBottom = false
                isRestoringThreadPosition = false
            }
            observedTimeline
            .onAppear {
                restoreThreadReturnPosition(using: proxy)
            }
            .task(id: ConversationIdentityResolver.loadingTaskID(for: conversation)) {
                await loadAndRevealInitialConversation(using: proxy)
                guard !Task.isCancelled else { return }
                if conversation.subsessionId == nil { await model.refreshActiveCall(in: conversation) }
            }
        }
        return conversationTimeline
        .navigationTitle(showsNavigationChrome && messageActionMessage == nil ? conversation.displayName : "")
        .navigationBarTitleDisplayMode(.inline)
        .tint(chatTheme.accent)
        .toolbarBackground(.regularMaterial, for: .navigationBar)
        .toolbar(navigationBarVisibility, for: .navigationBar)
        .toolbar {
            if showsNavigationChrome, messageActionMessage == nil {
                if canOpenCompanionPanel {
                    if #available(iOS 26.0, *) {
                        ToolbarItem(placement: .topBarLeading) {
                            headerBalanceSpacer
                        }
                        .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .topBarLeading) {
                            headerBalanceSpacer
                        }
                    }
                }
                ToolbarItem(placement: .principal) {
                    conversationHeader
                        .accessibilityElement(children: .combine)
                }
                if #available(iOS 26.0, *) {
                    if canOpenCompanionPanel {
                        ToolbarItem(placement: .topBarTrailing) {
                            askAgentButton
                        }
                        .sharedBackgroundVisibility(.hidden)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if conversation.subsessionId == nil { sessionActionsButton }
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else {
                    if canOpenCompanionPanel {
                        ToolbarItem(placement: .topBarTrailing) {
                            askAgentButton
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if conversation.subsessionId == nil { sessionActionsButton }
                    }
                }
            }
        }
        .task(id: mentionTargetRefreshID) {
            await model.refreshMentionTargets(for: conversation)
        }
        .task {
            _ = await MessageDeleteParticleResources.prepared.value
        }
        .onDisappear {
            voiceRecorder.cancel()
            if !showsCompanionPanel {
                attachments.forEach { $0.discardOwnedFile() }
                attachments = []
            }
            callJoinTask?.cancel()
            callJoinTask = nil
            callCoordinator.cancelUnadmittedStart()
            pendingMessageDeletion = nil
            activeDeleteSnapshots.removeAll()
            deleteReflowID = nil
            deleteReflowBaseline.removeAll()
            deleteReflowOffsets.removeAll()
            deleteCaptureFrames.frames.removeAll()
            deleteCaptureFrames.rows.removeAll()
            isReadPresentationVisible = false
            synchronizeReadPresentation()
            rememberViewport(in: messages)
        }
        .onAppear {
            prepareInitialConversationForDisplay()
            isReadPresentationVisible = true
            synchronizeReadPresentation()
            if !conversation.kind.supportsQuotedReplies {
                replySource = nil
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-session-detail") {
                openSessionDetails()
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-agent-model")
                || ProcessInfo.processInfo.arguments.contains("--preview-contact-model") {
                Task { @MainActor in
                    await Task.yield()
                    showAgentModel = true
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-forward-message"),
               forwardRequest == nil,
               let message = messages.last {
                forwardRequest = MessageForwardRequest(
                    sourceConversation: conversation,
                    messages: [message]
                )
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-message-details"),
               detailsMessage == nil,
               let message = messages.last(where: { ($0.readByCount ?? 0) > 0 }) {
                detailsMessage = message
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-message-edit"),
               editTarget == nil,
               let message = messages.last(where: {
                   $0.author == .me && $0.cloudMessageVersion != nil
               }) {
                beginMessageEdit(message)
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-media"),
               mediaPreview == nil,
               let message = messages.first(where: { message in
                   message.attachments.contains(where: { $0.kind == .image })
               }),
               let attachment = message.attachments.first(where: { $0.kind == .image }) {
                openAttachment(attachment, from: message, in: messages, previewImage: nil)
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-photo-send"),
               !showPhotoPicker {
                showPhotoPicker = true
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-emoji-picker") {
                isExpressivePickerPresented = true
                isComposerFocused = true
            }
            openCompanionPreviewIfReady()
        }
        .onChange(of: canOpenCompanionPanel) { _, _ in
            openCompanionPreviewIfReady()
        }
        .task(id: "thread-reads:\(conversation.sessionId):\(model.account?.accountId ?? ""):\(scopedThreadRootMessageID ?? "main")") {
            guard conversation.subsessionId == nil else { return }
            while !Task.isCancelled {
                if scenePhase == .active, !threadProjection.threadsByRootID.isEmpty {
                    do {
                        try await model.refreshThreadReads(sessionId: conversation.sessionId)
                        if hasRevealedInitialViewport, isAtBottom,
                           let rootId = scopedThreadRootMessageID, let thread = threadProjection.thread(rootID: rootId) {
                            try await model.markThreadRead(sessionId: conversation.sessionId, thread: thread)
                        }
                    } catch {
                        // Keep confirmed cursors until a successful reconnect.
                    }
                }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
        .onChange(of: isAtBottom) { _, _ in
            synchronizeReadPresentation()
        }
        .onChange(of: hasRevealedInitialViewport) { _, _ in
            synchronizeReadPresentation()
        }
        .onChange(of: scenePhase) { _, _ in
            if scenePhase == .background {
                activeDeleteSnapshots.removeAll()
                deleteReflowID = nil
                deleteReflowBaseline.removeAll()
                deleteReflowOffsets.removeAll()
                if pendingMessageDeletion?.isSourceHidden == true { pendingMessageDeletion = nil }
            }
            if scenePhase != .active,
               [.recording, .paused].contains(voiceRecorder.phase) {
                voiceRecorder.stop()
            }
            synchronizeReadPresentation()
        }
        .onChange(of: conversation.id) { _, _ in
            voiceRecorder.cancel()
            videoReview?.discardOwnedFile()
            queuedVideoReviews.forEach { $0.discardOwnedFile() }
            cameraPhotoReview = nil
            videoReview = nil
            queuedVideoReviews = []
            videoPreview = nil
            fullScreenVideoAttachmentID = nil
            synchronizeReadPresentation()
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .fullScreenCover(isPresented: $showPhotoPicker) {
            PhotoLibrarySendPicker(
                allowsSeparateMessages: conversation.kind != .agent,
                onSend: sendPhotoSelection,
                onError: { model.errorMessage = $0 }
            )
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraCapturePicker(
                onImage: { image in
                    showCamera = false
                    presentCameraPhotoReview(image)
                },
                onVideo: { url in
                    showCamera = false
                    importCameraVideo(url)
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(item: $cameraPhotoReview) { review in
            CameraPhotoSendReviewSheet(
                sourceImage: review.image,
                onSend: sendCameraPhoto
            )
        }
        .fullScreenCover(item: $videoReview, onDismiss: presentNextVideoReview) { attachment in
            VideoSendReviewSheet(
                attachment: attachment,
                onCancel: cancelVideoReview,
                onSend: { await sendVideoReview(attachment) }
            )
        }
        .quickLookPreview($previewURL)
        .fullScreenCover(item: $mediaPreview) { presentation in
            MediaPreviewView(presentation: presentation)
        }
        .fullScreenCover(item: $videoPreview, onDismiss: {
            fullScreenVideoAttachmentID = nil
        }) { presentation in
            FullScreenMessageVideo(
                player: presentation.player,
                name: presentation.attachment.name,
                poster: presentation.poster
            )
        }
        .sheet(isPresented: $showLiveShare) { ActivityShareSheet(items: liveShareURLs) }
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: [item.url])
        }
        .sheet(item: $messageShareItem) { item in
            ActivityShareSheet(items: [item.item])
        }
        .navigationDestination(isPresented: $showSessionDetails) {
            SessionDetailView(conversation: conversation)
        }
        .navigationDestination(item: $authorProfileConversation) { destination in
            SessionDetailView(
                conversation: destination,
                presentationContext: .authorProfile(
                    sourceConversation: conversation,
                    destination: destination
                )
            )
        }
        .navigationDestination(item: $selectedBackgroundSession) { session in
            AgentSubsessionView(sessionId: session.sessionId)
        }
        .sheet(item: $forwardRequest) { request in
            ForwardMessageSheet(request: request) { destination in
                selectedMessageIDs.removeAll()
                forwardedDestination = destination
            }
        }
        .sheet(item: $detailsMessage) { message in
            MessageDetailsSheet(
                message: message,
                readers: MessageReadReceiptPresentation.readers(
                    for: message,
                    in: conversation
                )
            )
        }
        .alert(
            "Message action failed",
            isPresented: messageMutationErrorPresented
        ) {
            Button("OK") { messageMutationError = nil }
        } message: {
            Text(messageMutationError ?? "Please try again.")
        }
        .sheet(isPresented: $showsProviderAuthentication) {
            AccountSheet(openingAuthentication: true)
        }
        .alert("Could not open discussion", isPresented: Binding(get: { threadNavigationError != nil }, set: { if !$0 { threadNavigationError = nil } })) {
            Button("Retry") {
                if let root = scopedThreadRootMessageID, let sequence = threadPageRetrySequence {
                    Task { await loadMoreThreadReplies(root: root, after: sequence) }
                } else if initialMessageID != nil, scopedThreadRootMessageID == nil {
                    threadNotificationHandled = false; threadNotificationAttempt += 1
                } else { Task { await navigateToUnreadThread() } }
            }
            Button("Cancel", role: .cancel) { threadNavigationError = nil }
        } message: { Text(threadNavigationError ?? "") }
        .safeAreaInset(edge: .bottom) {
            if let root = scopedThreadRootMessageID, let next = model.threadNextPage[root] {
                Button("Load more replies") { Task { await loadMoreThreadReplies(root: root, after: next) } }
                    .disabled(isNavigatingThread).buttonStyle(.bordered).padding(8)
            }
        }
        .modifier(ConversationThreadPresentationModifier(
            activeRootMessageID: $activeThreadRootMessageID,
            conversation: conversation,
            firstMessageID: activeThreadFirstMessageID,
            showsUnreadDivider: activeThreadShowsUnreadDivider,
            onNavigateThread: { root, first in activeThreadShowsUnreadDivider = first != nil; activeThreadFirstMessageID = first; openThread(rootMessageID: root) },
            onReplyInConversation: { replySource = $0 }
        ))
        .navigationDestination(isPresented: $showsCompanionPanel) {
            CompanionChatPanel(
                selectedConversation: $selectedCompanionConversation,
                sourceConversation: conversation
            )
        }
        .navigationDestination(item: $forwardedDestination) { destination in
            ConversationView(conversation: destination)
        }
    }

    @ViewBuilder
    private func timelineMessageRow(
        row: ConversationTimelineRow,
        presentation: ConversationMessagePresentation,
        timeline: [ChatMessage],
        messagesByID: [String: ChatMessage],
        mentionTargets: [ComposerMentionTarget],
        isPendingMention: Bool,
        pinnedMessageIDs: Set<String>,
        previewActionMessageID: String?,
        threadReplyCount: Int,
        threadHasUnread: Bool,
        threadAgentState: BackgroundAgentSession.State?,
        viewportFrame: CGRect,
        proxy: ScrollViewProxy
    ) -> some View {
        let message = row.message
        let avatar = avatarIdentity(for: message)
        let backgroundSessions = message.backgroundAgentSessions.map {
            BackgroundAgentSessionPresentation(
                session: $0,
                state: $0.resolvedState(in: model.conversations)
            )
        }

        VStack(spacing: 0) {
            if presentation.showsTimestamp {
                ConversationTimestampDivider(date: message.createdAt)
            }

            if message.isSystemNotice {
                SystemNoticeRow(text: message.text)
                    .padding(.vertical, 8)
            } else {
                MessageBubble(
                    message: message,
                    mentionTargets: mentionTargets,
                    showAuthor: message.author == .agent
                        || (conversation.kind == .group
                            && message.author == .person
                            && !presentation.groupedWithPrevious),
                    showAvatar: presentation.showsAvatar,
                    replySourceMessage: message.quotedReplyMessageId.flatMap { messagesByID[$0] },
                    isHighlighted: highlightedMessageID == message.id,
                    isActionPresented: messageActionMessage?.id == message.id,
                    pendingSendEntrance: stagedMessageIDs.contains(message.clientMessageId ?? message.id),
                    outgoingAvatarGroupID: presentation.outgoingAvatarGroupID,
                    actionPlacement: messageActionMessage?.id == message.id && !messageActionPreviewFrame.isEmpty
                        ? MessageActionBubblePlacement(sourceFrame: messageActionFrame, previewFrame: messageActionPreviewFrame)
                        : nil,
                    actionViewportFrame: viewportFrame,
                    isPinned: pinnedMessageIDs.contains(message.id),
                    selectionMode: !selectedMessageIDs.isEmpty,
                    isSelected: selectedMessageIDs.contains(message.id),
                    allowsQuotedReplies: conversation.kind.supportsQuotedReplies,
                    threadReplyCount: threadReplyCount,
                    threadHasUnread: threadHasUnread,
                    threadAgentState: threadAgentState,
                    showsAvatarSlot: message.author != .agent,
                    authorAvatarName: avatar.name,
                    authorAvatarSource: avatar.source,
                    authorAvatarSeed: avatar.seed,
                    ownAccountId: model.account?.accountId,
                    automaticallyPresentsActions: (
                        ProcessInfo.processInfo.arguments.contains("--preview-message-actions")
                            || ProcessInfo.processInfo.arguments.contains("--preview-message-delete")
                            || (model.isPreviewMode && ProcessInfo.processInfo.arguments.contains("--preview-message-delete-photo"))
                    )
                        && message.id == previewActionMessageID,
                    backgroundSessions: backgroundSessions,
                    fullScreenVideoAttachmentID: message.attachments.contains {
                        $0.id == fullScreenVideoAttachmentID
                    } ? fullScreenVideoAttachmentID : nil,
                    onOpenAuthorProfile: {
                        authorProfileConversation = ConversationAuthorProfileResolver.destination(
                            currentConversation: conversation,
                            message: message,
                            selfAccountID: model.account?.accountId,
                            contacts: model.contacts,
                            conversations: model.conversations
                        )
                    },
                    onOpenMentionProfile: openMentionProfile,
                    onRetry: {
                        await model.retry(message, in: conversation)
                    },
                    onSelect: { toggleSelection(message.id) },
                    onOpenActions: { frame, attachment in
                        presentMessageActions(
                            message,
                            attachment: attachment,
                            frame: frame,
                            viewportFrame: viewportFrame
                        )
                    },
                    onSelectedTextChange: { selectedMessageText = $0 },
                    onReact: { reaction in
                        Task {
                            _ = await model.toggleReaction(
                                reaction,
                                on: message,
                                in: conversation
                            )
                        }
                    },
                    onNavigateToReply: { messageId in
                        navigateToMessage(messageId, in: timeline, proxy: proxy)
                    },
                    onOpenThread: {
                        openThread(rootMessageID: message.id)
                    },
                    onOpenAttachment: { attachment, previewImage in
                        openAttachment(
                            attachment,
                            from: message,
                            in: timeline,
                            previewImage: previewImage
                        )
                    },
                    onShareAttachment: { attachment in
                        prepare(attachment, forSharing: true)
                    },
                    onPrepareVoiceMessage: { voiceMessage in
                        await model.prepareVoiceMessageForPresentation(voiceMessage)
                    },
                    onPrepareAttachment: { attachment in
                        await model.prepareAttachmentForPresentation(attachment)
                    },
                    onPrepareAttachmentPreview: { attachment in
                        await model.prepareAttachmentPreviewImage(attachment)
                    },
                    onOpenVideo: { attachment, player, poster in
                        let videoPresentation = VideoPreviewPresentation(
                            attachment: attachment,
                            inlinePlayer: player,
                            poster: poster
                        )
                        player.pause()
                        fullScreenVideoAttachmentID = attachment.id
                        Task { @MainActor in
                            await Task.yield()
                            guard fullScreenVideoAttachmentID == attachment.id else { return }
                            videoPreview = videoPresentation
                        }
                    },
                    onAddAttachmentToMediaLibrary: { attachment in
                        await model.addAttachmentToExpressiveMediaLibrary(attachment)
                    },
                    onOpenBackgroundSession: { session in
                        selectedBackgroundSession = session
                    },
                    onAgentExecutionExpansionChange: { expanded in
                        guard expanded else { return }
                        revealExpandedAgentExecution(row.id, using: proxy)
                    }
                )
                .equatable()
                .background(alignment: .bottomTrailing) {
                    if presentation.showsAvatar, let groupID = presentation.outgoingAvatarGroupID {
                        ConversationOutgoingAvatarAnchorView(
                            groupID: groupID, name: avatar.name, source: avatar.source,
                            seed: avatar.seed ?? avatar.name,
                            isPositionPending: stagedMessageIDs.contains(message.clientMessageId ?? message.id)
                        )
                        .padding(.bottom, 2)
                    }
                }
                .padding(.top, presentation.groupedWithPrevious ? 2 : 7)
                .padding(.bottom, presentation.groupedWithNext ? 0 : 2)
                .onGeometryChange(for: CGRect.self) { [
                    tracksCapture = messageActionMessage?.id == message.id
                        || pendingMessageDeletion?.message.id == message.id
                ] geometry in
                    tracksCapture ? geometry.frame(in: .global) : .zero
                } action: { frame in
                    if !frame.isEmpty { deleteCaptureFrames.frames[message.id] = frame }
                }
            }
        }
        .id(row.id)
        .modifier(MentionPresentationModifier(isPending: scopedThreadRootMessageID != nil && scenePhase == .active && message.author != .me, viewportFrame: viewportFrame) {
            guard let root = scopedThreadRootMessageID, let thread = threadProjection.thread(rootID: root),
                  let sequence = message.conversationSequence else { return }
            Task { try? await model.markThreadRead(sessionId: conversation.sessionId, thread: thread, through: sequence) }
        })
        .modifier(MentionPresentationModifier(isPending: isPendingMention, viewportFrame: viewportFrame) {
            Task { await model.markMentionPresented(message, in: conversation) }
        })
    }

    private func handleTimelineCountChange(
        oldCount: Int,
        newCount: Int,
        proxy: ScrollViewProxy
    ) {
        visibleMessageLimit = ConversationTimelineWindow.limitAfterAppending(
            currentLimit: visibleMessageLimit,
            oldCount: oldCount,
            newCount: newCount,
            isInitialViewportRevealed: hasRevealedInitialViewport
        )
        if oldCount == 0, newCount > 0, !hasRevealedInitialViewport {
            Task { await positionAndRevealInitialViewport(using: proxy) }
        }
    }

    private func messageActionsOverlay(
        for message: ChatMessage,
        pinnedMessageIDs: Set<String>,
        timeline: [ChatMessage]
    ) -> some View {
        let readReceiptReaders = MessageReadReceiptPresentation.readers(
            for: message,
            in: conversation
        )
        return WindowOverlayPresenter(
            passthroughFrame: messageActionAllowsTextSelection && messageActionAttachment == nil && !message.text.isEmpty
                ? (messageActionPreviewFrame.isEmpty ? messageActionFrame : messageActionPreviewFrame)
                : nil,
            onDismissComplete: {
                Task { @MainActor in
                    guard pendingMessageDeletion?.message.id == message.id else { return }
                    pendingMessageDeletion?.isMenuDismissed = true
                    animateConfirmedMessageDeletion()
                }
            }
        ) { usableFrame in
            MessageActionOverlay(
                message: message,
                sourceFrame: messageActionFrame,
                usableFrame: messageActionViewportFrame.isEmpty ? usableFrame : messageActionViewportFrame,
                onPreviewFrameChange: { frame, allowsTextSelection in
                    guard messageActionMessage?.id == message.id, !frame.isEmpty else { return }
                    if messageActionPreviewFrame != frame { messageActionPreviewFrame = frame }
                    if messageActionAllowsTextSelection != allowsTextSelection {
                        messageActionAllowsTextSelection = allowsTextSelection
                    }
                },
                ownAccountId: model.account?.accountId,
                allowsConversationReply: conversation.kind.supportsQuotedReplies,
                allowsThreadReply: scopedThreadRootMessageID == nil
                    && conversation.subsessionId == nil
                    && conversation.kind.supportsThreadedReplies
                    && !message.isSystemNotice,
                allowsReactions: conversation.subsessionId == nil && MessageBubble.allowsReactions(
                    for: message,
                    isPreviewMode: model.isPreviewMode
                ),
                allowsEdit: message.author == .me
                    && !message.isSystemNotice
                    && !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && !["voice", "sticker", "call"].contains(message.messageKind?.lowercased() ?? "")
                    && message.cloudMessageVersion != nil
                    && message.reactionTargetMessageId?.nonEmpty != nil,
                allowsDelete: model.isPreviewMode
                    ? !message.isSystemNotice
                    : message.author != .agent
                        && !message.isSystemNotice
                        && message.deliveryState != .sending
                        && message.deliveryState != .failed
                        && message.reactionTargetMessageId?.nonEmpty != nil,
                deleteForEveryoneLabel: conversation.kind == .group
                    ? "Delete for everyone"
                    : "Delete for me and \(conversation.displayName)",
                isPinned: pinnedMessageIDs.contains(message.id),
                mediaAttachment: messageActionAttachment,
                readReceiptLabel: MessageReadReceiptPresentation.label(
                    for: message,
                    readers: readReceiptReaders
                ),
                readReceiptReaders: readReceiptReaders,
                onDismiss: dismissMessageActions,
                onReviewAttachment: {
                    guard let attachment = messageActionAttachment else { return }
                    dismissMessageActions()
                    openAttachment(attachment, from: message, in: timeline, previewImage: nil)
                },
                onShareAttachment: {
                    guard let attachment = messageActionAttachment else { return }
                    dismissMessageActions()
                    prepare(attachment, forSharing: true)
                },
                onAddAttachmentToMediaLibrary: {
                    guard let attachment = messageActionAttachment else { return }
                    dismissMessageActions()
                    Task { _ = await model.addAttachmentToExpressiveMediaLibrary(attachment) }
                },
                onReact: { reaction in
                    dismissMessageActions()
                    Task { _ = await model.toggleReaction(reaction, on: message, in: conversation) }
                },
                onReply: { destination in
                    let source = destination == .thread
                        ? MessageThreadProjection.rootSource(
                            for: message,
                            sessionID: conversation.sessionId
                        )
                        : message.actionSource(sessionId: conversation.sessionId)
                    if destination == .conversation,
                       scopedThreadRootMessageID != nil,
                       let onReplyInConversation {
                        onReplyInConversation(source)
                    } else if destination == .thread,
                              scopedThreadRootMessageID == nil {
                        dismissMessageActions()
                        Task { @MainActor in
                            await Task.yield()
                            openThread(rootMessageID: source.sourceMessageId)
                        }
                        return
                    } else {
                        replySource = source
                    }
                    dismissMessageActions()
                },
                onPin: {
                    if pinnedMessageIDs.contains(message.id) {
                        Task { _ = await model.unpin(message, in: conversation) }
                    } else {
                        pinTarget = message
                    }
                    dismissMessageActions()
                },
                onCopy: {
                    UIPasteboard.general.string = selectedMessageText?.nonEmpty ?? message.text
                    dismissMessageActions()
                },
                onShareMessage: {
                    let text = (selectedMessageText?.nonEmpty ?? message.text)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    messageShareItem = SharedMessageItem(
                        item: KordiMarkdownParser.safeExternalURL(text) ?? text
                    )
                    dismissMessageActions()
                },
                onForward: {
                    forwardRequest = MessageForwardRequest(
                        sourceConversation: conversation,
                        messages: [message]
                    )
                    dismissMessageActions()
                },
                onEdit: {
                    beginMessageEdit(message)
                    dismissMessageActions()
                },
                onDelete: { forEveryone in
                    deleteMessage(message, forEveryone: forEveryone)
                },
                onSaveSticker: { attachment in
                    dismissMessageActions()
                    Task { _ = await model.addAttachmentToExpressiveMediaLibrary(attachment) }
                },
                onSelect: {
                    toggleSelection(message.id)
                    dismissMessageActions()
                }
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func joinCall(_ call: CloudCall) {
        callJoinTask?.cancel()
        callJoinTask = Task {
            await callCoordinator.join(call, in: conversation)
        }
    }

    private func presentMessageActions(
        _ message: ChatMessage,
        attachment: ChatAttachment?,
        frame: CGRect,
        viewportFrame: CGRect
    ) {
        guard !frame.isEmpty else { return }
        if messageActionMessage?.id == message.id {
            // Geometry updates for the active message must not restart presentation,
            // dismiss the keyboard again, or replay the haptic.
            if messageActionFrame != frame { messageActionFrame = frame }
            if messageActionViewportFrame != viewportFrame { messageActionViewportFrame = viewportFrame }
            return
        }
        if activeDeleteSnapshots.isEmpty, pendingMessageDeletion == nil {
            deleteCaptureFrames.frames.removeAll(keepingCapacity: true)
            deleteCaptureFrames.rows.removeAll(keepingCapacity: true)
        }
        messageActionPreviewFrame = frame
        messageActionAllowsTextSelection = true
        messageActionViewportFrame = viewportFrame
        messageActionFrame = frame
        let selectedAttachment = attachment
            ?? message.attachments.first(where: { $0.kind == .image })
        let stickerAttachment = MessageImageInteraction.stickerAttachment(in: message)
        messageActionAttachment = selectedAttachment?.id == stickerAttachment?.id
            ? nil
            : selectedAttachment
        selectedMessageText = nil
        isComposerFocused = false
        dismissComposerPickers()
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
            messageActionMessage = message
        }
        messageActionFeedback += 1
    }

    private func dismissMessageActions() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
            messageActionMessage = nil
        }
        // Retain the last geometry while the window overlay fades out.
        messageActionAttachment = nil
        selectedMessageText = nil
    }

    private func navigateToMessage(
        _ messageID: String,
        in timeline: [ChatMessage],
        proxy: ScrollViewProxy
    ) {
        guard let sourceIndex = timeline.firstIndex(where: { $0.id == messageID }) else { return }
        let targetIdentity = model.timelineIdentity(for: timeline[sourceIndex])
        visibleMessageLimit = max(visibleMessageLimit, timeline.count - sourceIndex)
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            withAnimation(.easeInOut(duration: 0.24)) {
                proxy.scrollTo(targetIdentity, anchor: .center)
            }
            withAnimation(.snappy(duration: 0.2)) {
                highlightedMessageID = messageID
            }
            try? await Task.sleep(for: .seconds(1.5))
            guard highlightedMessageID == messageID else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                highlightedMessageID = nil
            }
        }
    }

    private func navigateToNextMention(using proxy: ScrollViewProxy) {
        guard !isNavigatingToMention else { return }
        isNavigatingToMention = true
        Task { @MainActor in
            defer { isNavigatingToMention = false }

            while model.hasEarlierMessages(for: conversation),
                  let oldestSequence = messages.compactMap(\.conversationSequence).min(),
                  oldestSequence > conversation.lastReadSequence {
                let previousCount = messages.count
                await model.loadEarlierMessages(for: conversation)
                guard messages.count > previousCount else { break }
            }

            guard let target = model.pendingMentionMessages(for: conversation).first,
                  let sourceIndex = messages.firstIndex(where: { $0.id == target.id }) else {
                return
            }
            let targetIdentity = model.timelineIdentity(for: messages[sourceIndex])
            visibleMessageLimit = max(visibleMessageLimit, messages.count - sourceIndex)
            await Task.yield()
            await Task.yield()
            if reduceMotion {
                proxy.scrollTo(targetIdentity, anchor: .center)
            } else {
                withAnimation(.easeInOut(duration: 0.24)) {
                    proxy.scrollTo(targetIdentity, anchor: .center)
                }
            }
            highlightReferencedMessage(target.id)
            await Task.yield()
            await model.markMentionPresented(target, in: conversation)
        }
    }

    private func revealExpandedAgentExecution(
        _ messageID: String,
        using proxy: ScrollViewProxy
    ) {
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            if reduceMotion {
                proxy.scrollTo(messageID, anchor: .bottom)
            } else {
                withAnimation(.easeInOut(duration: 0.24)) {
                    proxy.scrollTo(messageID, anchor: .bottom)
                }
            }
        }
    }

    private func toggleSelection(_ messageID: String) {
        if selectedMessageIDs.contains(messageID) {
            selectedMessageIDs.remove(messageID)
        } else {
            selectedMessageIDs.insert(messageID)
        }
    }

    private func copySelectedMessages(from timeline: [ChatMessage]) {
        let text = timeline
            .filter { selectedMessageIDs.contains($0.id) }
            .map { "\($0.authorName) · \($0.createdAt.formatted(date: .omitted, time: .shortened))\n\($0.text)" }
            .joined(separator: "\n\n")
        UIPasteboard.general.string = text
    }

    private func pinMessage(_ target: ChatMessage, shared: Bool) {
        pinTarget = nil
        Task { _ = await model.pin(target, in: conversation, shared: shared) }
    }

    private func saveMessageEdit(_ target: ChatMessage) {
        guard !isEditingMessage else { return }
        isEditingMessage = true
        Task {
            let succeeded = await model.editMessage(
                target,
                text: draft,
                in: conversation
            )
            isEditingMessage = false
            if succeeded {
                draft = draftBeforeEditing
                draftBeforeEditing = ""
                editTarget = nil
            } else {
                messageMutationError = model.errorMessage ?? "Could not edit this message."
            }
        }
    }

    private func beginMessageEdit(_ target: ChatMessage) {
        if editTarget == nil { draftBeforeEditing = draft }
        draft = target.text
        editTarget = target
        isExpressivePickerPresented = false
        showAgentModel = false
        isComposerFocused = true
    }

    private func cancelMessageEdit() {
        guard !isEditingMessage else { return }
        draft = draftBeforeEditing
        draftBeforeEditing = ""
        editTarget = nil
    }

    private func deleteMessage(_ target: ChatMessage, forEveryone: Bool) {
        guard pendingMessageDeletion == nil else { return }
        pendingMessageDeletion = MessageDeletionPresentation(message: target, messages: allMessages)
        dismissMessageActions()
        Task {
            let succeeded = await model.deleteMessage(target, forEveryone: forEveryone, in: conversation)
            guard pendingMessageDeletion?.message.id == target.id else { return }
            if succeeded {
                if editTarget?.reactionTargetMessageId == target.reactionTargetMessageId {
                    cancelMessageEdit()
                }
                pendingMessageDeletion?.isConfirmed = true
                animateConfirmedMessageDeletion()
            } else {
                // The authoritative row stays visible on failure; do not animate a deletion.
                pendingMessageDeletion = nil
                messageMutationError = model.errorMessage ?? "Could not delete this message."
            }
        }
    }

    private func animateConfirmedMessageDeletion() {
        guard deleteReflowID == nil,
              let deletion = pendingMessageDeletion, deletion.canAnimateRemoval else { return }
        guard scenePhase == .active else { pendingMessageDeletion = nil; return }
        guard let frame = deleteCaptureFrames.frames[deletion.message.id],
              let snapshot = MessageDeleteSnapshot.capture(messageID: deletion.message.id, frame: frame) else {
            pendingMessageDeletion = nil
            return
        }
        // Keep layout stationary while capturing the background behind the hidden row.
        // The particle surface starts removal and reflow together once its transparent
        // texture is ready. No wallpaper rectangle moves over neighboring messages.
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            activeDeleteSnapshots.append(snapshot)
            pendingMessageDeletion?.isSourceHidden = true
        }
    }

    private func pinActivityText(for pin: CloudSessionPin) -> String? {
        guard let action = pin.lastAction else { return nil }
        let actor: String
        if action.updatedByAccountId == model.account?.accountId {
            actor = "You"
        } else if let accountID = action.updatedByAccountId,
                  let participant = conversation.groupParticipants.first(where: {
                      $0.accountId == accountID
                  }) {
            actor = participant.displayName
        } else if action.updatedByAccountId == conversation.peerAccountId {
            actor = conversation.displayName
        } else if action.scope == "private" {
            actor = "You"
        } else {
            actor = "Someone"
        }
        return "\(actor) \(action.kind) a message"
    }

    private func openMentionProfile(accountID: String) {
        if conversation.kind == .person, conversation.peerAccountId == accountID {
            authorProfileConversation = conversation
            return
        }
        guard let participant = conversation.groupParticipants.first(where: {
            $0.accountId == accountID
        }) else { return }
        authorProfileConversation = ConversationAuthorProfileResolver.destination(
            currentConversation: conversation,
            participant: participant,
            selfAccountID: model.account?.accountId,
            contacts: model.contacts,
            conversations: model.conversations
        )
    }

    private func loadEarlierMessages(
        preserving anchorID: String?,
        totalCount: Int,
        proxy: ScrollViewProxy
    ) {
        guard !isLoadingEarlier,
              visibleMessageLimit < totalCount || model.hasEarlierMessages(for: conversation),
              let anchorID else { return }
        isLoadingEarlier = true
        Task { @MainActor in
            if visibleMessageLimit < totalCount {
                visibleMessageLimit = ConversationTimelineWindow.limitAfterLoadingEarlier(
                    currentLimit: visibleMessageLimit,
                    totalCount: totalCount
                )
            } else {
                await model.loadEarlierMessages(for: conversation)
                visibleMessageLimit = ConversationTimelineWindow.limitAfterLoadingEarlier(
                    currentLimit: visibleMessageLimit,
                    totalCount: messages.count
                )
            }
            await Task.yield()
            proxy.scrollTo(anchorID, anchor: .top)
            isLoadingEarlier = false
        }
    }

    private func scrollToBottom(animated: Bool = false) {
        animateBottomScroll = animated && !reduceMotion
        immediateBottomRequest &+= 1
        initialViewport = .latest
        hasPositionedInitialTimeline = true
        trackedMessageID = bottomAnchorID
    }

    @MainActor
    private func positionAndRevealInitialViewport(using proxy: ScrollViewProxy) async {
        guard hasPreparedInitialViewport, !hasPositionedInitialTimeline else { return }
        await Task.yield()
        await Task.yield()

        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            switch initialViewport {
            case .latest:
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            case let .offset(contentOffsetY):
                nextScrollRestoreRequest &+= 1
                exactScrollRestoreRequest = ConversationScrollRestoreRequest(
                    id: nextScrollRestoreRequest,
                    contentOffsetY: contentOffsetY
                )
            case let .resumed(messageID):
                let targetIdentity = timelineIdentity(for: messageID, in: messages)
                proxy.scrollTo(targetIdentity, anchor: .center)
            }
        }

        await Task.yield()
        await Task.yield()
        guard !Task.isCancelled else { return }
        if initialViewport == .latest {
            withTransaction(transaction) {
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            }
            await Task.yield()
            guard !Task.isCancelled else { return }
        }
        withTransaction(transaction) {
            hasPositionedInitialTimeline = true
            hasRevealedInitialViewport = true
        }
        if case let .resumed(messageID) = initialViewport,
           messageID == initialMessageID {
            highlightReferencedMessage(messageID)
        }
    }

    @MainActor
    private func loadAndRevealInitialConversation(using proxy: ScrollViewProxy) async {
        guard !Task.isCancelled else { return }
        prepareInitialConversationForDisplay()
        let latestMessageIDAtEntry = messages.last?.id
        let viewportAtEntry = initialViewport

        if !messages.isEmpty {
            await positionAndRevealInitialViewport(using: proxy)
        }

        if ConversationThreadLoadPolicy.usesCachedTimeline(
            rootMessageID: scopedThreadRootMessageID,
            messageCount: messages.count
        ) {
            initialLoadFailed = false
            return
        }

        guard !Task.isCancelled else { return }
        let accountIDAtStart = model.account?.accountId
        let didLoad = await model.loadConversation(conversation)
        guard !Task.isCancelled, model.account?.accountId == accountIDAtStart else { return }
        if !didLoad, messages.isEmpty {
            initialLoadFailed = true
            return
        }
        initialLoadFailed = false
        if initialMessageID == nil,
           !hasRevealedInitialViewport,
           case .resumed = viewportAtEntry,
           messages.last?.id != latestMessageIDAtEntry {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                initialViewport = .latest
                trackedMessageID = bottomAnchorID
                isAtBottom = true
                hasPositionedInitialTimeline = false
            }
        }
        await positionAndRevealInitialViewport(using: proxy)
    }

    @MainActor
    private func prepareInitialConversationForDisplay() {
        model.hydrateCachedMessages(for: conversation)
        prepareInitialViewport(in: messages)
    }

    private func synchronizeReadPresentation() {
        model.updateConversationReadPresentation(
            id: readPresentationID,
            conversationID: conversation.id,
            isPresented: isReadPresentationVisible && hasRevealedInitialViewport,
            isAppForeground: scenePhase == .active,
            isAtLatest: isAtBottom,
            threadRootID: scopedThreadRootMessageID
        )
    }

    private func recordScrollGeometry(_ snapshot: ConversationScrollGeometrySnapshot) {
        guard hasRevealedInitialViewport, isReadPresentationVisible, snapshot.isValid else { return }
        scrollPosition.contentOffsetY = snapshot.contentOffsetY
        if isAtBottom != snapshot.isAtLatest { isAtBottom = snapshot.isAtLatest }
        if !snapshot.isAtLatest, trackedMessageID == bottomAnchorID { trackedMessageID = nil }
    }

    private func prepareInitialViewport(in timeline: [ChatMessage], now: Date = Date()) {
        guard !hasPreparedInitialViewport else { return }
        let latestMessageID = timeline.last?.id
        let availableMessageIDs = Set(timeline.map(\.id))
        let resumedPosition = model.conversationViewportMemory.resumedPosition(
            for: viewportMemoryKey,
            latestMessageID: latestMessageID,
            availableMessageIDs: availableMessageIDs,
            now: now
        )
        let resumedMessageID = initialMessageID.flatMap { requestedMessageID in
            availableMessageIDs.contains(requestedMessageID) ? requestedMessageID : nil
        } ?? resumedPosition?.messageID

        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if initialMessageID == nil, let contentOffsetY = resumedPosition?.contentOffsetY {
                visibleMessageLimit = resumedPosition?.visibleMessageLimit ?? ConversationTimelineWindow.initialLimit
                trackedMessageID = nil
                isAtBottom = false
                hasPositionedInitialTimeline = false
                initialViewport = .offset(contentOffsetY: contentOffsetY)
            } else if let resumedMessageID,
               let resumeIndex = timeline.firstIndex(where: { $0.id == resumedMessageID }) {
                let contextStartIndex = max(timeline.startIndex, resumeIndex - 12)
                visibleMessageLimit = max(
                    ConversationTimelineWindow.initialLimit,
                    timeline.count - contextStartIndex
                )
                trackedMessageID = model.timelineIdentity(for: timeline[resumeIndex])
                isAtBottom = false
                hasPositionedInitialTimeline = false
                initialViewport = .resumed(messageID: resumedMessageID)
            } else {
                trackedMessageID = bottomAnchorID
                isAtBottom = true
                hasPositionedInitialTimeline = false
                initialViewport = .latest
            }
            hasPreparedInitialViewport = true
        }
    }

    private func rememberViewport(in timeline: [ChatMessage], now: Date = Date()) {
        guard hasPreparedInitialViewport, hasRevealedInitialViewport else { return }
        let visibleMessageID = isAtBottom
            ? nil
            : trackedMessageID.flatMap { candidate in
                timeline.first(where: { model.timelineIdentity(for: $0) == candidate })?.id
            }
        model.conversationViewportMemory.remember(
            key: viewportMemoryKey,
            messageID: visibleMessageID,
            latestMessageID: timeline.last?.id,
            contentOffsetY: isAtBottom ? nil : scrollPosition.contentOffsetY,
            visibleMessageLimit: visibleMessageLimit,
            at: now
        )
    }

    private var viewportMemoryKey: String {
        let surface = scopedThreadRootMessageID.map { "thread:\($0)" } ?? "conversation"
        return "\(model.account?.accountId.nonEmpty ?? "anonymous"):\(conversation.id):\(surface)"
    }

    @MainActor
    private func loadMoreThreadReplies(root: String, after: Int64) async {
        guard !isNavigatingThread else { return }
        isNavigatingThread = true
        defer { isNavigatingThread = false }
        do {
            isAtBottom = false
            let destination = try await model.loadThread(in: conversation, messageId: root, after: after)
            pendingThreadMessageID = destination.first
            threadPageRetrySequence = nil
        } catch {
            threadPageRetrySequence = after
            threadNavigationError = "Could not load more replies. Please retry."
        }
    }

    @MainActor
    private func navigateToUnreadThread(messageID: String? = nil) async {
        guard !isNavigatingThread,
              let target = messageID ?? model.threadAttentionBySession[conversation.sessionId]?.nextMessageId else { return }
        isNavigatingThread = true
        defer { isNavigatingThread = false }
        do {
            let destination = try await model.loadThread(in: conversation, messageId: target)
            threadNavigationError = nil
            if let onNavigateThread { onNavigateThread(destination.root, destination.first) }
            else { activeThreadShowsUnreadDivider = destination.first != nil; activeThreadFirstMessageID = destination.first; openThread(rootMessageID: destination.root) }
        } catch { threadNavigationError = "Could not open this discussion. Your unread replies are preserved." }
    }

    private func openThread(rootMessageID: String) {
        threadReturnMessageID = trackedMessageID ?? (isAtBottom ? bottomAnchorID : nil)
        threadReturnScrollOffsetY = scrollPosition.contentOffsetY
        threadReturnWasAtBottom = isAtBottom
        rememberViewport(in: messages)
        activeThreadRootMessageID = rootMessageID
    }

    private func restoreThreadReturnPosition(using proxy: ScrollViewProxy) {
        guard !isRestoringThreadPosition,
              threadReturnMessageID != nil || threadReturnScrollOffsetY != nil else { return }
        isRestoringThreadPosition = true
        let returnMessageID = threadReturnMessageID
        let returnScrollOffsetY = threadReturnScrollOffsetY
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            if let returnScrollOffsetY {
                withTransaction(transaction) {
                    isAtBottom = threadReturnWasAtBottom
                    trackedMessageID = nil
                }
                nextScrollRestoreRequest &+= 1
                exactScrollRestoreRequest = ConversationScrollRestoreRequest(
                    id: nextScrollRestoreRequest,
                    contentOffsetY: returnScrollOffsetY
                )
            } else if let returnMessageID {
                withTransaction(transaction) {
                    isAtBottom = returnMessageID == bottomAnchorID
                    trackedMessageID = returnMessageID
                    proxy.scrollTo(returnMessageID, anchor: initialViewport.scrollAnchor)
                }
                threadReturnMessageID = nil
                threadReturnScrollOffsetY = nil
                threadReturnWasAtBottom = false
                isRestoringThreadPosition = false
            } else {
                threadReturnWasAtBottom = false
                isRestoringThreadPosition = false
            }
        }
    }

    private func timelineIdentity(for messageID: String, in timeline: [ChatMessage]) -> String {
        guard let message = timeline.first(where: { $0.id == messageID }) else { return messageID }
        return model.timelineIdentity(for: message)
    }

    private func highlightReferencedMessage(_ messageID: String) {
        withAnimation(.snappy(duration: 0.2)) {
            highlightedMessageID = messageID
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            guard highlightedMessageID == messageID else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                highlightedMessageID = nil
            }
        }
    }

    private func avatarIdentity(for message: ChatMessage) -> ConversationAvatarIdentity {
        if let id = conversation.subsessionId, let snapshot = model.subsessions[id] {
            if message.author == .agent {
                return ConversationAvatarIdentity(name: snapshot.agentDisplayName,
                    source: snapshot.agentAvatarUrl, seed: snapshot.agentId)
            }
            let senderId = message.author == .me ? model.account?.accountId
                : snapshot.messages.first(where: { $0.id == message.id })?.senderAccountId
            let member = snapshot.participants?.first { $0.accountId == senderId }
            return ConversationAvatarIdentity(name: member?.displayName ?? message.authorName,
                source: member?.avatarUrl ?? (message.author == .me ? model.account?.avatar.imageSource : nil),
                seed: member?.avatarSeed ?? senderId)
        }
        if message.author == .me {
            let participant = conversation.groupParticipants.first {
                $0.accountId == model.account?.accountId || $0.role == "self"
            }
            return ConversationAvatarIdentity(
                name: model.account?.preferredName.nonEmpty
                    ?? participant?.displayName.nonEmpty
                    ?? message.authorName,
                source: model.account?.avatar.imageSource ?? participant?.avatarUrl?.nonEmpty,
                seed: model.account?.avatar.seed.nonEmpty ?? participant?.accountId.nonEmpty
            )
        }

        let participant = conversation.groupParticipants.first {
            $0.displayName.localizedCaseInsensitiveCompare(message.authorName) == .orderedSame
        }
        return ConversationAvatarIdentity(
            name: participant?.displayName.nonEmpty
                ?? conversation.displayName.nonEmpty
                ?? message.authorName,
            source: participant?.avatarUrl?.nonEmpty ?? conversation.avatarSource?.nonEmpty,
            seed: participant?.accountId.nonEmpty ?? conversation.peerAccountId.nonEmpty
        )
    }

    private var conversationHeader: some View {
        VStack(spacing: 1) {
            Text(conversation.displayName)
                .font(.headline)
                .lineLimit(1)

            if conversation.subsessionId != nil {
                Text("Agent thread · Shared with chat members")
                    .font(.caption2)
                    .foregroundStyle(KordiTheme.agentViolet)
                    .lineLimit(1)
            } else if conversation.kind == .agent, agentActivity == .replying {
                HStack(spacing: 5) {
                    if let agentName = conversation.agentDisplayName?.nonEmpty,
                       agentName != conversation.displayName {
                        Text(agentName)
                            .font(.caption2)
                            .foregroundStyle(KordiTheme.agentViolet)
                            .lineLimit(1)
                    }
                    Circle()
                        .fill(KordiTheme.agentViolet)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Agent is working")
            } else if conversation.kind == .person, !conversation.representsKordiSupport {
                ContactPresenceStatusText(
                    presence: model.contactPresenceByAccountID[conversation.peerAccountId]
                )
            } else {
                Text(conversationHeaderStatus)
                    .font(.caption2)
                    .foregroundStyle(conversation.kind == .agent ? KordiTheme.agentViolet : .secondary)
                    .lineLimit(1)
            }
        }
    }

    private var headerBalanceSpacer: some View {
        Color.clear
            .frame(width: 44, height: 44)
            .accessibilityHidden(true)
    }

    private var agentActivity: AgentActivity {
        conversation.agentActivity ?? .ready
    }

    private var sessionActionsButton: some View {
        Button(action: openSessionDetails) {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel("Open info for \(conversation.displayName)")
        .accessibilityHint("Shows media, files, tasks, and session details")
    }

    private var conversationHeaderStatus: String {
        return switch conversation.kind {
        case .agent:
            agentHeaderStatus
        case .group:
            "\(max(2, conversation.groupParticipants.count)) participants"
        case .person:
            if conversation.representsKordiSupport {
                "Official Kordi support"
            } else {
                ContactPresencePresentation.label(
                    for: model.contactPresenceByAccountID[conversation.peerAccountId]
                )
            }
        }
    }

    private func openSessionDetails() {
        dismissComposerPickers()
        if let onOpenSessionDetails {
            onOpenSessionDetails(conversation)
        } else {
            showSessionDetails = true
        }
    }

    private var askAgentButton: some View {
        Button(action: openCompanionPanel) {
            Image(systemName: "sparkles")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(KordiTheme.agentViolet)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .accessibilityLabel("Ask Agent")
        .accessibilityHint(
            model.hasConfiguredProviderAuthentication
                ? "Opens an agent chat with this session attached as context"
                : "Opens Authentication to configure an agent provider"
        )
    }

    private var canOpenCompanionPanel: Bool {
        allowsCompanionPanel
    }

    private func openCompanionPanel() {
        dismissComposerPickers()
        dismissKeyboard()
        guard allowsCompanionPanel else { return }
        guard model.hasConfiguredProviderAuthentication else {
            showsProviderAuthentication = true
            return
        }
        if selectedCompanionConversation == nil
            || selectedCompanionConversation?.id == conversation.id {
            selectedCompanionConversation = CompanionPanelCatalog.suggestedConversation(
                for: conversation,
                conversations: model.conversations,
                ownAccountID: model.account?.accountId ?? ""
            )
        }
        showsCompanionPanel = selectedCompanionConversation != nil
    }

    private func dismissComposerPickers() {
        isExpressivePickerPresented = false
        showAgentModel = false
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private func openCompanionPreviewIfReady() {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("--preview-companion-panel")
                || arguments.contains("--preview-companion-return"),
              canOpenCompanionPanel,
              !hasOpenedCompanionPreview else { return }
        hasOpenedCompanionPreview = true
        Task { @MainActor in
            await Task.yield()
            openCompanionPanel()
            if arguments.contains("--preview-companion-return") {
                try? await Task.sleep(for: .seconds(1))
                showsCompanionPanel = false
            }
        }
    }

    private var agentHeaderStatus: String {
        let agentName = conversation.agentDisplayName?.nonEmpty
        let status = model.agentStatusText(for: conversation)
        guard let agentName, agentName != conversation.displayName else { return status }
        return "\(agentName) · \(status)"
    }

    private func send() async {
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!message.isEmpty || !attachments.isEmpty), !isSending else { return }
        if let error = MemeAttachmentPolicy.draftError(for: attachments) {
            model.errorMessage = error
            return
        }
        let outgoingMention = resolvedMentionTarget(in: message)
        guard canSendWithCurrentAuthentication(mention: outgoingMention) else { return }
        let outgoingAttachments = attachments
        let outgoingGrouping = conversation.kind == .agent ? .combined : photoGrouping
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        draft = ""
        attachments = []
        photoGrouping = .combined
        replySource = nil
        selectedMention = nil
        isSending = true
        await sendOutgoingMessages(
            text: message,
            attachments: outgoingAttachments,
            grouping: outgoingGrouping,
            reply: outgoingReply,
            mention: outgoingMention
        )
    }

    private func sendExpressiveMedia(_ attachment: PendingAttachment) async {
        guard !isSending else { return }
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        replySource = nil
        isSending = true
        await sendOutgoingMessages(
            text: "",
            attachments: [attachment],
            grouping: .combined,
            reply: outgoingReply,
            mention: nil
        )
    }

    private func sendVoiceMessage() async {
        guard !isSending, let pending = await voiceRecorder.prepareForSend() else { return }
        let resolvedVoiceMessage = Task { @MainActor in
            await VoiceMessageRecorder().resolvedMessageForSend(pending)
        }
        let message = pending.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingMention = resolvedMentionTarget(in: message)
        guard canSendWithCurrentAuthentication(mention: outgoingMention) else { return }
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        replySource = nil
        selectedMention = nil
        voiceRecorder.cancel()
        await model.send(
            message,
            voiceMessage: pending,
            resolvedVoiceMessage: resolvedVoiceMessage,
            replyingTo: outgoingReply,
            mentioning: outgoingMention,
            messageAction: scopedThreadMessageAction,
            agentContext: companionContext?.referenceText,
            to: conversation
        )
    }

    private func canPresentPhotoPicker() -> Bool {
        if let error = MemeAttachmentPolicy.draftError(for: attachments) {
            model.errorMessage = error
            return false
        }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return canSendWithCurrentAuthentication(
            mention: resolvedMentionTarget(in: message)
        )
    }

    private func presentPhotoLibrary() {
        guard canPresentPhotoPicker() else { return }
        dismissComposerPickers()
        dismissKeyboard()
        Task { @MainActor in
            // ponytail: bridge the system Menu dismissal; remove the delay when SwiftUI exposes a completion callback.
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            showPhotoPicker = true
        }
    }

    private func sendPhotoSelection(
        _ selectedPhotos: [PendingAttachment],
        grouping: PhotoSendGrouping
    ) async -> Bool {
        guard !selectedPhotos.isEmpty, !isSending else { return false }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingAttachments = attachments + selectedPhotos
        if let error = MemeAttachmentPolicy.draftError(for: outgoingAttachments) {
            model.errorMessage = error
            return false
        }
        let outgoingMention = resolvedMentionTarget(in: message)
        guard canSendWithCurrentAuthentication(mention: outgoingMention) else { return false }
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        draft = ""
        attachments = []
        photoGrouping = .combined
        replySource = nil
        selectedMention = nil
        isSending = true
        await sendOutgoingMessages(
            text: message,
            attachments: outgoingAttachments,
            grouping: conversation.kind == .agent ? .combined : grouping,
            reply: outgoingReply,
            mention: outgoingMention
        )
        return true
    }

    private func canSendWithCurrentAuthentication(
        mention: ComposerMentionTarget?
    ) -> Bool {
        // The bound Agent owner's runtime authenticates shared subsession turns.
        if conversation.subsessionId != nil { return true }
        let invokesOwnedAgent = ProviderAuthenticationPolicy.requiresAuthentication(
            isAgentConversation: conversation.kind == .agent,
            mentionedAgentOwnerAccountID: mention?.kind == .agent
                ? mention?.accountId
                : nil,
            ownAccountID: model.account?.accountId
        )
        guard invokesOwnedAgent, !model.hasConfiguredProviderAuthentication else {
            return true
        }
        showsProviderAuthentication = true
        return false
    }

    private func sendOutgoingMessages(
        text: String,
        attachments: [PendingAttachment],
        grouping: PhotoSendGrouping,
        reply: MessageActionSource?,
        mention: ComposerMentionTarget?
    ) async {
        let plannedBatches = OutgoingAttachmentGroupingPlan.batches(
            for: attachments,
            photoGrouping: grouping
        )
        let batches: [[PendingAttachment]] = plannedBatches.isEmpty ? [[]] : plannedBatches

        for (index, batch) in batches.enumerated() {
            await model.send(
                index == 0 ? text : "",
                attachments: batch,
                replyingTo: index == 0 ? reply : nil,
                mentioning: index == 0 ? mention : nil,
                messageAction: index == 0 ? scopedThreadMessageAction : nil,
                agentContext: index == 0 ? companionContext?.referenceText : nil,
                to: conversation,
                onStaged: { messageID in
                    if let messageID {
                        stagedMessageIDs = Array((stagedMessageIDs + [messageID]).suffix(32))
                        scrollToBottom()
                    }
                    if index == batches.count - 1 { isSending = false }
                }
            )
        }
    }

    private func resolvedMentionTarget(in text: String) -> ComposerMentionTarget? {
        ComposerMentionTargetCatalog.resolvedTarget(
            in: text,
            selectedTarget: selectedMention,
            targets: model.mentionTargets(for: conversation)
        )
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        guard !isPreparingAttachments else { return }
        isPreparingAttachments = true
        Task {
            defer { isPreparingAttachments = false }
            do {
                let urls = try result.get()
                let loaded = try await Task.detached(priority: .userInitiated) {
                    try PendingAttachmentLoader.loadFiles(urls: urls)
                }.value
                let remaining = max(0, PendingAttachmentLoader.maximumAttachmentCount - attachments.count)
                guard loaded.count <= remaining else {
                    throw AttachmentTransferError.tooManyFiles(PendingAttachmentLoader.maximumAttachmentCount)
                }
                var prepared: [PendingAttachment] = []
                prepared.reserveCapacity(loaded.count)
                for attachment in loaded {
                    prepared.append(await PendingAttachmentLoader.addingVideoPreview(to: attachment))
                }
                attachments.append(contentsOf: prepared.filter { !$0.isMP4Video })
                enqueueVideoReviews(prepared.filter(\.isMP4Video))
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func presentCameraPhotoReview(_ image: UIImage) {
        Task { @MainActor in
            await Task.yield()
            cameraPhotoReview = CameraPhotoReview(image: image)
        }
    }

    private func sendCameraPhoto(_ image: UIImage) async -> Bool {
        do {
            guard attachments.count < PendingAttachmentLoader.maximumAttachmentCount else {
                throw AttachmentTransferError.tooManyFiles(
                    PendingAttachmentLoader.maximumAttachmentCount
                )
            }
            let attachment = try await Task.detached(priority: .userInitiated) {
                try PendingAttachmentLoader.loadCameraImage(image)
            }.value
            return await sendPhotoSelection([attachment], grouping: .combined)
        } catch {
            model.errorMessage = error.localizedDescription
            return false
        }
    }

    private func importCameraVideo(_ url: URL) {
        guard !isPreparingAttachments else { return }
        isPreparingAttachments = true
        Task {
            defer { isPreparingAttachments = false }
            do {
                guard attachments.count < PendingAttachmentLoader.maximumAttachmentCount else {
                    throw AttachmentTransferError.tooManyFiles(
                        PendingAttachmentLoader.maximumAttachmentCount
                    )
                }
                let attachment = try await PendingAttachmentLoader.loadCameraVideo(url)
                enqueueVideoReviews([attachment])
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func enqueueVideoReviews(_ videos: [PendingAttachment]) {
        guard !videos.isEmpty else { return }
        if videoReview == nil {
            videoReview = videos[0]
            queuedVideoReviews.append(contentsOf: videos.dropFirst())
        } else {
            queuedVideoReviews.append(contentsOf: videos)
        }
    }

    private func presentNextVideoReview() {
        guard videoReview == nil, !queuedVideoReviews.isEmpty else { return }
        videoReview = queuedVideoReviews.removeFirst()
    }

    private func cancelVideoReview() {
        videoReview?.discardOwnedFile()
        videoReview = nil
    }

    private func sendVideoReview(_ attachment: PendingAttachment) async -> Bool {
        let sent = await sendPhotoSelection([attachment], grouping: .combined)
        if sent { videoReview = nil }
        return sent
    }

    private func prepare(_ attachment: ChatAttachment, forSharing: Bool) {
        Task {
            if forSharing, attachment.livePhoto != nil {
                guard let urls = await model.prepareLivePhotoURLs(attachment) else { return }
                liveShareURLs = [urls.photo, urls.video]
                showLiveShare = true
                return
            }
            guard let url = await (forSharing ? model.prepareAttachmentForSharing(attachment) : model.prepareAttachmentForPresentation(attachment)) else { return }
            if forSharing {
                shareItem = SharedFileItem(url: url)
            } else {
                previewURL = url
            }
        }
    }

    private func openAttachment(
        _ attachment: ChatAttachment,
        from message: ChatMessage,
        in timeline: [ChatMessage],
        previewImage: UIImage?
    ) {
        guard attachment.kind == .image else {
            prepare(attachment, forSharing: false)
            return
        }
        mediaPreview = MediaPreviewPresentation.make(
            opening: attachment,
            from: message,
            in: timeline,
            initialImage: previewImage
        )
    }
}

private struct ContactPresenceStatusText: View {
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale

    let presence: CloudPresenceAccount?

    var body: some View {
        if presence?.status == .online {
            statusText("online")
                .foregroundStyle(KordiTheme.signalBlue)
        } else {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                statusText(
                    ContactPresencePresentation.label(
                        for: presence,
                        now: context.date,
                        calendar: calendar,
                        locale: locale
                    )
                )
                .foregroundStyle(.secondary)
            }
        }
    }

    private func statusText(_ label: String) -> some View {
        Text(label)
            .font(.caption2)
            .lineLimit(1)
    }
}

enum ContactPresencePresentation {
    static func label(
        for presence: CloudPresenceAccount?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard presence?.status != .online else { return "online" }
        guard let value = presence?.lastSeenAt else {
            return "last seen recently"
        }

        let lastSeen = parseCloudDate(value)
        guard lastSeen != .distantPast else { return "last seen recently" }
        let time = formattedTime(lastSeen, calendar: calendar, locale: locale)
        if calendar.isDate(lastSeen, inSameDayAs: now) {
            let elapsed = now.timeIntervalSince(lastSeen)
            return elapsed >= -60 && elapsed < 60
                ? "last seen just now"
                : "last seen today at \(time)"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(lastSeen, inSameDayAs: yesterday) {
            return "last seen yesterday at \(time)"
        }
        return "last seen \(formattedDate(lastSeen, calendar: calendar, locale: locale)) at \(time)"
    }

    private static func formattedTime(_ date: Date, calendar: Calendar, locale: Locale) -> String {
        date.formatted(
            Date.FormatStyle(
                date: .omitted,
                time: .shortened,
                locale: locale,
                calendar: calendar,
                timeZone: calendar.timeZone
            )
        )
    }

    private static func formattedDate(_ date: Date, calendar: Calendar, locale: Locale) -> String {
        date.formatted(
            Date.FormatStyle(
                date: .omitted,
                time: .omitted,
                locale: locale,
                calendar: calendar,
                timeZone: calendar.timeZone
            )
            .month(.abbreviated)
            .day()
        )
    }
}

private struct ConversationCallBanner: View {
    let call: CloudCall
    let title: String
    let subtitle: String
    let onJoin: () -> Void

    static func connectedLabel(for call: CloudCall) -> String {
        let joinedCount = call.participants.filter { $0.state == "joined" }.count
        return "\(joinedCount) \(joinedCount == 1 ? "person" : "people") connected"
    }

    private var symbol: String {
        call.kind.allowsVideo ? "video.fill" : "phone.fill"
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.headline)
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(KordiTheme.signalBlue.gradient, in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Button("Join", action: onJoin)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.thinMaterial)
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(subtitle)")
        .accessibilityAction(named: "Join", onJoin)
    }
}

enum ConversationInitialViewport: Equatable {
    case latest
    case resumed(messageID: String)
    case offset(contentOffsetY: CGFloat)

    var scrollAnchor: UnitPoint {
        switch self {
        case .latest:
            .bottom
        case .resumed:
            .center
        case .offset:
            .top
        }
    }
}

struct ConversationViewportSnapshot: Equatable {
    let messageID: String?
    let latestMessageID: String?
    let contentOffsetY: CGFloat?
    let visibleMessageLimit: Int?
    let leftAt: Date
}

final class ConversationViewportMemory {
    static let defaultQuickReturnInterval: TimeInterval = 2 * 60

    private let quickReturnInterval: TimeInterval
    private var snapshotsByKey: [String: ConversationViewportSnapshot] = [:]

    init(quickReturnInterval: TimeInterval = defaultQuickReturnInterval) {
        self.quickReturnInterval = quickReturnInterval
    }

    func remember(
        key: String,
        messageID: String?,
        latestMessageID: String?,
        contentOffsetY: CGFloat? = nil,
        visibleMessageLimit: Int? = nil,
        at date: Date
    ) {
        let offset = contentOffsetY?.isFinite == true ? contentOffsetY : nil
        guard messageID != nil || offset != nil else {
            snapshotsByKey[key] = nil
            return
        }
        snapshotsByKey[key] = ConversationViewportSnapshot(
            messageID: messageID,
            latestMessageID: latestMessageID,
            contentOffsetY: offset,
            visibleMessageLimit: visibleMessageLimit,
            leftAt: date
        )
    }

    func resumedPosition(
        for key: String,
        latestMessageID: String?,
        availableMessageIDs: Set<String>,
        now: Date
    ) -> ConversationViewportSnapshot? {
        guard let snapshot = snapshotsByKey[key] else { return nil }
        let elapsed = now.timeIntervalSince(snapshot.leftAt)
        guard elapsed >= 0,
              elapsed < quickReturnInterval,
              snapshot.latestMessageID == latestMessageID,
              snapshot.messageID.map(availableMessageIDs.contains) ?? (snapshot.contentOffsetY != nil) else {
            snapshotsByKey[key] = nil
            return nil
        }
        return snapshot
    }
}

enum ConversationTimelineScrollBehavior {
    static func isFollowingLatest(
        isAtBottom: Bool,
        trackedMessageID: String?,
        bottomAnchorID: String
    ) -> Bool {
        isAtBottom || trackedMessageID == bottomAnchorID
    }

    static func shouldFollowLatest(
        hasPositionedInitialTimeline: Bool,
        isAtBottom: Bool,
        previousLatestMessageID: String?,
        currentLatestMessageID: String?,
        isDeletingLatestMessage: Bool = false,
        isNavigationReturnPending: Bool = false
    ) -> Bool {
        guard !isDeletingLatestMessage,
              !isNavigationReturnPending,
              hasPositionedInitialTimeline,
              isAtBottom,
              previousLatestMessageID != nil,
              currentLatestMessageID != nil else { return false }
        return true
    }

    static func shouldShowLatestButton(
        isAtBottom: Bool,
        messageCount: Int
    ) -> Bool {
        !isAtBottom && messageCount > 0
    }

    static func isAtLatest(
        visibleMaxY: CGFloat,
        contentHeight: CGFloat,
        containerHeight: CGFloat,
        tolerance: CGFloat = 12
    ) -> Bool {
        contentHeight <= containerHeight
            || visibleMaxY >= contentHeight - tolerance
    }

    static func clampedContentOffsetY(
        _ contentOffsetY: CGFloat,
        contentHeight: CGFloat,
        containerHeight: CGFloat,
        topInset: CGFloat,
        bottomInset: CGFloat
    ) -> CGFloat {
        let minimum = -topInset
        let maximum = max(minimum, contentHeight - containerHeight + bottomInset)
        return min(max(contentOffsetY, minimum), maximum)
    }

    static func didRestoreContentOffset(
        observed: CGFloat,
        target: CGFloat,
        tolerance: CGFloat = 2
    ) -> Bool {
        abs(observed - target) <= tolerance
    }

    static func shouldKeepLatestVisibleAfterViewportChange(
        hasRevealedInitialViewport: Bool,
        wasAtLatest: Bool,
        isMessageActionPresented: Bool = false,
        isNavigationReturnPending: Bool = false,
        previousViewportSize: CGSize,
        currentViewportSize: CGSize
    ) -> Bool {
        hasRevealedInitialViewport
            && wasAtLatest
            && !isMessageActionPresented
            && !isNavigationReturnPending
            && previousViewportSize != .zero
            && previousViewportSize != currentViewportSize
    }

    static func shouldFollowLatestWhenPresentingInputSurface(
        hasRevealedInitialViewport: Bool,
        wasAtLatest: Bool,
        isPresented: Bool
    ) -> Bool {
        hasRevealedInitialViewport && wasAtLatest && isPresented
    }
}

enum ConversationTimelineWindow {
    static let initialLimit = 64
    static let pageSize = 44

    static func visibleMessages(in messages: [ChatMessage], limit: Int) -> [ChatMessage] {
        guard limit > 0, messages.count > limit else { return messages }
        return Array(messages.suffix(limit))
    }

    static func limitAfterAppending(
        currentLimit: Int,
        oldCount: Int,
        newCount: Int,
        isInitialViewportRevealed: Bool
    ) -> Int {
        guard isInitialViewportRevealed, newCount > oldCount else { return currentLimit }
        return min(newCount, currentLimit + (newCount - oldCount))
    }

    static func limitAfterLoadingEarlier(currentLimit: Int, totalCount: Int) -> Int {
        min(totalCount, currentLimit + pageSize)
    }
}

struct ConversationMessagePresentation: Equatable {
    let showsTimestamp: Bool
    let groupedWithPrevious: Bool
    let groupedWithNext: Bool
    let showsAvatar: Bool
    let outgoingAvatarGroupID: String?
}

enum ConversationTimelinePresentation {
    static let timestampGap: TimeInterval = 5 * 60

    static func make(
        messages: [ChatMessage],
        selfAccountId: String?,
        participants: [CloudGroupParticipant],
        calendar: Calendar = .current
    ) -> [ConversationMessagePresentation] {
        let participantIdsByName = Dictionary(
            participants.map { ($0.displayName.lowercased(), $0.accountId) },
            uniquingKeysWith: { first, _ in first }
        )
        let groupKeys = messages.map { message -> String? in
            if message.isSystemNotice { return nil }
            switch message.author {
            case .agent:
                return nil
            case .me:
                return "own:\(selfAccountId?.nonEmpty ?? "me")"
            case .person:
                let normalizedName = message.authorName
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                return "peer:\(participantIdsByName[normalizedName]?.nonEmpty ?? normalizedName)"
            }
        }
        let timestampVisibility = messages.indices.map { index in
            if messages[index].isSystemNotice { return true }
            guard index > messages.startIndex else { return true }
            let current = messages[index].createdAt
            let previous = messages[index - 1].createdAt
            return !calendar.isDate(current, inSameDayAs: previous)
                || current.timeIntervalSince(previous) >= timestampGap
        }

        var outgoingAvatarGroupID: String?
        return messages.indices.map { index in
            let key = groupKeys[index]
            let groupedWithPrevious = index > messages.startIndex
                && !timestampVisibility[index]
                && key != nil
                && key == groupKeys[index - 1]
            let nextIndex = index + 1
            let groupedWithNext = nextIndex < messages.endIndex
                && !timestampVisibility[nextIndex]
                && key != nil
                && key == groupKeys[nextIndex]
            if messages[index].author == .me, key != nil {
                if !groupedWithPrevious {
                    outgoingAvatarGroupID = messages[index].clientMessageId ?? messages[index].id
                }
            } else {
                outgoingAvatarGroupID = nil
            }
            return ConversationMessagePresentation(
                showsTimestamp: timestampVisibility[index],
                groupedWithPrevious: groupedWithPrevious,
                groupedWithNext: groupedWithNext,
                showsAvatar: key != nil && !groupedWithNext,
                outgoingAvatarGroupID: outgoingAvatarGroupID
            )
        }
    }
}

@MainActor
enum ConversationTimestampFormatter {
    private static let formatterCache: NSCache<NSString, DateFormatter> = {
        let cache = NSCache<NSString, DateFormatter>()
        cache.countLimit = 12
        return cache
    }()

    private static func formatter(
        template: String,
        calendar: Calendar,
        locale: Locale
    ) -> DateFormatter {
        let key = "\(calendar.identifier):\(calendar.timeZone.identifier):\(locale.identifier):\(template)" as NSString
        if let cached = formatterCache.object(forKey: key) { return cached }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(template)
        formatterCache.setObject(formatter, forKey: key)
        return formatter
    }

    static func label(
        for date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let timeFormatter = formatter(template: "jm", calendar: calendar, locale: locale)
        let time = timeFormatter.string(from: date)

        let dayDistance = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: now)
        ).day ?? .max
        let dayLabel: String
        switch dayDistance {
        case 0:
            dayLabel = "Today"
        case 1:
            dayLabel = "Yesterday"
        case 2...6:
            let weekdayFormatter = formatter(
                template: "EEEE",
                calendar: calendar,
                locale: locale
            )
            dayLabel = weekdayFormatter.string(from: date)
        default:
            let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
            let dateFormatter = formatter(
                template: sameYear ? "MMMd" : "yMMMd",
                calendar: calendar,
                locale: locale
            )
            dayLabel = dateFormatter.string(from: date)
        }
        return "\(dayLabel) \(time)"
    }
}

private struct ConversationAvatarIdentity {
    let name: String
    let source: String?
    let seed: String?
}

private struct SystemNoticeRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 24)
            .accessibilityLabel(text)
    }
}

private struct ConversationTimestampDivider: View {
    let date: Date

    var body: some View {
        Text(ConversationTimestampFormatter.label(for: date))
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 5)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct EarlierMessagesLoader: View {
    let remainingCount: Int?
    let isLoading: Bool

    @ViewBuilder
    var body: some View {
        if isLoading {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(remainingCount.map { "Loading \($0) earlier messages…" } ?? "Loading earlier messages…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityElement(children: .combine)
        } else {
            Color.clear
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }
}

private struct MentionPresentationModifier: ViewModifier {
    let isPending: Bool
    let viewportFrame: CGRect
    let action: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.5) { isVisible in
                guard isPending, isVisible else { return }
                action()
            }
        } else {
            content.onGeometryChange(for: Bool.self) { [isPending, viewportFrame] geometry in
                isPending && geometry.frame(in: .global).intersects(viewportFrame)
            } action: { isVisible in
                if isVisible { action() }
            }
        }
    }
}

private struct MentionNavigationButton: View {
    let count: Int
    let isLoading: Bool
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 38

    var body: some View {
        Button(action: action) {
            Image(systemName: "at")
                .font(.subheadline.weight(.bold))
                .frame(width: diameter, height: diameter)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle()
                        .stroke(Color(uiColor: .separator).opacity(0.5), lineWidth: 0.5)
                }
                .overlay(alignment: .topTrailing) {
                    Text(ConversationAttentionBadge.countLabel(count))
                        .font(.caption2.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(KordiTheme.signalBlue, in: Capsule())
                        .offset(x: 7, y: -6)
                }
                .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
                .frame(width: max(44, diameter), height: max(44, diameter))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(KordiTheme.signalBlue)
        .disabled(isLoading)
        .opacity(isLoading ? 0.6 : 1)
        .accessibilityLabel("Jump to next mention")
        .accessibilityValue("\(count) unread mention\(count == 1 ? "" : "s")")
        .accessibilityHint("Moves to the oldest unread message that mentions you")
    }
}

private struct LatestMessageButton: View {
    let count: Int
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 38

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.down")
                .font(.subheadline.weight(.bold))
                .frame(width: diameter, height: diameter)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle()
                        .stroke(Color(uiColor: .separator).opacity(0.5), lineWidth: 0.5)
                }
                .overlay(alignment: .topTrailing) {
                    if count > 0 {
                        Text(ConversationAttentionBadge.countLabel(count))
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(KordiTheme.signalBlue, in: Capsule())
                            .offset(x: 7, y: -6)
                    }
                }
                .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
                .frame(width: max(44, diameter), height: max(44, diameter))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityLabel("Go to latest message")
        .accessibilityValue(count > 0
            ? "\(count) new message\(count == 1 ? "" : "s")"
            : "No new messages")
        .accessibilityHint("Moves to the bottom of the conversation")
    }
}

/// Preserves visible history during input resizing and executes native scroll
/// commands. SwiftUI's identity-based command can be deferred while UIScrollView is
/// decelerating, so the button cancels momentum before moving to the true bottom.
/// Thread returns use the same bridge to restore the exact prior content offset.
private struct ConversationScrollRestoreRequest: Equatable {
    let id: Int
    let contentOffsetY: CGFloat
}

// Observe the same UIScrollView used by scroll commands. SwiftUI geometry
// callbacks can leave read presentation stale after a UIKit-driven jump.
private struct ConversationScrollCommandBridge: UIViewRepresentable {
    let preservesReadingPosition: Bool
    let scrollToBottomRequest: Int
    let animateBottomScroll: Bool
    let reduceMotion: Bool
    @Binding var exactRestoreRequest: ConversationScrollRestoreRequest?
    let onScrollGeometryChange: (ConversationScrollGeometrySnapshot) -> Void
    let onTailPositioned: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let shouldScrollToBottom = scrollToBottomRequest > 0
            && context.coordinator.lastHandledRequest != scrollToBottomRequest
        if shouldScrollToBottom {
            context.coordinator.lastHandledRequest = scrollToBottomRequest
        }
        let restoreRequest = exactRestoreRequest.flatMap { request in
            context.coordinator.lastHandledRestoreRequestID == request.id ? nil : request
        }
        let coordinator = context.coordinator
        coordinator.preservesReadingPosition = preservesReadingPosition && exactRestoreRequest == nil
        if shouldScrollToBottom || restoreRequest != nil {
            coordinator.cancelViewportAdjustment()
        }
        if restoreRequest != nil {
            coordinator.tailAnimator.cancel()
            coordinator.lastAttachedRequest = coordinator.lastHandledRequest
        }
        if shouldScrollToBottom, restoreRequest == nil, let scrollView = enclosingScrollView(from: view) {
            coordinator.lastAttachedRequest = scrollToBottomRequest
            coordinator.tailAnimator.request(in: scrollView, contentView: view, animated: animateBottomScroll, reduceMotion: reduceMotion, onPositioned: onTailPositioned)
        }

        DispatchQueue.main.async { [weak view] in
            guard let view,
                  let scrollView = enclosingScrollView(from: view) else { return }
            coordinator.observeViewport(of: scrollView)
            coordinator.observeGeometry(in: scrollView, update: onScrollGeometryChange)
            if let restoreRequest {
                guard coordinator.lastHandledRestoreRequestID != restoreRequest.id else { return }
                coordinator.lastHandledRestoreRequestID = restoreRequest.id
                coordinator.tailAnimator.cancel()
                scrollView.layer.removeAllAnimations()
                let targetY = ConversationTimelineScrollBehavior.clampedContentOffsetY(
                    restoreRequest.contentOffsetY,
                    contentHeight: scrollView.contentSize.height,
                    containerHeight: scrollView.bounds.height,
                    topInset: scrollView.adjustedContentInset.top,
                    bottomInset: scrollView.adjustedContentInset.bottom
                )
                scrollView.setContentOffset(
                    CGPoint(
                        x: scrollView.contentOffset.x,
                        y: targetY
                    ),
                    animated: false
                )
                DispatchQueue.main.async {
                    guard exactRestoreRequest?.id == restoreRequest.id,
                          ConversationTimelineScrollBehavior.didRestoreContentOffset(
                              observed: scrollView.contentOffset.y,
                              target: targetY
                          ) else { return }
                    exactRestoreRequest = nil
                }
                return
            }
            // The immediate path preserves the pre-layout presentation offset.
            // A newly attached bridge may only find its scroll view on this turn.
            if shouldScrollToBottom, coordinator.lastHandledRequest == scrollToBottomRequest,
               !coordinator.tailAnimator.hasPendingRequest,
               coordinator.lastAttachedRequest != scrollToBottomRequest {
                coordinator.tailAnimator.request(in: scrollView, contentView: view, animated: animateBottomScroll, reduceMotion: reduceMotion, onPositioned: onTailPositioned)
            }
            if shouldScrollToBottom, coordinator.lastHandledRequest == scrollToBottomRequest {
                coordinator.lastAttachedRequest = scrollToBottomRequest
                // A jump at the existing destination emits no offset change.
                coordinator.scheduleGeometryUpdate()
            }
        }
    }

    private func enclosingScrollView(from view: UIView) -> UIScrollView? {
        var candidate = view.superview
        while let current = candidate {
            if let scrollView = current as? UIScrollView { return scrollView }
            candidate = current.superview
        }
        return nil
    }

    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        coordinator.disconnect()
    }

    @MainActor
    final class Coordinator {
        let tailAnimator = ConversationTailScrollAnimator()
        var lastHandledRequest = 0
        var lastAttachedRequest = 0
        var lastHandledRestoreRequestID = 0
        private weak var geometryScrollView: UIScrollView?
        private var geometryObservations: [NSKeyValueObservation] = []
        private var geometryUpdate: ((ConversationScrollGeometrySnapshot) -> Void)?
        private var isGeometryUpdateScheduled = false

        func observeGeometry(
            in scrollView: UIScrollView,
            update: @escaping (ConversationScrollGeometrySnapshot) -> Void
        ) {
            geometryUpdate = update
            if geometryScrollView !== scrollView {
                geometryObservations = []
                geometryScrollView = scrollView
                geometryObservations = [
                    scrollView.observe(\.contentOffset) { [weak self] _, _ in self?.scheduleGeometryUpdate() },
                    scrollView.observe(\.contentSize) { [weak self] _, _ in self?.scheduleGeometryUpdate() },
                    scrollView.observe(\.bounds) { [weak self] _, _ in self?.scheduleGeometryUpdate() },
                    scrollView.observe(\.adjustedContentInset) { [weak self] _, _ in self?.scheduleGeometryUpdate() }
                ]
            }
        }

        func scheduleGeometryUpdate() {
            guard !isGeometryUpdateScheduled else { return }
            isGeometryUpdateScheduled = true
            // Coalesce layout/offset changes and never mutate SwiftUI state
            // synchronously from updateUIView or a UIKit layout callback.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.isGeometryUpdateScheduled = false
                guard let scrollView = self.geometryScrollView else { return }
                self.geometryUpdate?(ConversationScrollGeometrySnapshot(
                    isAtLatest: scrollView.contentOffset.y >= ConversationTailScrollAnimator.targetOffset(in: scrollView) - 12,
                    contentOffsetY: scrollView.contentOffset.y,
                    isValid: scrollView.window != nil && scrollView.bounds.height > 0 && scrollView.contentSize.height > 0
                ))
            }
        }

        func disconnect() {
            geometryObservations = []
            geometryScrollView = nil
            geometryUpdate = nil
            stopObservingViewport()
            tailAnimator.disconnect()
        }

        var preservesReadingPosition = false
        private weak var observedScrollView: UIScrollView?
        private var boundsObservation: NSKeyValueObservation?
        private var keyboardObserver: NSObjectProtocol?
        private var keyboardAnimationDeadline: CFTimeInterval = 0
        private var keyboardResizeDeadline: CFTimeInterval = 0
        private var keyboardWasAtLatest = false
        private var keyboardAnimationOptions: UIView.AnimationOptions = []
        private var pendingVisibleBottom: CGFloat?
        private var resizeGeneration = 0

        func observeViewport(of scrollView: UIScrollView) {
            guard observedScrollView !== scrollView else { return }
            stopObservingViewport()
            observedScrollView = scrollView
            keyboardObserver = NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
            ) { [weak self, weak scrollView] notification in
                guard let self, let scrollView else { return }
                let now = CACurrentMediaTime()
                if now >= self.keyboardResizeDeadline {
                    self.keyboardWasAtLatest = scrollView.bounds.maxY + 12
                        >= scrollView.contentSize.height + scrollView.adjustedContentInset.bottom
                }
                let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0
                let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 0
                self.keyboardAnimationDeadline = now + duration
                self.keyboardResizeDeadline = now + max(duration, 0.1) + 0.1
                self.keyboardAnimationOptions = [.beginFromCurrentState, .allowUserInteraction,
                    UIView.AnimationOptions(rawValue: curve << 16)]
            }
            // Observe the layer: UIKit does not publish every frame-driven bounds
            // resize through UIView KVO. Content offset changes alone are ignored.
            boundsObservation = scrollView.layer.observe(\.bounds, options: [.old, .new]) { [weak self, weak scrollView] _, change in
                guard let self, let scrollView, let old = change.oldValue, let new = change.newValue,
                      old.size.height != new.size.height else { return }
                self.resizeGeneration &+= 1
                let generation = self.resizeGeneration
                guard self.preservesReadingPosition, old.height > 0,
                      abs(old.width - new.width) < 1,
                      !scrollView.isTracking, !scrollView.isDragging, !scrollView.isDecelerating else {
                    self.pendingVisibleBottom = nil
                    return
                }
                // Capture the reading position before the input surface changes.
                // At latest, follow the content end; in history, keep the same
                // visible bottom instead of covering those messages.
                let bottom = self.pendingVisibleBottom ?? old.maxY
                self.pendingVisibleBottom = bottom
                DispatchQueue.main.async { [weak self, weak scrollView] in
                    guard let self, let scrollView, self.resizeGeneration == generation,
                          self.observedScrollView === scrollView else { return }
                    self.pendingVisibleBottom = nil
                    guard self.preservesReadingPosition,
                          CACurrentMediaTime() < self.keyboardResizeDeadline,
                          !scrollView.isTracking, !scrollView.isDragging, !scrollView.isDecelerating else { return }
                    // SwiftUI can adjust the offset before publishing the resize,
                    // then deliver the keyboard notification in the same layout.
                    // Resolve follow intent here so we do not undo that adjustment.
                    let keepLatest = self.keyboardWasAtLatest
                    let targetY = ConversationTimelineScrollBehavior.clampedContentOffsetY(
                        keepLatest
                            ? scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom
                            : bottom - scrollView.bounds.height,
                        contentHeight: scrollView.contentSize.height,
                        containerHeight: scrollView.bounds.height,
                        topInset: scrollView.adjustedContentInset.top,
                        bottomInset: scrollView.adjustedContentInset.bottom
                    )
                    let update = { scrollView.contentOffset = CGPoint(x: scrollView.contentOffset.x, y: targetY) }
                    let remaining = self.keyboardAnimationDeadline - CACurrentMediaTime()
                    if remaining > 0 {
                        UIView.animate(withDuration: remaining, delay: 0, options: self.keyboardAnimationOptions, animations: update)
                    } else {
                        UIView.performWithoutAnimation(update)
                    }
                }
            }
        }

        func cancelViewportAdjustment() {
            resizeGeneration &+= 1
            pendingVisibleBottom = nil
        }

        func stopObservingViewport() {
            cancelViewportAdjustment()
            boundsObservation?.invalidate()
            boundsObservation = nil
            observedScrollView = nil
            if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
            keyboardObserver = nil
        }
    }
}

// Pixel offsets are bookkeeping, not inputs to transcript rendering.
final class ConversationScrollPosition {
    var contentOffsetY: CGFloat?
}

private struct ConversationScrollGeometrySnapshot: Equatable {
    let isAtLatest: Bool
    let contentOffsetY: CGFloat
    let isValid: Bool
}

private struct ConversationInitialFailureView: View {
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn’t load messages", systemImage: "wifi.exclamationmark")
        } description: {
            Text("Check your connection and try again.")
        } actions: {
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

private struct EmptyConversation: View {
    let conversation: ConversationSummary
    let backgroundSessionState: BackgroundAgentSession.State?

    init(
        conversation: ConversationSummary,
        backgroundSessionState: BackgroundAgentSession.State? = nil
    ) {
        self.conversation = conversation
        self.backgroundSessionState = backgroundSessionState
    }

    var body: some View {
        VStack(spacing: 14) {
            if conversation.kind == .group {
                GroupAvatarStack(
                    participants: conversation.groupParticipants,
                    size: 68
                )
            } else {
                IdentityAvatar(
                    name: conversation.agentDisplayName?.nonEmpty ?? conversation.displayName,
                    imageSource: conversation.avatarSource,
                    kind: conversation.kind,
                    size: 68,
                    seed: conversation.agentId?.nonEmpty ?? conversation.peerAccountId.nonEmpty ?? conversation.sessionId
                )
            }
            VStack(spacing: 5) {
                Text(emptyStateTitle).font(.title2.bold())
                Text(emptyStateText)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: 300)
        .frame(maxWidth: .infinity)
    }

    private var emptyStateTitle: String {
        if backgroundSessionState != nil {
            return conversation.displayName
        }
        if conversation.kind == .agent {
            return conversation.agentDisplayName?.nonEmpty ?? "Kordi"
        }
        return conversation.displayName
    }

    private var emptyStateText: String {
        if let backgroundSessionState {
            return switch backgroundSessionState {
            case .running:
                "Still running on your Mac. Progress and the final result will appear here as they synchronize."
            case .done:
                "The background session finished. Its result will appear here after synchronization."
            case .failed:
                "The background session needs attention on your Mac."
            case .stopped:
                "The background session was stopped before producing a final result."
            }
        }
        return switch conversation.kind {
        case .agent: "Describe the outcome you want. Kordi Cloud or an available Mac handles the run."
        case .group: "Send the first message to this group from your iPhone."
        case .person: "Send the first message from your iPhone."
        }
    }
}

#Preview("Agent conversation") {
    let fixture = PreviewData.make()
    NavigationStack {
        ConversationView(conversation: fixture.conversations[0])
    }
    .environmentObject(AppModel(previewMode: true))
    .tint(KordiTheme.signalBlue)
}


private struct ThreadNavigationButton: View {
    let count: Int
    let isLoading: Bool
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 38
    var body: some View {
        Button(action: action) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.subheadline.weight(.semibold))
                .frame(width: diameter, height: diameter)
                .background(.regularMaterial, in: Circle())
                .overlay { Circle().stroke(Color(uiColor: .separator).opacity(0.5), lineWidth: 0.5) }
                .overlay(alignment: .topTrailing) {
                    Text(ConversationAttentionBadge.countLabel(count)).font(.caption2.bold()).foregroundStyle(.white)
                        .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 20)
                        .background(KordiTheme.signalBlue, in: Capsule()).offset(x: 7, y: -6)
                }
                .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
                .frame(width: max(44, diameter), height: max(44, diameter)).contentShape(Circle())
        }
        .buttonStyle(.plain).foregroundStyle(KordiTheme.signalBlue).disabled(isLoading).opacity(isLoading ? 0.6 : 1)
        .accessibilityLabel("Jump to next unread thread").accessibilityValue("\(count) unread discussions")
    }
}

/// A send becomes visible only after its measured row and viewport are aligned.
private struct OutgoingMessageEntrance: ViewModifier {
    let pendingPosition: Bool

    func body(content: Content) -> some View {
        content
            .opacity(pendingPosition ? 0 : 1)
            .allowsHitTesting(!pendingPosition)
            .accessibilityHidden(pendingPosition)
    }
}
