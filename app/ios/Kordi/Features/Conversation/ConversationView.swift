import SwiftUI
import QuickLook
import PhotosUI
import UniformTypeIdentifiers
import UIKit

struct ConversationView: View {
    @EnvironmentObject private var model: AppModel
    private let initialConversation: ConversationSummary
    @State private var draft = ""
    @State private var isSending = false
    @State private var visibleMessageLimit = ConversationTimelineWindow.initialLimit
    @State private var isLoadingEarlier = false
    @State private var isAtBottom = true
    @State private var attachments: [PendingAttachment] = []
    @State private var replySource: MessageActionSource?
    @State private var selectedMention: ComposerMentionTarget?
    @State private var showFileImporter = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isPreparingAttachments = false
    @State private var previewURL: URL?
    @State private var shareItem: SharedFileItem?
    @State private var showSessionDetails = false
    @State private var showAgentModel = false
    @State private var highlightedMessageID: String?
    @State private var selectedMessageIDs = Set<String>()
    @State private var forwardRequest: MessageForwardRequest?
    @State private var detailsMessage: ChatMessage?
    @State private var pinTarget: ChatMessage?
    @State private var forwardedDestination: ConversationSummary?

    init(conversation: ConversationSummary) {
        initialConversation = conversation
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

                GeometryReader { viewport in
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
                                            onOpenAttachment: { attachment in
                                                prepare(attachment, forSharing: false)
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
                        }
                        .frame(
                            minHeight: max(0, viewport.size.height - timelineVerticalInset * 2),
                            alignment: .top
                        )
                        .padding(.horizontal, 12)
                        .padding(.vertical, timelineVerticalInset)
                        .overlay(alignment: .bottom) {
                            Color.clear
                                .frame(height: 1)
                                .id(bottomAnchorID)
                                .onAppear { isAtBottom = true }
                                .onDisappear { isAtBottom = false }
                        }
                    }
                    .background(Color(uiColor: .systemGroupedBackground))
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .onAppear {
                scrollToBottom(proxy)
            }
            .onChange(of: timeline.count) { oldCount, newCount in
                guard newCount > oldCount else { return }
                visibleMessageLimit = min(
                    newCount,
                    visibleMessageLimit + (newCount - oldCount)
                )
                if isAtBottom || oldCount == 0 {
                    scrollToBottom(proxy)
                }
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
        .task {
            await model.loadConversation(conversation)
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

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            await Task.yield()
            proxy.scrollTo(bottomAnchorID, anchor: .bottom)
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
        let outgoingReply = conversation.kind.supportsQuotedReplies ? replySource : nil
        let outgoingMention = resolvedMentionTarget(in: message)
        draft = ""
        attachments = []
        replySource = nil
        selectedMention = nil
        isSending = true
        await model.send(
            message,
            attachments: outgoingAttachments,
            replyingTo: outgoingReply,
            mentioning: outgoingMention,
            to: conversation
        )
        isSending = false
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
                attachments.append(contentsOf: loaded)
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
}

enum ConversationTimelineWindow {
    static let initialLimit = 64
    static let pageSize = 64

    static func visibleMessages(in messages: [ChatMessage], limit: Int) -> [ChatMessage] {
        guard limit > 0, messages.count > limit else { return messages }
        return Array(messages.suffix(limit))
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
