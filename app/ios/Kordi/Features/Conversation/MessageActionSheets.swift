import SwiftUI
import UIKit

struct MessageForwardRequest: Identifiable {
    let id = UUID()
    let sourceConversation: ConversationSummary
    let messages: [ChatMessage]
}

struct ForwardMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let request: MessageForwardRequest
    let onComplete: (ConversationSummary) -> Void

    @State private var selectedDestination: ConversationSummary?
    @State private var caption = ""
    @State private var isForwarding = false

    private var destinations: [ConversationSummary] {
        model.conversations
            .filter { $0.sessionId != request.sourceConversation.sessionId && !$0.representsKordiSupport }
            .sorted {
                $0.lastActivityAt > $1.lastActivityAt || (
                    $0.lastActivityAt == $1.lastActivityAt
                        && $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
                )
            }
    }

    var body: some View {
        NavigationStack {
            List {
                Section(request.messages.count == 1 ? "Forwarding message" : "Forwarding \(request.messages.count) messages") {
                    ForEach(request.messages.prefix(3)) { message in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(message.authorName)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(message.text.nonEmpty ?? attachmentSummary(message.attachments.count))
                                .font(.subheadline)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                    if request.messages.count > 3 {
                        Text("+\(request.messages.count - 3) more")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if request.messages.count == 1 {
                    Section("Optional comment") {
                        TextField("Add a comment…", text: $caption, axis: .vertical)
                            .lineLimit(2...4)
                    }
                }

                Section("Choose a chat") {
                    if destinations.isEmpty {
                        ContentUnavailableView(
                            "No other chats",
                            systemImage: "arrowshape.turn.up.right",
                            description: Text("Start another chat before forwarding this message.")
                        )
                    } else {
                        ForEach(destinations) { destination in
                            Button {
                                selectedDestination = destination
                            } label: {
                                HStack(spacing: 11) {
                                    destinationAvatar(destination)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(destination.displayName)
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(.primary)
                                            .lineLimit(1)
                                        Text(destinationSubtitle(destination))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: selectedDestination?.id == destination.id ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selectedDestination?.id == destination.id ? KordiTheme.signalBlue : Color.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Forward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        forward()
                    } label: {
                        if isForwarding {
                            ProgressView()
                        } else {
                            Text("Forward")
                        }
                    }
                    .disabled(selectedDestination == nil || isForwarding)
                }
            }
        }
    }

    @ViewBuilder
    private func destinationAvatar(_ destination: ConversationSummary) -> some View {
        if destination.kind == .group {
            GroupAvatarStack(participants: destination.groupParticipants, size: 38)
        } else {
            IdentityAvatar(
                name: destination.agentDisplayName?.nonEmpty ?? destination.displayName,
                imageSource: destination.avatarSource,
                kind: destination.kind,
                size: 38,
                seed: destination.agentId?.nonEmpty ?? destination.peerAccountId.nonEmpty ?? destination.sessionId
            )
        }
    }

    private func destinationSubtitle(_ destination: ConversationSummary) -> String {
        switch destination.kind {
        case .person: "Contact"
        case .agent: destination.agentDisplayName?.nonEmpty ?? "Agent session"
        case .group: "Group · \(destination.groupParticipants.count) people"
        }
    }

    private func attachmentSummary(_ count: Int) -> String {
        count == 1 ? "1 attachment" : "\(count) attachments"
    }

    private func forward() {
        guard let selectedDestination else { return }
        isForwarding = true
        Task {
            let didForward = await model.forward(
                request.messages,
                caption: caption,
                from: request.sourceConversation,
                to: selectedDestination
            )
            isForwarding = false
            guard didForward else { return }
            dismiss()
            onComplete(selectedDestination)
        }
    }
}

struct MessageDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let message: ChatMessage
    let readers: [CloudGroupParticipant]

    var body: some View {
        NavigationStack {
            List {
                Section("Message") {
                    LabeledContent("From", value: message.authorName)
                    LabeledContent("Sent", value: message.createdAt.formatted(date: .abbreviated, time: .shortened))
                    LabeledContent("Status", value: message.deliveryState.label)
                    if readers.isEmpty, let count = message.readByCount, count > 0 {
                        LabeledContent("Seen by", value: "\(count) people")
                    }
                    if message.messageAction?.kind == "forward" {
                        LabeledContent("Forwarded from", value: message.messageAction?.source.senderLabel ?? "Message")
                    }
                }

                if !readers.isEmpty {
                    Section("Seen by") {
                        ForEach(readers) { reader in
                            HStack(spacing: 12) {
                                IdentityAvatar(
                                    name: reader.displayName,
                                    imageSource: reader.avatarUrl,
                                    kind: .person,
                                    size: 34,
                                    seed: reader.accountId
                                )
                                Text(reader.displayName)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("Seen by \(reader.displayName)")
                        }
                    }
                }

                if !message.text.isEmpty {
                    Section("Content") {
                        Text(message.text)
                            .textSelection(.enabled)
                    }
                }

                if !message.attachments.isEmpty {
                    Section("Attachments") {
                        ForEach(message.attachments) { attachment in
                            Label(attachment.name, systemImage: attachment.kind == .image ? "photo" : "doc")
                        }
                    }
                }
            }
            .navigationTitle("Message details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

enum MessageReadReceiptPresentation {
    static func readers(
        for message: ChatMessage,
        in conversation: ConversationSummary
    ) -> [CloudGroupParticipant] {
        guard message.author == .me else { return [] }
        if conversation.kind == .group {
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
        guard conversation.kind == .person,
              message.readByAccountIds.contains(conversation.peerAccountId) else { return [] }
        return [CloudGroupParticipant(
            accountId: conversation.peerAccountId,
            displayName: conversation.ownerDisplayName?.nonEmpty ?? conversation.displayName,
            avatarUrl: conversation.avatarSource,
            role: nil
        )]
    }

    static func label(
        for message: ChatMessage,
        readers: [CloudGroupParticipant]
    ) -> String? {
        guard message.author == .me, message.deliveryState == .read else { return nil }
        let count = max(message.readByCount ?? 0, readers.count)
        return count > 0 ? "\(count) Seen" : nil
    }
}

struct ConversationSelectionBar: View {
    let count: Int
    let onCancel: () -> Void
    let onCopy: () -> Void
    let onForward: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button("Cancel", action: onCancel)
                .frame(minWidth: 56, minHeight: 44)

            Text("\(count) selected")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)

            Button(action: onCopy) {
                Image(systemName: "doc.on.doc")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Copy selected messages")

            Button(action: onForward) {
                Image(systemName: "arrowshape.turn.up.right")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Forward selected messages")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

struct PinnedMessageItem: Identifiable, Equatable {
    let message: ChatMessage
    let scope: String

    var id: String { "\(scope):\(message.id)" }
    var scopeDescription: String { scope == "shared" ? "for everyone" : "only for you" }
}

struct PinnedMessageBar: View {
    let items: [PinnedMessageItem]
    let onOpen: (PinnedMessageItem) -> Void
    let onUnpin: (PinnedMessageItem) -> Void
    @State private var isExpanded = false

    private var isCollapsible: Bool { items.count > 1 }
    private var showsItems: Bool { !isCollapsible || isExpanded }
    private var heading: String {
        "\(items.count) pinned \(items.count == 1 ? "message" : "messages")"
    }

    private var header: some View {
        HStack(spacing: 7) {
            Image(systemName: "pin.fill")
                .font(.caption2.weight(.semibold))
            Text(heading)
                .font(.caption2.weight(.semibold))
            Spacer(minLength: 0)
            if isCollapsible {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
            }
        }
        .foregroundStyle(KordiTheme.signalBlue)
        .padding(.horizontal, 14)
        .frame(minHeight: isCollapsible ? 44 : 28)
        .contentShape(Rectangle())
    }

    var body: some View {
        VStack(spacing: 0) {
            if !items.isEmpty {
                if isCollapsible {
                    Button {
                        withAnimation(.easeOut(duration: 0.16)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        header
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(heading)")
                    .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
                } else {
                    header
                }

                if showsItems {
                    ForEach(items) { item in
                        HStack(spacing: 8) {
                            Button { onOpen(item) } label: {
                                HStack(spacing: 8) {
                                    Text(item.message.text.nonEmpty ?? "Attachment")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Open message pinned \(item.scopeDescription)")

                            Button { onUnpin(item) } label: {
                                Image(systemName: "xmark")
                                    .font(.caption.weight(.semibold))
                                    .frame(width: 44, height: 44)
                            }
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Unpin message pinned \(item.scopeDescription)")
                        }
                        .padding(.leading, 14)
                        .overlay(alignment: .bottom) {
                            if item.id != items.last?.id { Divider().padding(.leading, 14) }
                        }
                    }
                }
            }
        }
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct MessageActionOverlayLayout: Equatable {
    let previewFrame: CGRect
    let reactionCenter: CGPoint
    let menuCenter: CGPoint
    let pickerCenter: CGPoint
    let reactionWidth: CGFloat
    let menuWidth: CGFloat
    let menuHeight: CGFloat
    let pickerWidth: CGFloat
    let pickerHeight: CGFloat
    let menuIsBelow: Bool

    static func make(
        sourceFrame: CGRect,
        containerSize: CGSize,
        showsReactions: Bool,
        reactionCount: Int,
        actionCount: Int,
        forcedMenuIsBelow: Bool? = nil,
        fixedPreviewFrame: CGRect? = nil
    ) -> Self {
        let margin: CGFloat = 12
        let reactionHeight: CGFloat = showsReactions ? 52 : 0
        let menuWidth = min(238, containerSize.width - margin * 2)
        let preferredMenuHeight = CGFloat(actionCount) * 44 + 10
        // Reserve space for the whole presentation before positioning any surface.
        // Moving/scaling the live bubble preserves selection and animated media.
        let availableHeight = max(1, containerSize.height - margin * 2)
        let gaps: CGFloat = showsReactions ? 16 : 8
        let minimumPreviewHeight = min(sourceFrame.height, 80)
        let menuHeight = min(
            preferredMenuHeight,
            max(44, availableHeight - reactionHeight - gaps - minimumPreviewHeight)
        )
        let previewHeight = max(1, availableHeight - reactionHeight - gaps - menuHeight)
        let scale = min(1, previewHeight / max(1, sourceFrame.height),
                        max(1, containerSize.width - margin * 2) / max(1, sourceFrame.width))
        let previewSize = CGSize(width: sourceFrame.width * scale, height: sourceFrame.height * scale)
        let below = containerSize.height - sourceFrame.maxY - margin
        let above = sourceFrame.minY - margin - reactionHeight - gaps
        let placeMenuBelow = forcedMenuIsBelow ?? (below >= preferredMenuHeight + 8 || below >= above)
        let topReservation = placeMenuBelow
            ? reactionHeight + (showsReactions ? 8 : 0)
            : menuHeight + reactionHeight + gaps
        let bottomReservation = placeMenuBelow ? menuHeight + 8 : 0
        let previewTop = min(
            max(sourceFrame.minY, margin + topReservation),
            max(margin + topReservation, containerSize.height - margin - bottomReservation - previewSize.height)
        )
        let previewFrame = fixedPreviewFrame ?? CGRect(
            x: clamped(sourceFrame.midX, half: previewSize.width / 2,
                       extent: containerSize.width, margin: margin) - previewSize.width / 2,
            y: previewTop, width: previewSize.width, height: previewSize.height
        )
        let reactionWidth = min(
            containerSize.width - margin * 2,
            CGFloat(max(1, reactionCount + 1)) * 46 + 12
        )
        let pickerWidth = min(360, containerSize.width - margin * 2)
        let preferredPickerHeight = min(520, max(320, containerSize.height * 0.62))
        let reactionCenterY = previewFrame.minY - (showsReactions ? 8 : 0) - reactionHeight / 2
        let pickerHeight = min(preferredPickerHeight, max(52, availableHeight))
        let pickerTop = min(
            max(margin, reactionCenterY - reactionHeight / 2),
            max(margin, containerSize.height - margin - pickerHeight)
        )
        let menuY = placeMenuBelow
            ? previewFrame.maxY + 8 + menuHeight / 2
            : previewFrame.minY - reactionHeight - gaps - menuHeight / 2
        return Self(
            previewFrame: previewFrame,
            reactionCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: previewFrame,
                    width: reactionWidth,
                    containerWidth: containerSize.width,
                    margin: margin
                ),
                y: reactionCenterY
            ),
            menuCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: previewFrame,
                    width: menuWidth,
                    containerWidth: containerSize.width,
                    margin: margin
                ),
                y: clamped(menuY, half: menuHeight / 2, extent: containerSize.height, margin: margin)
            ),
            pickerCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: previewFrame,
                    width: pickerWidth,
                    containerWidth: containerSize.width,
                    margin: margin
                ),
                y: pickerTop + pickerHeight / 2
            ),
            reactionWidth: reactionWidth,
            menuWidth: menuWidth,
            menuHeight: menuHeight,
            pickerWidth: pickerWidth,
            pickerHeight: pickerHeight,
            menuIsBelow: placeMenuBelow
        )
    }

    private static func alignedCenter(
        sourceFrame: CGRect,
        width: CGFloat,
        containerWidth: CGFloat,
        margin: CGFloat
    ) -> CGFloat {
        let preferred = sourceFrame.midX < containerWidth / 2
            ? sourceFrame.minX + width / 2
            : sourceFrame.maxX - width / 2
        return clamped(preferred, half: width / 2, extent: containerWidth, margin: margin)
    }

    private static func clamped(
        _ value: CGFloat,
        half: CGFloat,
        extent: CGFloat,
        margin: CGFloat
    ) -> CGFloat {
        min(max(value, margin + half), max(margin + half, extent - margin - half))
    }
}

struct MessageActionOverlay: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(BlobEmojiRecentStore.key) private var storedRecentEmojiIDs = "[]"
    @State private var hasPresented = false
    @State private var showsAllReactions = false
    @State private var isConfirmingDelete = false
    @State private var didSchedulePreviewExpansion = false
    let message: ChatMessage
    let sourceFrame: CGRect
    let usableFrame: CGRect
    let onPreviewFrameChange: (CGRect, Bool) -> Void
    let ownAccountId: String?
    let allowsConversationReply: Bool
    let allowsThreadReply: Bool
    let allowsReactions: Bool
    let allowsEdit: Bool
    let allowsDelete: Bool
    let deleteForEveryoneLabel: String
    let isPinned: Bool
    let mediaAttachment: ChatAttachment?
    let readReceiptLabel: String?
    let readReceiptReaders: [CloudGroupParticipant]
    let onDismiss: () -> Void
    let onReviewAttachment: () -> Void
    let onShareAttachment: () -> Void
    let onAddAttachmentToMediaLibrary: () -> Void
    let onReact: (String) -> Void
    let onReply: (MessageReplyDestination) -> Void
    let onPin: () -> Void
    let onCopy: () -> Void
    let onShareMessage: () -> Void
    let onForward: () -> Void
    let onEdit: () -> Void
    let onDelete: (Bool) -> Void
    let onSaveSticker: (ChatAttachment) -> Void
    let onSelect: () -> Void

    private var quickReactions: [EmojiPickerItem] {
        EmojiRecentStore.quickReactions(from: storedRecentEmojiIDs)
    }

    private var regularActionCount: Int {
        (allowsConversationReply ? 1 : 0)
            + (allowsThreadReply ? 1 : 0)
            + (!message.text.isEmpty ? 2 : 0)
            + 3
            + (allowsEdit ? 1 : 0)
            + (allowsDelete ? 1 : 0)
            + mediaActionCount
            + (stickerAttachment == nil ? 0 : 1)
            + (readReceiptLabel == nil ? 0 : 1)
    }

    private var actionCount: Int {
        isConfirmingDelete ? (message.author == .me ? 2 : 1) : regularActionCount
    }

    private var mediaKind: ExpressiveMediaLibraryKind? {
        guard let mediaAttachment else { return nil }
        return ExpressiveMediaLibraryKind.supportedKind(
            name: mediaAttachment.name,
            mimeType: mediaAttachment.mimeType
        )
    }

    private var mediaActionCount: Int {
        guard mediaAttachment != nil else { return 0 }
        return mediaKind == nil ? 2 : 3
    }

    private var stickerAttachment: ChatAttachment? {
        MessageImageInteraction.stickerAttachment(in: message)
    }

    private var hasRecentReactions: Bool {
        !EmojiRecentStore.items(from: storedRecentEmojiIDs).isEmpty
    }

    var body: some View {
        GeometryReader { geometry in
            let containerFrame = geometry.frame(in: .global)
            let layoutFrame = usableFrame.isEmpty ? containerFrame : usableFrame
            let localSourceFrame = sourceFrame.offsetBy(
                dx: -containerFrame.minX,
                dy: -containerFrame.minY
            )
            let sourceFrameInLayout = sourceFrame.offsetBy(
                dx: -layoutFrame.minX,
                dy: -layoutFrame.minY
            )
            let layoutOffset = CGSize(
                width: layoutFrame.minX - containerFrame.minX,
                height: layoutFrame.minY - containerFrame.minY
            )
            let regularLayout = MessageActionOverlayLayout.make(
                sourceFrame: sourceFrameInLayout,
                containerSize: layoutFrame.size,
                showsReactions: allowsReactions,
                reactionCount: allowsReactions ? quickReactions.count : 0,
                actionCount: regularActionCount
            )
            let showsReactionSurface = allowsReactions && !isConfirmingDelete
            let layout = MessageActionOverlayLayout.make(
                sourceFrame: sourceFrameInLayout,
                containerSize: layoutFrame.size,
                showsReactions: showsReactionSurface,
                reactionCount: showsReactionSurface ? quickReactions.count : 0,
                actionCount: actionCount,
                forcedMenuIsBelow: regularLayout.menuIsBelow,
                fixedPreviewFrame: regularLayout.previewFrame
            )
            let previewFrame = regularLayout.previewFrame.offsetBy(
                dx: layoutOffset.width, dy: layoutOffset.height
            )
            ZStack {
                dismissalBackdrop(cutout: hasPresented ? previewFrame : localSourceFrame)
                    .opacity(hasPresented ? 1 : 0)

                if showsReactionSurface {
                    reactionSurface
                        .frame(
                            width: showsAllReactions ? layout.pickerWidth : layout.reactionWidth,
                            height: showsAllReactions ? layout.pickerHeight : 52,
                            alignment: .top
                        )
                        .background {
                            ZStack {
                                RoundedRectangle(cornerRadius: 26, style: .continuous)
                                    .fill(.regularMaterial)
                                RoundedRectangle(cornerRadius: 26, style: .continuous)
                                    .fill(Color(uiColor: .systemBackground).opacity(0.5))
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .shadow(
                            color: .black.opacity(showsAllReactions ? 0.14 : 0.12),
                            radius: showsAllReactions ? 20 : 16,
                            y: showsAllReactions ? 10 : 8
                        )
                        .position(
                            showsAllReactions ? layout.pickerCenter : layout.reactionCenter
                        )
                        .offset(layoutOffset)
                        .scaleEffect(reduceMotion || hasPresented ? 1 : 0.96)
                        .opacity(hasPresented ? 1 : 0)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
                }

                if isConfirmingDelete || !showsAllReactions || !allowsReactions {
                    actionMenu
                        .frame(
                            width: layout.menuWidth,
                            height: layout.menuHeight,
                            alignment: .top
                        )
                        .position(layout.menuCenter)
                        .offset(layoutOffset)
                        .scaleEffect(reduceMotion || hasPresented ? 1 : 0.96)
                        .opacity(hasPresented ? 1 : 0)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
                }
            }
            .animation(MessageActionMotion.animation(reduceMotion: reduceMotion), value: sourceFrame)
            .animation(
                reduceMotion ? nil : .smooth(duration: 0.22),
                value: isConfirmingDelete
            )
            .onAppear {
                withAnimation(MessageActionMotion.animation(reduceMotion: reduceMotion)) {
                    hasPresented = true
                    onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                        dx: layoutFrame.minX, dy: layoutFrame.minY
                    ), !showsAllReactions)
                }
            }
            .onChange(of: regularLayout.previewFrame) {
                onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                    dx: layoutFrame.minX, dy: layoutFrame.minY
                ), !showsAllReactions)
            }
            .onChange(of: showsAllReactions) {
                onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                    dx: layoutFrame.minX, dy: layoutFrame.minY
                ), !showsAllReactions)
            }
            .onChange(of: layoutFrame) {
                onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                    dx: layoutFrame.minX, dy: layoutFrame.minY
                ), !showsAllReactions)
            }
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Actions for message from \(message.authorName)")
        .accessibilityIdentifier("message-actions-\(message.id)")
        .onAppear {
            guard ProcessInfo.processInfo.arguments.contains("--preview-expanded-reactions"),
                  !didSchedulePreviewExpansion else {
                return
            }
            didSchedulePreviewExpansion = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
                    showsAllReactions = true
                }
            }
        }
    }

    private func dismissalBackdrop(cutout: CGRect) -> some View {
        Button(action: onDismiss) {
            ZStack {
                MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,
                                      sourceWidth: sourceFrame.width, isMedia: mediaAttachment != nil)
                    .fill(.ultraThinMaterial, style: FillStyle(eoFill: true))
                MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,
                                      sourceWidth: sourceFrame.width, isMedia: mediaAttachment != nil)
                    .fill(.black.opacity(0.08), style: FillStyle(eoFill: true))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(
                mediaAttachment == nil
                    ? AnyShape(MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,
                                      sourceWidth: sourceFrame.width, isMedia: mediaAttachment != nil))
                    : AnyShape(Rectangle()),
                eoFill: mediaAttachment == nil
            )
        }
        .buttonStyle(.plain)
        .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
        }
        .accessibilityLabel("Close message actions")
    }

    private var reactionSurface: some View {
        VStack(spacing: 0) {
            reactionButtons
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(.bar)

            if showsAllReactions {
                Divider()
                EmojiSelectionBoard(
                    initialCategory: hasRecentReactions ? .recent : .noto
                ) { item in
                    onReact(item.reactionValue)
                }
                .transition(.opacity)
            }
        }
    }

    private var reactionButtons: some View {
        HStack(spacing: 2) {
            ForEach(quickReactions) { item in
                Button {
                    storedRecentEmojiIDs = EmojiRecentStore.recording(
                        item,
                        in: storedRecentEmojiIDs
                    )
                    onReact(item.reactionValue)
                } label: {
                    reactionImage(item)
                        .frame(width: 44, height: 44)
                        .background(
                            message.reactions
                                .first(where: { $0.value == item.reactionValue })?
                                .includes(accountId: ownAccountId) == true
                                ? KordiTheme.agentViolet.opacity(0.14)
                                : .clear,
                            in: Circle()
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(MessageReactionButtonStyle())
                .accessibilityLabel("React with \(item.accessibilityName)")
            }
            Button {
                let willExpand = !showsAllReactions
                withAnimation(
                    reduceMotion
                        ? nil
                        : willExpand ? .smooth(duration: 0.3) : .easeOut(duration: 0.18)
                ) {
                    showsAllReactions.toggle()
                }
            } label: {
                Image(systemName: showsAllReactions ? "chevron.up" : "chevron.down")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                showsAllReactions ? "Collapse reaction picker" : "Show all reactions"
            )
        }
    }

    @ViewBuilder
    private func reactionImage(_ item: EmojiPickerItem) -> some View {
        switch item {
        case .noto(let emoji):
            NotoEmojiView(emoji: emoji, size: 30)
        case .blob(let emoji):
            BlobEmojiView(emoji: emoji, size: 30)
        }
    }

    private var actionMenu: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                if isConfirmingDelete {
                    if message.author == .me {
                        deleteChoiceButton(deleteForEveryoneLabel) { onDelete(true) }
                        Divider().padding(.horizontal, 14)
                    }
                    deleteChoiceButton("Delete for me") { onDelete(false) }
                } else {
                    if mediaAttachment != nil {
                        actionButton("Review", systemImage: "eye", action: onReviewAttachment)
                        actionButton(
                            "Download / Save to Files",
                            systemImage: "arrow.down.circle",
                            action: onShareAttachment
                        )
                        if let mediaKind {
                            actionButton(
                                "Add to \(mediaKind.libraryName)",
                                systemImage: "square.stack.3d.up",
                                action: onAddAttachmentToMediaLibrary
                            )
                        }
                        Divider().padding(.horizontal, 14)
                    }
                    if allowsConversationReply {
                        actionButton("Reply in conversation", systemImage: "message") {
                            onReply(.conversation)
                        }
                    }
                    if allowsThreadReply {
                        actionButton("Reply in thread", systemImage: "sidebar.right") {
                            onReply(.thread)
                        }
                    }
                    if !message.text.isEmpty {
                        actionButton("Copy", systemImage: "doc.on.doc", action: onCopy)
                        actionButton(
                            "Share",
                            systemImage: "square.and.arrow.up",
                            action: onShareMessage
                        )
                    }
                    if allowsEdit {
                        actionButton("Edit", systemImage: "pencil", action: onEdit)
                    }
                    actionButton(
                        "Forward",
                        systemImage: "arrowshape.turn.up.right",
                        disabled: message.deliveryState == .sending || message.deliveryState == .failed,
                        action: onForward
                    )
                    if let stickerAttachment {
                        actionButton(
                            "Save to My Stickers",
                            systemImage: "square.stack.3d.up",
                            action: { onSaveSticker(stickerAttachment) }
                        )
                    }
                    actionButton(
                        isPinned ? "Unpin" : "Pin",
                        systemImage: "pin",
                        disabled: message.deliveryState == .sending || message.deliveryState == .failed,
                        action: onPin
                    )
                    Divider().padding(.horizontal, 14)
                    actionButton("Select", systemImage: "checkmark.circle", action: onSelect)
                    if allowsDelete {
                        actionButton(
                            "Delete",
                            systemImage: "trash",
                            role: .destructive,
                            action: {
                                withAnimation(reduceMotion ? nil : .smooth(duration: 0.22)) {
                                    isConfirmingDelete = true
                                }
                            }
                        )
                    }
                    MessageActionReadReceiptRow(
                        label: readReceiptLabel,
                        readers: readReceiptReaders
                    )
                }
            }
            .padding(.vertical, 4)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(.regularMaterial)
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color(uiColor: .systemBackground).opacity(0.72))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 18, y: 10)
    }

    private func deleteChoiceButton(
        _ title: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: .destructive, action: action) {
            Text(title)
                .font(.body)
                .foregroundStyle(.red)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func actionButton(
        _ title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            Label(title, systemImage: systemImage)
                .font(.body)
                .foregroundStyle(role == .destructive ? Color.red : Color.primary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

private struct MessageActionReadReceiptRow: View {
    @ScaledMetric(relativeTo: .footnote) private var avatarSize = 18.0
    let label: String?
    let readers: [CloudGroupParticipant]

    @ViewBuilder
    var body: some View {
        if let label {
            Divider().padding(.horizontal, 14)
            HStack(spacing: 10) {
                MessageDeliveryGlyph(state: .read, readByCount: readers.count)
                    .foregroundStyle(.secondary)
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if !readers.isEmpty {
                    HStack(spacing: -4) {
                        ForEach(Array(readers.prefix(4).enumerated()), id: \.element.id) { index, reader in
                            IdentityAvatar(
                                name: reader.displayName,
                                imageSource: reader.avatarUrl,
                                kind: .person,
                                size: avatarSize,
                                seed: reader.accountId
                            )
                            .overlay {
                                Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1)
                            }
                            .zIndex(Double(index))
                        }
                    }
                    .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 16)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel ?? label)
        }
    }

    private var accessibilityLabel: String? {
        let names = readers.map(\.displayName).compactMap(\.nonEmpty)
        return names.isEmpty ? nil : "Seen by \(names.joined(separator: ", "))"
    }
}

struct WindowOverlayPresenter<Content: View>: UIViewRepresentable {
    let passthroughFrame: CGRect?
    private let allowsInteraction: Bool
    private let animatesRemoval: Bool
    private let onDismissComplete: () -> Void
    private let content: (CGRect) -> Content

    init(
        passthroughFrame: CGRect?,
        allowsInteraction: Bool = true,
        animatesRemoval: Bool = true,
        onDismissComplete: @escaping () -> Void = {},
        @ViewBuilder content: @escaping (CGRect) -> Content
    ) {
        self.passthroughFrame = passthroughFrame
        self.allowsInteraction = allowsInteraction
        self.animatesRemoval = animatesRemoval
        self.onDismissComplete = onDismissComplete
        self.content = content
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(rootView: content(.zero))
    }

    func makeUIView(context: Context) -> UIView {
        let view = WindowOverlayAnchorView(frame: .zero)
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        let passthroughFrame = self.passthroughFrame
        let content = self.content
        let coordinator = context.coordinator
        coordinator.onDismissComplete = onDismissComplete
        coordinator.allowsInteraction = allowsInteraction
        coordinator.animatesRemoval = animatesRemoval
        let update = { [weak uiView, weak coordinator] in
            guard let uiView, let coordinator else { return }
            coordinator.install(
                from: uiView,
                passthroughFrame: passthroughFrame,
                content: content
            )
        }
        (uiView as? WindowOverlayAnchorView)?.onWindowAttached = update
        if uiView.window != nil { update() }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        (uiView as? WindowOverlayAnchorView)?.onWindowAttached = nil
        coordinator.remove(
            animated: coordinator.animatesRemoval && !UIAccessibility.isReduceMotionEnabled,
            completion: coordinator.onDismissComplete
        )
    }

    @MainActor
    final class Coordinator {
        private let container = MessageActionWindowOverlayView()
        private let hostingController: UIHostingController<Content>
        private weak var window: UIWindow?
        var onDismissComplete: () -> Void = {}
        var allowsInteraction = true
        var animatesRemoval = true

        init(rootView: Content) {
            hostingController = UIHostingController(rootView: rootView)
            hostingController.view.backgroundColor = .clear
        }

        func install(
            from anchor: UIView,
            passthroughFrame: CGRect?,
            content: (CGRect) -> Content
        ) {
            guard let window = anchor.window else { return }
            let usableFrame = anchor.convert(anchor.bounds, to: window)
            hostingController.rootView = content(usableFrame)
            container.passthroughFrame = passthroughFrame
            container.isUserInteractionEnabled = allowsInteraction

            if container.superview === window {
                container.frame = window.bounds
                window.bringSubviewToFront(container)
                return
            }

            remove(animated: false)
            self.window = window
            container.frame = window.bounds
            container.alpha = 1
            container.isUserInteractionEnabled = allowsInteraction
            container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            hostingController.view.frame = container.bounds
            hostingController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(hostingController.view)
            window.addSubview(container)
        }

        func remove(animated: Bool, completion: @escaping () -> Void = {}) {
            guard animated, container.superview != nil else {
                detach()
                completion()
                return
            }
            container.isUserInteractionEnabled = false
            UIView.animate(
                withDuration: 0.18,
                delay: 0,
                options: [.beginFromCurrentState, .curveEaseOut, .allowAnimatedContent]
            ) {
                self.container.alpha = 0
            } completion: { _ in
                self.detach()
                completion()
            }
        }

        private func detach() {
            hostingController.view.removeFromSuperview()
            container.removeFromSuperview()
            window = nil
        }
    }
}

private final class WindowOverlayAnchorView: UIView {
    var onWindowAttached: (() -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { onWindowAttached?() }
    }
}

private final class MessageActionWindowOverlayView: UIView {
    var passthroughFrame: CGRect?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if let passthroughFrame, passthroughFrame.contains(point) {
            return false
        }
        return super.point(inside: point, with: event)
    }
}

private struct MessageActionBackdrop: Shape {
    var cutout: CGRect
    let sourceAuthor: MessageAuthor
    let sourceWidth: CGFloat
    let isMedia: Bool

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(AnimatablePair(cutout.minX, cutout.minY), AnimatablePair(cutout.width, cutout.height)) }
        set {
            cutout = CGRect(x: newValue.first.first, y: newValue.first.second,
                            width: newValue.second.first, height: newValue.second.second)
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        let scale = max(0.001, cutout.width / max(1, sourceWidth))
        let bounds = CGRect(x: 0, y: 0, width: cutout.width / scale, height: cutout.height / scale)
        let outline = isMedia
            ? RoundedRectangle(cornerRadius: 12, style: .continuous).path(in: bounds)
            : MessageBubbleGeometry.shape(for: sourceAuthor).path(in: bounds)
        path.addPath(outline.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                                       tx: cutout.minX, ty: cutout.minY)))
        return path
    }
}

/// Shared by the live bubble and the window-hosted overlay.
enum MessageActionMotion {
    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: 0.15) : .smooth(duration: 0.22)
    }
}

struct MessageActionBubblePlacement: Equatable {
    let sourceFrame: CGRect
    let previewFrame: CGRect

    var scale: CGFloat { previewFrame.width / max(1, sourceFrame.width) }

    func anchor(in frame: CGRect) -> UnitPoint {
        UnitPoint(x: (sourceFrame.midX - frame.minX) / max(1, frame.width),
                  y: (sourceFrame.midY - frame.minY) / max(1, frame.height))
    }

    var offset: CGSize {
        CGSize(width: previewFrame.midX - sourceFrame.midX,
               height: previewFrame.midY - sourceFrame.midY)
    }
}

private struct MessageReactionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 1.16 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(reduceMotion ? nil : .smooth(duration: 0.18), value: configuration.isPressed)
    }
}
