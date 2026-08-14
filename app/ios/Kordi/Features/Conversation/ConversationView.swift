import SwiftUI
import QuickLook
import PhotosUI
import UniformTypeIdentifiers
import UIKit

struct ConversationView: View {
    @EnvironmentObject private var model: AppModel
    private let initialConversation: ConversationSummary
    private let initialMessageID: String?
    @State private var draft = ""
    @State private var isSending = false
    @State private var visibleMessageLimit = ConversationTimelineWindow.initialLimit
    @State private var isLoadingEarlier = false
    @State private var isAtBottom = false
    @State private var hasPositionedInitialTimeline = false
    @State private var initialViewport = ConversationInitialViewport.latest
    @State private var hasPreparedInitialViewport = false
    @State private var hasRevealedInitialViewport = false
    @State private var trackedMessageID: String?
    @State private var immediateBottomRequest = 0
    @State private var attachments: [PendingAttachment] = []
    @State private var photoGrouping: PhotoSendGrouping = .combined
    @State private var photoSelectionReview: PhotoSelectionReview?
    @State private var replySource: MessageActionSource?
    @State private var selectedMention: ComposerMentionTarget?
    @State private var showFileImporter = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isPreparingAttachments = false
    @State private var previewURL: URL?
    @State private var mediaPreview: MediaPreviewPresentation?
    @State private var shareItem: SharedFileItem?
    @State private var showSessionDetails = false
    @State private var showAgentModel = false
    @State private var highlightedMessageID: String?
    @State private var selectedMessageIDs = Set<String>()
    @State private var forwardRequest: MessageForwardRequest?
    @State private var detailsMessage: ChatMessage?
    @State private var pinTarget: ChatMessage?
    @State private var forwardedDestination: ConversationSummary?

    init(conversation: ConversationSummary, initialMessageID: String? = nil) {
        initialConversation = conversation
        self.initialMessageID = initialMessageID
    }

    /// Navigation can outlive a sync pass. Resolve the current summary by its
    /// stable id so title, participant names, and avatars update while the
    /// conversation is already open instead of requiring a back/reopen cycle.
    private var conversation: ConversationSummary {
        model.conversations.first(where: { $0.id == initialConversation.id })
            ?? initialConversation
    }

    private var messages: [ChatMessage] { model.messages(for: conversation) }
    private let bottomAnchorID = "conversation-bottom"
    private let timelineVerticalInset: CGFloat = 14

    var body: some View {
        let timeline = messages
        let visibleTimeline = ConversationTimelineWindow.visibleMessages(
            in: timeline,
            limit: visibleMessageLimit
        )
        let visibleStartIndex = timeline.count - visibleTimeline.count
        let messagesById = Dictionary(uniqueKeysWithValues: timeline.map { ($0.id, $0) })
        let presentationStartIndex = max(timeline.startIndex, visibleStartIndex - 1)
        let timelinePresentation = ConversationTimelinePresentation.make(
            messages: Array(timeline[presentationStartIndex..<timeline.endIndex]),
            selfAccountId: model.account?.accountId,
            participants: conversation.groupParticipants
        )
        let pinnedMessage = model.sessionPinsByID[conversation.sessionId]?.effectiveMessageId
            .flatMap { messagesById[$0] }
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                if let pinnedMessage {
                    PinnedMessageBar(
                        message: pinnedMessage,
                        onOpen: {
                            navigateToMessage(pinnedMessage.id, in: timeline, proxy: proxy)
                        },
                        onUnpin: {
                            Task { _ = await model.unpin(pinnedMessage, in: conversation) }
                        }
                    )
                }

                if hasPreparedInitialViewport {
                    GeometryReader { viewport in
                        ZStack(alignment: .bottomTrailing) {
                            ScrollView {
                                LazyVStack(spacing: 0) {
                                    if timeline.isEmpty {
                                        EmptyConversation(conversation: conversation)
                                            .padding(.top, 70)
                                    } else {
                                        if visibleStartIndex > 0 {
                                            EarlierMessagesLoader(remainingCount: visibleStartIndex)
                                                .id("earlier:\(visibleTimeline.first?.id ?? conversation.id)")
                                                .onAppear {
                                                    guard hasPositionedInitialTimeline else { return }
                                                    loadEarlierMessages(
                                                        preserving: visibleTimeline.first?.id,
                                                        totalCount: timeline.count,
                                                        proxy: proxy
                                                    )
                                                }
                                        }

                                        ForEach(Array(visibleTimeline.enumerated()), id: \.element.id) { offset, message in
                                            let index = visibleStartIndex + offset
                                            let presentation = timelinePresentation[index - presentationStartIndex]
                                            let avatar = avatarIdentity(for: message)
                                            let readers = readReceiptParticipants(for: message)

                                            VStack(spacing: 0) {
                                                if presentation.showsTimestamp {
                                                    ConversationTimestampDivider(date: message.createdAt)
                                                }

                                                MessageBubble(
                                                    message: message,
                                                    showAuthor: message.author == .agent,
                                                    showAvatar: presentation.showsAvatar,
                                                    replySourceMessage: message.replyToMessageId.flatMap { messagesById[$0] },
                                                    isHighlighted: highlightedMessageID == message.id,
                                                    isPinned: pinnedMessage?.id == message.id,
                                                    selectionMode: !selectedMessageIDs.isEmpty,
                                                    isSelected: selectedMessageIDs.contains(message.id),
                                                    allowsQuotedReplies: conversation.kind.supportsQuotedReplies,
                                                    showsAvatarSlot: message.author != .agent,
                                                    authorAvatarName: avatar.name,
                                                    authorAvatarSource: avatar.source,
                                                    authorAvatarSeed: avatar.seed,
                                                    readByNames: readers.map(\.displayName),
                                                    onRetry: { Task { await model.retry(message, in: conversation) } },
                                                    onReply: {
                                                        guard conversation.kind.supportsQuotedReplies else { return }
                                                        replySource = message.actionSource(sessionId: conversation.sessionId)
                                                    },
                                                    onPin: {
                                                        if pinnedMessage?.id == message.id {
                                                            Task { _ = await model.unpin(message, in: conversation) }
                                                        } else {
                                                            pinTarget = message
                                                        }
                                                    },
                                                    onForward: {
                                                        forwardRequest = MessageForwardRequest(
                                                            sourceConversation: conversation,
                                                            messages: [message]
                                                        )
                                                    },
                                                    onDetails: { detailsMessage = message },
                                                    onSelect: { toggleSelection(message.id) },
                                                    onNavigateToReply: { messageId in
                                                        navigateToMessage(messageId, in: timeline, proxy: proxy)
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
                                                    }
                                                )
                                                .equatable()
                                                .padding(.top, presentation.groupedWithPrevious ? 2 : 7)
                                                .padding(.bottom, presentation.groupedWithNext ? 0 : 2)
                                            }
                                            .id(message.id)
                                        }
                                    }

                                    Color.clear
                                        .frame(height: 1)
                                        .id(bottomAnchorID)
                                        .background(
                                            ConversationScrollCommandBridge(
                                                scrollToBottomRequest: immediateBottomRequest
                                            )
                                        )
                                        .onAppear {
                                            guard hasRevealedInitialViewport else { return }
                                            isAtBottom = true
                                        }
                                        .onDisappear {
                                            guard hasRevealedInitialViewport else { return }
                                            isAtBottom = false
                                        }
                                }
                                .scrollTargetLayout()
                                .frame(
                                    minHeight: max(
                                        0,
                                        viewport.size.height - timelineVerticalInset * 2
                                    ),
                                    alignment: timeline.isEmpty ? .top : .bottom
                                )
                                .padding(.horizontal, 12)
                                .padding(.vertical, timelineVerticalInset)
                            }
                            .defaultScrollAnchor(.bottom)
                            .scrollPosition(id: $trackedMessageID, anchor: initialViewport.scrollAnchor)
                            .modifier(
                                ConversationBottomTrackingModifier(
                                    isAtBottom: $isAtBottom,
                                    hasPositionedInitialTimeline: $hasPositionedInitialTimeline,
                                    isEnabled: hasRevealedInitialViewport,
                                    hasMessages: !timeline.isEmpty
                                )
                            )
                            .background(Color(uiColor: .systemGroupedBackground))
                            .scrollDismissesKeyboard(.interactively)

                            if ConversationTimelineScrollBehavior.shouldShowLatestButton(
                                isAtBottom: isAtBottom,
                                messageCount: timeline.count
                            ) {
                                LatestMessageButton {
                                    scrollToBottom(animated: true)
                                }
                                .padding(.trailing, 18)
                                .padding(.bottom, 16)
                                .transition(.scale(scale: 0.82).combined(with: .opacity))
                            }
                        }
                        .animation(.snappy(duration: 0.2), value: isAtBottom)
                        .opacity(hasRevealedInitialViewport ? 1 : 0)
                        .allowsHitTesting(hasRevealedInitialViewport)
                        .accessibilityHidden(!hasRevealedInitialViewport)
                    }
                } else {
                    Color(uiColor: .systemGroupedBackground)
                }
            }
            .onChange(of: timeline.count) { oldCount, newCount in
                visibleMessageLimit = ConversationTimelineWindow.limitAfterAppending(
                    currentLimit: visibleMessageLimit,
                    oldCount: oldCount,
                    newCount: newCount,
                    isInitialViewportRevealed: hasRevealedInitialViewport
                )
            }
            .onChange(of: timeline.last?.id) { previousLatestMessageID, currentLatestMessageID in
                if ConversationTimelineScrollBehavior.shouldFollowLatest(
                    hasPositionedInitialTimeline: hasPositionedInitialTimeline,
                    isAtBottom: isAtBottom,
                    previousLatestMessageID: previousLatestMessageID,
                    currentLatestMessageID: currentLatestMessageID
                ) {
                    scrollToBottom(animated: true)
                }
            }
            .task(id: conversation.id) {
                await loadAndRevealInitialConversation(using: proxy)
            }
        }
        .navigationTitle(conversation.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                conversationHeader
                    .accessibilityElement(children: .combine)
            }
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarTrailing) {
                    sessionActionsButton
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    sessionActionsButton
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if selectedMessageIDs.isEmpty {
                ComposerView(
                    text: $draft,
                    attachments: $attachments,
                    photoGrouping: $photoGrouping,
                    replySource: $replySource,
                    selectedMention: $selectedMention,
                    mentionTargets: model.mentionTargets(for: conversation),
                    isSending: isSending,
                    isPreparingAttachments: isPreparingAttachments,
                    destinationName: conversation.displayName,
                    cameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
                    onTakePhoto: { showCamera = true },
                    onChoosePhotos: { showPhotoPicker = true },
                    onChooseFiles: { showFileImporter = true },
                    onOpenAgentModel: { showAgentModel = true },
                    onSend: { Task { await send() } }
                )
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
        .onDisappear {
            rememberViewport(in: messages)
        }
        .onAppear {
            if !conversation.kind.supportsQuotedReplies {
                replySource = nil
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-session-detail") {
                showSessionDetails = true
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-agent-model")
                || ProcessInfo.processInfo.arguments.contains("--preview-contact-model") {
                showAgentModel = true
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
            if ProcessInfo.processInfo.arguments.contains("--preview-media"),
               mediaPreview == nil,
               let message = messages.first(where: { message in
                   message.attachments.contains(where: { $0.kind == .image })
               }),
               let attachment = message.attachments.first(where: { $0.kind == .image }) {
                openAttachment(attachment, from: message, in: messages, previewImage: nil)
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-photo-send"),
               photoSelectionReview == nil {
                photoSelectionReview = PhotoSelectionReview(
                    attachments: PreviewData.pendingPhotoAttachments()
                )
            }
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $selectedPhotos,
            maxSelectionCount: max(1, PendingAttachmentLoader.maximumAttachmentCount - attachments.count),
            selectionBehavior: .ordered,
            matching: .images
        )
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            importPhotos(items)
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraImagePicker(
                onImage: { image in
                    showCamera = false
                    importCameraImage(image)
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
        .quickLookPreview($previewURL)
        .fullScreenCover(item: $mediaPreview) { presentation in
            MediaPreviewView(presentation: presentation)
        }
        .fullScreenCover(item: $photoSelectionReview) { review in
            PhotoSendReviewSheet(
                review: review,
                allowsSeparateMessages: conversation.kind != .agent,
                onSend: { grouping in
                    await sendPhotoSelection(review.attachments, grouping: grouping)
                }
            )
        }
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: [item.url])
        }
        .sheet(isPresented: $showSessionDetails) {
            SessionDetailSheet(conversation: conversation)
        }
        .sheet(isPresented: $showAgentModel) {
            AgentModelSheet(conversation: conversation)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
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
                readers: readReceiptParticipants(for: message)
            )
        }
        .confirmationDialog(
            "Pin this message?",
            isPresented: Binding(
                get: { pinTarget != nil },
                set: { if !$0 { pinTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Pin for me") { pinMessage(shared: false) }
            Button("Pin for everyone") { pinMessage(shared: true) }
            Button("Cancel", role: .cancel) { pinTarget = nil }
        } message: {
            Text("Pinned messages stay visible above this session on synced Kordi devices.")
        }
        .navigationDestination(item: $forwardedDestination) { destination in
            ConversationView(conversation: destination)
        }
    }

    private func navigateToMessage(
        _ messageID: String,
        in timeline: [ChatMessage],
        proxy: ScrollViewProxy
    ) {
        guard let sourceIndex = timeline.firstIndex(where: { $0.id == messageID }) else { return }
        visibleMessageLimit = max(visibleMessageLimit, timeline.count - sourceIndex)
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            withAnimation(.easeInOut(duration: 0.24)) {
                proxy.scrollTo(messageID, anchor: .center)
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

    private func pinMessage(shared: Bool) {
        guard let target = pinTarget else { return }
        pinTarget = nil
        Task { _ = await model.pin(target, in: conversation, shared: shared) }
    }

    private func readReceiptParticipants(for message: ChatMessage) -> [CloudGroupParticipant] {
        guard conversation.kind == .group, message.author == .me else { return [] }
        let participantsByID = Dictionary(
            conversation.groupParticipants.map { ($0.accountId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return message.readByAccountIds.map { accountID in
            participantsByID[accountID] ?? CloudGroupParticipant(
                accountId: accountID,
                displayName: "Kordi user",
                avatarUrl: nil,
                role: nil
            )
        }
    }

    private func loadEarlierMessages(
        preserving anchorID: String?,
        totalCount: Int,
        proxy: ScrollViewProxy
    ) {
        guard !isLoadingEarlier,
              visibleMessageLimit < totalCount,
              let anchorID else { return }
        isLoadingEarlier = true
        visibleMessageLimit = min(
            totalCount,
            visibleMessageLimit + ConversationTimelineWindow.pageSize
        )
        Task { @MainActor in
            await Task.yield()
            proxy.scrollTo(anchorID, anchor: .top)
            isLoadingEarlier = false
        }
    }

    private func scrollToBottom(animated: Bool = false) {
        initialViewport = .latest
        hasPositionedInitialTimeline = true
        if animated {
            immediateBottomRequest &+= 1
            withAnimation(.smooth(duration: 0.42)) {
                trackedMessageID = bottomAnchorID
            }
        } else {
            trackedMessageID = bottomAnchorID
        }
    }

    @MainActor
    private func positionAndRevealInitialViewport(using proxy: ScrollViewProxy) async {
        guard hasPreparedInitialViewport, !hasRevealedInitialViewport else { return }
        await Task.yield()
        await Task.yield()

        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            switch initialViewport {
            case .latest:
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            case let .resumed(messageID):
                proxy.scrollTo(messageID, anchor: .center)
            }
        }

        await Task.yield()
        await Task.yield()
        guard !Task.isCancelled else { return }
        withTransaction(transaction) {
            hasPositionedInitialTimeline = true
            hasRevealedInitialViewport = true
        }
        if case let .resumed(messageID) = initialViewport,
           messageID == initialMessageID {
            highlightReferencedMessage(messageID)
        }
        model.markConversationPresentationSettled(conversation)
    }

    @MainActor
    private func loadAndRevealInitialConversation(using proxy: ScrollViewProxy) async {
        model.markConversationOpened(conversation)
        model.hydrateCachedMessages(for: conversation)
        prepareInitialViewport(in: messages)
        let latestMessageIDAtEntry = messages.last?.id
        let viewportAtEntry = initialViewport

        if model.canRevealConversationImmediately(conversation) {
            await positionAndRevealInitialViewport(using: proxy)
        }

        await model.loadConversation(conversation)
        guard !Task.isCancelled else { return }
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

    private func prepareInitialViewport(in timeline: [ChatMessage], now: Date = Date()) {
        guard !hasPreparedInitialViewport else { return }
        let latestMessageID = timeline.last?.id
        let availableMessageIDs = Set(timeline.map(\.id))
        let resumedMessageID = initialMessageID.flatMap { requestedMessageID in
            availableMessageIDs.contains(requestedMessageID) ? requestedMessageID : nil
        } ?? model.conversationViewportMemory.resumedMessageID(
            for: viewportMemoryKey,
            latestMessageID: latestMessageID,
            availableMessageIDs: availableMessageIDs,
            now: now
        )

        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if let resumedMessageID,
               let resumeIndex = timeline.firstIndex(where: { $0.id == resumedMessageID }) {
                let contextStartIndex = max(timeline.startIndex, resumeIndex - 12)
                visibleMessageLimit = max(
                    ConversationTimelineWindow.initialLimit,
                    timeline.count - contextStartIndex
                )
                trackedMessageID = resumedMessageID
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
                timeline.contains(where: { $0.id == candidate }) ? candidate : nil
            }
        model.conversationViewportMemory.remember(
            key: viewportMemoryKey,
            messageID: visibleMessageID,
            latestMessageID: timeline.last?.id,
            at: now
        )
    }

    private var viewportMemoryKey: String {
        "\(model.account?.accountId.nonEmpty ?? "anonymous"):\(conversation.id)"
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
        if message.author == .me {
            let participant = conversation.groupParticipants.first {
                $0.accountId == model.account?.accountId || $0.role == "self"
            }
            return ConversationAvatarIdentity(
                name: model.account?.preferredName.nonEmpty
                    ?? participant?.displayName.nonEmpty
                    ?? message.authorName,
                source: model.account?.avatarUrl?.nonEmpty ?? participant?.avatarUrl?.nonEmpty,
                seed: model.account?.accountId.nonEmpty ?? participant?.accountId.nonEmpty
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

    @ViewBuilder
    private var conversationHeader: some View {
        if conversation.kind == .agent {
            HStack(spacing: 8) {
                IdentityAvatar(
                    name: conversation.agentDisplayName?.nonEmpty ?? "My Kordi",
                    imageSource: conversation.avatarSource,
                    kind: .agent,
                    size: 30,
                    seed: conversation.agentId?.nonEmpty ?? conversation.sessionId
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(conversation.displayName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(agentHeaderStatus)
                        .font(.caption2)
                        .foregroundStyle(KordiTheme.agentViolet)
                        .lineLimit(1)
                }
            }
        } else {
            VStack(spacing: 1) {
                Text(conversation.displayName).font(.headline)
                if conversation.kind == .group {
                    Text("\(max(2, conversation.groupParticipants.count)) participants")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var sessionActionsButton: some View {
        Button { showSessionDetails = true } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel("Info, Artifacts, and Tasks")
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
        let outgoingAttachments = attachments
        let outgoingGrouping = conversation.kind == .agent ? .combined : photoGrouping
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        let outgoingMention = resolvedMentionTarget(in: message)
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
        isSending = false
    }

    private func sendPhotoSelection(
        _ selectedAttachments: [PendingAttachment],
        grouping: PhotoSendGrouping
    ) async {
        guard !selectedAttachments.isEmpty, !isSending else { return }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        let outgoingMention = resolvedMentionTarget(in: message)
        draft = ""
        replySource = nil
        selectedMention = nil
        isSending = true
        await sendOutgoingMessages(
            text: message,
            attachments: selectedAttachments,
            grouping: conversation.kind == .agent ? .combined : grouping,
            reply: outgoingReply,
            mention: outgoingMention
        )
        isSending = false
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
                to: conversation
            )
        }
    }

    private func resolvedMentionTarget(in text: String) -> ComposerMentionTarget? {
        if let selectedMention,
           text.localizedCaseInsensitiveContains(selectedMention.mentionText) {
            return selectedMention
        }
        return model.mentionTargets(for: conversation)
            .sorted { $0.displayName.count > $1.displayName.count }
            .first { text.localizedCaseInsensitiveContains($0.mentionText) }
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
                attachments.append(contentsOf: loaded)
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !isPreparingAttachments else { return }
        isPreparingAttachments = true
        selectedPhotos = []
        Task {
            defer { isPreparingAttachments = false }
            do {
                let remaining = max(0, PendingAttachmentLoader.maximumAttachmentCount - attachments.count)
                guard items.count <= remaining else {
                    throw AttachmentTransferError.tooManyFiles(PendingAttachmentLoader.maximumAttachmentCount)
                }
                var loaded: [PendingAttachment] = []
                for (index, item) in items.enumerated() {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        throw AttachmentTransferError.invalidImage
                    }
                    let preferredExtension = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    let attachment = try await Task.detached(priority: .userInitiated) {
                        try PendingAttachmentLoader.loadImage(
                            data: data,
                            suggestedName: "Photo-\(index + 1).\(preferredExtension)"
                        )
                    }.value
                    loaded.append(attachment)
                }
                if loaded.count > 1, attachments.isEmpty {
                    photoSelectionReview = PhotoSelectionReview(attachments: loaded)
                } else {
                    attachments.append(contentsOf: loaded)
                }
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func importCameraImage(_ image: UIImage) {
        guard !isPreparingAttachments else { return }
        isPreparingAttachments = true
        Task {
            defer { isPreparingAttachments = false }
            do {
                let attachment = try await Task.detached(priority: .userInitiated) {
                    try PendingAttachmentLoader.loadCameraImage(image)
                }.value
                guard attachments.count < PendingAttachmentLoader.maximumAttachmentCount else {
                    throw AttachmentTransferError.tooManyFiles(PendingAttachmentLoader.maximumAttachmentCount)
                }
                attachments.append(attachment)
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func prepare(_ attachment: ChatAttachment, forSharing: Bool) {
        Task {
            guard let url = await model.prepareAttachmentForPresentation(attachment) else { return }
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

enum ConversationInitialViewport: Equatable {
    case latest
    case resumed(messageID: String)

    var scrollAnchor: UnitPoint {
        switch self {
        case .latest:
            .bottom
        case .resumed:
            .center
        }
    }
}

struct ConversationViewportSnapshot: Equatable {
    let messageID: String
    let latestMessageID: String?
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
        at date: Date
    ) {
        guard let messageID else {
            snapshotsByKey[key] = nil
            return
        }
        snapshotsByKey[key] = ConversationViewportSnapshot(
            messageID: messageID,
            latestMessageID: latestMessageID,
            leftAt: date
        )
    }

    func resumedMessageID(
        for key: String,
        latestMessageID: String?,
        availableMessageIDs: Set<String>,
        now: Date
    ) -> String? {
        guard let snapshot = snapshotsByKey[key] else { return nil }
        let elapsed = now.timeIntervalSince(snapshot.leftAt)
        guard elapsed >= 0,
              elapsed < quickReturnInterval,
              snapshot.latestMessageID == latestMessageID,
              availableMessageIDs.contains(snapshot.messageID) else {
            snapshotsByKey[key] = nil
            return nil
        }
        return snapshot.messageID
    }
}

enum ConversationTimelineScrollBehavior {
    static func shouldFollowLatest(
        hasPositionedInitialTimeline: Bool,
        isAtBottom: Bool,
        previousLatestMessageID: String?,
        currentLatestMessageID: String?
    ) -> Bool {
        guard hasPositionedInitialTimeline,
              isAtBottom,
              let previousLatestMessageID,
              let currentLatestMessageID else { return false }
        return previousLatestMessageID != currentLatestMessageID
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
}

enum ConversationTimelineWindow {
    static let initialLimit = 64
    static let pageSize = 64

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
}

struct ConversationMessagePresentation: Equatable {
    let showsTimestamp: Bool
    let groupedWithPrevious: Bool
    let groupedWithNext: Bool
    let showsAvatar: Bool
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
            guard index > messages.startIndex else { return true }
            let current = messages[index].createdAt
            let previous = messages[index - 1].createdAt
            return !calendar.isDate(current, inSameDayAs: previous)
                || current.timeIntervalSince(previous) >= timestampGap
        }

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
            return ConversationMessagePresentation(
                showsTimestamp: timestampVisibility[index],
                groupedWithPrevious: groupedWithPrevious,
                groupedWithNext: groupedWithNext,
                showsAvatar: key != nil && !groupedWithNext
            )
        }
    }
}

enum ConversationTimestampFormatter {
    static func label(
        for date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let timeFormatter = DateFormatter()
        timeFormatter.calendar = calendar
        timeFormatter.locale = locale
        timeFormatter.timeZone = calendar.timeZone
        timeFormatter.setLocalizedDateFormatFromTemplate("jm")
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
            let weekdayFormatter = DateFormatter()
            weekdayFormatter.calendar = calendar
            weekdayFormatter.locale = locale
            weekdayFormatter.timeZone = calendar.timeZone
            weekdayFormatter.setLocalizedDateFormatFromTemplate("EEEE")
            dayLabel = weekdayFormatter.string(from: date)
        default:
            let dateFormatter = DateFormatter()
            dateFormatter.calendar = calendar
            dateFormatter.locale = locale
            dateFormatter.timeZone = calendar.timeZone
            let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
            dateFormatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
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
    let remainingCount: Int

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Loading \(remainingCount) earlier messages…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

private struct LatestMessageButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.down")
                .font(.system(size: 22, weight: .semibold))
                .frame(width: 52, height: 52)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .background(.regularMaterial, in: Circle())
        .overlay {
            Circle()
                .stroke(Color(uiColor: .separator).opacity(0.5), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.16), radius: 12, y: 5)
        .accessibilityLabel("Go to latest message")
        .accessibilityHint("Moves to the bottom of the conversation")
    }
}

/// SwiftUI's identity-based scroll command can be deferred while UIScrollView
/// is decelerating. The button must win immediately, so this bridge cancels the
/// active momentum and starts one interruptible animation to the true bottom.
private struct ConversationScrollCommandBridge: UIViewRepresentable {
    let scrollToBottomRequest: Int

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
        guard scrollToBottomRequest > 0,
              context.coordinator.lastHandledRequest != scrollToBottomRequest else { return }
        context.coordinator.lastHandledRequest = scrollToBottomRequest

        DispatchQueue.main.async { [weak view] in
            guard let view,
                  let scrollView = enclosingScrollView(from: view) else { return }
            scrollView.layer.removeAllAnimations()
            scrollView.setContentOffset(scrollView.contentOffset, animated: false)
            if scrollView.panGestureRecognizer.state != .possible {
                scrollView.panGestureRecognizer.isEnabled = false
                scrollView.panGestureRecognizer.isEnabled = true
            }
            let targetY = max(
                -scrollView.adjustedContentInset.top,
                scrollView.contentSize.height
                    - scrollView.bounds.height
                    + scrollView.adjustedContentInset.bottom
            )
            UIView.animate(
                withDuration: 0.42,
                delay: 0,
                options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseInOut]
            ) {
                scrollView.contentOffset = CGPoint(x: scrollView.contentOffset.x, y: targetY)
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

    final class Coordinator {
        var lastHandledRequest = 0
    }
}

private struct ConversationBottomTrackingModifier: ViewModifier {
    @Binding var isAtBottom: Bool
    @Binding var hasPositionedInitialTimeline: Bool
    let isEnabled: Bool
    let hasMessages: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    ConversationTimelineScrollBehavior.isAtLatest(
                        visibleMaxY: geometry.visibleRect.maxY,
                        contentHeight: geometry.contentSize.height,
                        containerHeight: geometry.containerSize.height
                    )
                } action: { _, reachedLatest in
                    guard isEnabled else { return }
                    isAtBottom = reachedLatest
                    if reachedLatest, hasMessages {
                        hasPositionedInitialTimeline = true
                    }
                }
        } else {
            content
        }
    }
}

private struct EmptyConversation: View {
    let conversation: ConversationSummary

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
        if conversation.kind == .agent {
            return conversation.agentDisplayName?.nonEmpty ?? "My Kordi"
        }
        return conversation.displayName
    }

    private var emptyStateText: String {
        switch conversation.kind {
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
