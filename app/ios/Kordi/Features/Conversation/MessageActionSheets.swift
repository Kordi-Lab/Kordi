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
    let scrollLimit: CGFloat

    static func make(
        sourceFrame: CGRect,
        containerSize: CGSize,
        showsReactions: Bool,
        reactionCount: Int,
        actionCount: Int,
        alignsTrailing: Bool? = nil,
        forcedMenuIsBelow: Bool? = nil,
        fixedPreviewFrame: CGRect? = nil
    ) -> Self {
        let margin: CGFloat = 12
        let reactionHeight: CGFloat = showsReactions ? 52 : 0
        let menuWidth = min(238, containerSize.width - margin * 2)
        let preferredMenuHeight = CGFloat(actionCount) * 44 + 10
        let availableHeight = max(1, containerSize.height - margin * 2)
        let gaps: CGFloat = showsReactions ? 16 : 8
        let menuHeight = min(
            preferredMenuHeight,
            max(44, availableHeight - reactionHeight - gaps - min(sourceFrame.height, 80))
        )
        // Preserve the exact source size. Tall messages extend above the viewport
        // and scroll with their actions instead of becoming miniature text.
        let overflows = sourceFrame.height + reactionHeight + gaps + menuHeight > availableHeight
        let below = containerSize.height - sourceFrame.maxY - margin
        let above = sourceFrame.minY - margin - reactionHeight - gaps
        let placeMenuBelow = forcedMenuIsBelow ?? (overflows || below >= preferredMenuHeight + 8 || below >= above)
        let topReservation = placeMenuBelow
            ? reactionHeight + (showsReactions ? 8 : 0)
            : menuHeight + reactionHeight + gaps
        let bottomReservation = placeMenuBelow ? menuHeight + 8 : 0
        let previewTop = overflows
            ? containerSize.height - margin - bottomReservation - sourceFrame.height
            : min(max(sourceFrame.minY, margin + topReservation),
                  containerSize.height - margin - bottomReservation - sourceFrame.height)
        let previewFrame = fixedPreviewFrame ?? CGRect(
            x: clamped(sourceFrame.midX, half: sourceFrame.width / 2,
                       extent: containerSize.width, margin: margin) - sourceFrame.width / 2,
            y: previewTop, width: sourceFrame.width, height: sourceFrame.height
        )
        let scrollLimit = max(0, margin + reactionHeight + (showsReactions ? 8 : 0) - previewFrame.minY)
        let reactionWidth = min(
            containerSize.width - margin * 2,
            CGFloat(max(1, reactionCount + 1)) * 46 + 12
        )
        let pickerWidth = min(360, containerSize.width - margin * 2)
        let preferredPickerHeight = min(520, max(320, containerSize.height * 0.62))
        let reactionCenterY = max(margin + reactionHeight / 2,
                                  previewFrame.minY - (showsReactions ? 8 : 0) - reactionHeight / 2)
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
                    margin: margin,
                    alignsTrailing: alignsTrailing
                ),
                y: reactionCenterY
            ),
            menuCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: previewFrame,
                    width: menuWidth,
                    containerWidth: containerSize.width,
                    margin: margin,
                    alignsTrailing: alignsTrailing
                ),
                y: clamped(menuY, half: menuHeight / 2, extent: containerSize.height, margin: margin)
            ),
            pickerCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: previewFrame,
                    width: pickerWidth,
                    containerWidth: containerSize.width,
                    margin: margin,
                    alignsTrailing: alignsTrailing
                ),
                y: pickerTop + pickerHeight / 2
            ),
            reactionWidth: reactionWidth,
            menuWidth: menuWidth,
            menuHeight: menuHeight,
            pickerWidth: pickerWidth,
            pickerHeight: pickerHeight,
            menuIsBelow: placeMenuBelow,
            scrollLimit: scrollLimit
        )
    }

    func controlFrames(in viewport: CGRect, showsReactions: Bool, showsPicker: Bool,
                       showsMenu: Bool, scrollOffset: CGFloat) -> [CGRect] {
        var frames: [CGRect] = []
        if showsReactions {
            let center = showsPicker ? pickerCenter : reactionCenter
            let size = CGSize(width: showsPicker ? pickerWidth : reactionWidth,
                              height: showsPicker ? pickerHeight : 52)
            frames.append(CGRect(x: viewport.minX + center.x - size.width / 2,
                                 y: viewport.minY + center.y - size.height / 2,
                                 width: size.width, height: size.height))
        }
        if showsMenu {
            frames.append(CGRect(x: viewport.minX + menuCenter.x - menuWidth / 2,
                                 y: viewport.minY + menuCenter.y - menuHeight / 2 + scrollOffset,
                                 width: menuWidth, height: menuHeight))
        }
        return frames
    }

    private static func alignedCenter(
        sourceFrame: CGRect,
        width: CGFloat,
        containerWidth: CGFloat,
        margin: CGFloat,
        alignsTrailing: Bool?
    ) -> CGFloat {
        let preferred = (alignsTrailing ?? (sourceFrame.midX >= containerWidth / 2))
            ? sourceFrame.maxX - width / 2
            : sourceFrame.minX + width / 2
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

/// Shared by the lifted live bubble and the window overlay; the chat itself
/// remains stationary while a tall preview is read.
@Observable
@MainActor
final class MessageActionPreviewScroll {
    var offset: CGFloat = 0
    var limit: CGFloat = 0
    private var dragStart: CGFloat?

    func drag(translation: CGFloat) {
        guard limit > 0 else { return }
        if dragStart == nil { dragStart = offset }
        offset = min(limit, max(0, (dragStart ?? 0) + translation))
    }

    func endDrag() { dragStart = nil }

    func reset() {
        offset = 0
        limit = 0
        dragStart = nil
    }
}

struct MessageActionOverlay: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(BlobEmojiRecentStore.key) private var storedRecentEmojiIDs = "[]"
    @State private var hasPresented = false
    @State private var isDismissing = false
    @State private var showsAllReactions = false
    @State private var isConfirmingDelete = false
    @State private var didSchedulePreviewExpansion = false
    let message: ChatMessage
    let sourceFrame: CGRect
    var photoPreview: UIImage? = nil
    var hitTestRegions: WindowOverlayHitTestRegions? = nil
    let previewScroll: MessageActionPreviewScroll
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

    private var targetReactions: [MessageReaction] {
        if let mediaAttachment { return message.attachmentReactions[mediaAttachment.id] ?? [] }
        return message.reactions
    }

    private var quickReactions: [EmojiPickerItem] {
        EmojiRecentStore.quickReactions(from: storedRecentEmojiIDs)
    }

    private var regularActionCount: Int {
        (allowsConversationReply ? 1 : 0)
            + (allowsThreadReply ? 1 : 0)
            + (!message.text.isEmpty && mediaAttachment == nil ? 2 : 0)
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
                actionCount: regularActionCount,
                alignsTrailing: message.author == .me
            )
            let showsReactionSurface = allowsReactions && !isConfirmingDelete
            let layout = MessageActionOverlayLayout.make(
                sourceFrame: sourceFrameInLayout,
                containerSize: layoutFrame.size,
                showsReactions: showsReactionSurface,
                reactionCount: showsReactionSurface ? quickReactions.count : 0,
                actionCount: actionCount,
                alignsTrailing: message.author == .me,
                forcedMenuIsBelow: regularLayout.menuIsBelow,
                fixedPreviewFrame: regularLayout.previewFrame
            )
            let previewFrame = regularLayout.previewFrame.offsetBy(
                dx: layoutOffset.width, dy: layoutOffset.height + previewScroll.offset
            )
            let controls = layout.controlFrames(
                in: layoutFrame,
                showsReactions: showsReactionSurface,
                showsPicker: showsAllReactions,
                showsMenu: isConfirmingDelete || !showsAllReactions || !allowsReactions,
                scrollOffset: previewScroll.offset
            )
            ZStack {
                dismissalBackdrop(
                    cutout: photoPreview == nil ? (hasPresented ? previewFrame : localSourceFrame) : .zero,
                    clipRect: layoutFrame.offsetBy(dx: -containerFrame.minX, dy: -containerFrame.minY)
                )
                    .animation(MessageActionMotion.fade(reduceMotion: reduceMotion)) { content in
                        content.opacity(hasPresented ? 1 : 0)
                    }

                MessageActionPreviewShadow(
                    frame: hasPresented ? previewFrame : localSourceFrame,
                    author: message.author, isMedia: mediaAttachment != nil
                )
                .opacity(hasPresented ? 1 : 0)
                .clipShape(Path(layoutFrame.offsetBy(dx: -containerFrame.minX, dy: -containerFrame.minY)))
                .allowsHitTesting(false)

                if let photoPreview {
                    let imageFrame = hasPresented ? previewFrame : localSourceFrame
                    Image(uiImage: photoPreview)
                        .resizable()
                        .scaledToFill()
                        .frame(width: imageFrame.width, height: imageFrame.height)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .onTapGesture { performAction(onReviewAttachment) }
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 8)
                                .onChanged { previewScroll.drag(translation: $0.translation.height) }
                                .onEnded { _ in previewScroll.endDrag() },
                            including: previewScroll.limit > 0 ? .all : .none
                        )
                        .position(x: imageFrame.midX, y: imageFrame.midY)
                        .accessibilityIdentifier("message-action-photo-preview")
                        .accessibilityLabel("Selected photo")
                }

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
                        .scaleEffect(reduceMotion || hasPresented ? 1 : 0.96,
                                     anchor: .bottom)
                        .position(
                            showsAllReactions ? layout.pickerCenter : layout.reactionCenter
                        )
                        .offset(layoutOffset)
                        .animation(MessageActionMotion.fade(reduceMotion: reduceMotion)) { content in
                            content.opacity(hasPresented ? 1 : 0)
                        }
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
                }

                if isConfirmingDelete || !showsAllReactions || !allowsReactions {
                    actionMenu
                        .frame(
                            width: layout.menuWidth,
                            height: layout.menuHeight,
                            alignment: .top
                        )
                        .scaleEffect(reduceMotion || hasPresented ? 1 : 0.96,
                                     anchor: regularLayout.menuIsBelow ? .top : .bottom)
                        .position(layout.menuCenter)
                        .offset(x: layoutOffset.width, y: layoutOffset.height + previewScroll.offset)
                        .animation(MessageActionMotion.fade(reduceMotion: reduceMotion)) { content in
                            content.opacity(hasPresented ? 1 : 0)
                        }
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
                }
            }
            .animation(MessageActionMotion.animation(reduceMotion: reduceMotion), value: sourceFrame)
            .animation(
                reduceMotion ? nil : MessageActionMotion.animation(reduceMotion: false),
                value: isConfirmingDelete
            )
            .onAppear {
                hitTestRegions?.controlFrames = controls
                previewScroll.limit = regularLayout.scrollLimit
                withAnimation(MessageActionMotion.enter(reduceMotion: reduceMotion)) {
                    hasPresented = true
                    onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                        dx: layoutFrame.minX, dy: layoutFrame.minY + previewScroll.offset
                    ), !showsAllReactions)
                }
            }
            .onChange(of: controls) { _, frames in
                hitTestRegions?.controlFrames = frames
            }
            .onChange(of: regularLayout.previewFrame) {
                guard !isDismissing else { return }
                previewScroll.limit = regularLayout.scrollLimit
                onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                    dx: layoutFrame.minX, dy: layoutFrame.minY + previewScroll.offset
                ), !showsAllReactions)
            }
            .onChange(of: previewScroll.offset) {
                guard !isDismissing else { return }
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                        dx: layoutFrame.minX, dy: layoutFrame.minY + previewScroll.offset
                    ), !showsAllReactions)
                }
            }
            .onChange(of: showsAllReactions) {
                guard !isDismissing else { return }
                onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                    dx: layoutFrame.minX, dy: layoutFrame.minY + previewScroll.offset
                ), !showsAllReactions)
            }
            .onChange(of: layoutFrame) {
                guard !isDismissing else { return }
                onPreviewFrameChange(regularLayout.previewFrame.offsetBy(
                    dx: layoutFrame.minX, dy: layoutFrame.minY + previewScroll.offset
                ), !showsAllReactions)
            }
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Actions for message from \(message.authorName)")
        .accessibilityIdentifier("message-actions-\(message.id)")
        .allowsHitTesting(!isDismissing)
        .onAppear {
            guard ProcessInfo.processInfo.arguments.contains("--preview-expanded-reactions"),
                  !didSchedulePreviewExpansion else {
                return
            }
            didSchedulePreviewExpansion = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                guard !isDismissing else { return }
                withAnimation(MessageActionMotion.animation(reduceMotion: reduceMotion)) {
                    showsAllReactions = true
                }
            }
        }
    }

    private func performAction(_ action: @escaping () -> Void) {
        guard !isDismissing else { return }
        isDismissing = true
        // Keep the overlay mounted while its cutout follows the live bubble home.
        // Composer changes, navigation and deletion must wait for that return.
        withAnimation(
            MessageActionMotion.exit(reduceMotion: reduceMotion),
            completionCriteria: .removed
        ) {
            hasPresented = false
            onPreviewFrameChange(sourceFrame, false)
        } completion: {
            action()
        }
    }

    private func dismissalBackdrop(cutout: CGRect, clipRect: CGRect) -> some View {
        Button {
            performAction(onDismiss)
        } label: {
            ZStack {
                MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,
                                      sourceWidth: sourceFrame.width, isMedia: mediaAttachment != nil, clipRect: clipRect)
                    .fill(.ultraThinMaterial, style: FillStyle(eoFill: true))
                MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,
                                      sourceWidth: sourceFrame.width, isMedia: mediaAttachment != nil, clipRect: clipRect)
                    .fill(.black.opacity(0.08), style: FillStyle(eoFill: true))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(
                mediaAttachment == nil
                    ? AnyShape(MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author,
                                      sourceWidth: sourceFrame.width, isMedia: mediaAttachment != nil, clipRect: clipRect))
                    : AnyShape(Rectangle()),
                eoFill: mediaAttachment == nil
            )
        }
        .buttonStyle(.plain)
        .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 8)
                .onChanged { previewScroll.drag(translation: $0.translation.height) }
                .onEnded { _ in previewScroll.endDrag() },
            including: previewScroll.limit > 0 ? .all : .none
        )
        .accessibilityLabel("Close message actions")
        #if DEBUG
        .accessibilityValue(ProcessInfo.processInfo.arguments.contains("--preview-action-geometry")
                            ? NSCoder.string(for: cutout) : "")
        #endif
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
                    performAction { onReact(item.reactionValue) }
                }
                .transition(.opacity)
            }
        }
    }

    private var reactionButtons: some View {
        HStack(spacing: 2) {
            ForEach(quickReactions) { item in
                Button {
                    performAction {
                        storedRecentEmojiIDs = EmojiRecentStore.recording(
                            item,
                            in: storedRecentEmojiIDs
                        )
                        onReact(item.reactionValue)
                    }
                } label: {
                    reactionImage(item)
                        .frame(width: 44, height: 44)
                        .background(
                            targetReactions
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
                withAnimation(
                    reduceMotion
                        ? nil
                        : MessageActionMotion.animation(reduceMotion: false)
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
                    deleteChoiceButton(mediaAttachment == nil ? "Delete for me" : "Delete photo for me") { onDelete(false) }
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
                    if !message.text.isEmpty, mediaAttachment == nil {
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
                            mediaAttachment == nil ? "Delete" : "Delete photo",
                            systemImage: "trash",
                            role: .destructive,
                            dismissesMenu: false,
                            action: {
                                withAnimation(reduceMotion ? nil : MessageActionMotion.animation(reduceMotion: false)) {
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
        Button(role: .destructive) {
            performAction(action)
        } label: {
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
        dismissesMenu: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role) {
            if dismissesMenu {
                performAction(action)
            } else {
                action()
            }
        } label: {
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

/// Shared directly with the native window host so hit regions can follow
/// overlay layout without invalidating the conversation's SwiftUI tree.
@MainActor
final class WindowOverlayHitTestRegions {
    var controlFrames: [CGRect] = []
}

struct WindowOverlayPresenter<Content: View>: UIViewRepresentable {
    let passthroughFrame: CGRect?
    private let hitTestRegions: WindowOverlayHitTestRegions?
    private let allowsInteraction: Bool
    private let animatesRemoval: Bool
    private let onDismissComplete: () -> Void
    private let content: (CGRect) -> Content

    init(
        passthroughFrame: CGRect?,
        hitTestRegions: WindowOverlayHitTestRegions? = nil,
        allowsInteraction: Bool = true,
        animatesRemoval: Bool = true,
        onDismissComplete: @escaping () -> Void = {},
        @ViewBuilder content: @escaping (CGRect) -> Content
    ) {
        self.passthroughFrame = passthroughFrame
        self.hitTestRegions = hitTestRegions
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
        let hitTestRegions = self.hitTestRegions
        let content = self.content
        let coordinator = context.coordinator
        coordinator.onDismissComplete = onDismissComplete
        coordinator.allowsInteraction = allowsInteraction
        coordinator.animatesRemoval = animatesRemoval
        let update = { [weak uiView, weak coordinator] in
            guard let uiView, let coordinator else { return }
            coordinator.scheduleInstall(
                from: uiView,
                passthroughFrame: passthroughFrame,
                hitTestRegions: hitTestRegions,
                content: content
            )
        }
        (uiView as? WindowOverlayAnchorView)?.onWindowAttached = update
        if uiView.window != nil { update() }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        (uiView as? WindowOverlayAnchorView)?.onWindowAttached = nil
        coordinator.isDismantled = true
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
        var isDismantled = false
        private var installGeneration = 0

        init(rootView: Content) {
            hostingController = UIHostingController(rootView: rootView)
            hostingController.view.backgroundColor = .clear
        }

        func scheduleInstall(
            from anchor: UIView,
            passthroughFrame: CGRect?,
            hitTestRegions: WindowOverlayHitTestRegions? = nil,
            content: @escaping (CGRect) -> Content
        ) {
            installGeneration += 1
            let generation = installGeneration
            // Hosting callbacks can update the conversation's geometry. Run them
            // after UIViewRepresentable's update transaction, and drop stale work.
            DispatchQueue.main.async { [weak self, weak anchor] in
                guard let self, let anchor, !self.isDismantled,
                      self.installGeneration == generation else { return }
                self.install(from: anchor, passthroughFrame: passthroughFrame, hitTestRegions: hitTestRegions, content: content)
            }
        }

        func install(
            from anchor: UIView,
            passthroughFrame: CGRect?,
            hitTestRegions: WindowOverlayHitTestRegions? = nil,
            content: (CGRect) -> Content
        ) {
            guard let window = anchor.window else { return }
            let usableFrame = anchor.convert(anchor.bounds, to: window)
            hostingController.rootView = content(usableFrame)
            container.passthroughFrame = passthroughFrame
            container.hitTestRegions = hitTestRegions
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
    var hitTestRegions: WindowOverlayHitTestRegions?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if let passthroughFrame, passthroughFrame.contains(point),
           !(hitTestRegions?.controlFrames.contains(where: { $0.contains(point) }) ?? false) {
            return false
        }
        return super.point(inside: point, with: event)
    }
}

private struct MessageActionPreviewShadow: View {
    let frame: CGRect
    let author: MessageAuthor
    let isMedia: Bool

    var body: some View {
        ZStack {
            MessageActionPreviewOutline(frame: CGRect(origin: .zero, size: frame.size), author: author, isMedia: isMedia)
                .fill(.black.opacity(0.12))
                .blur(radius: 18)
                .offset(y: 10)
            MessageActionPreviewOutline(frame: CGRect(origin: .zero, size: frame.size), author: author, isMedia: isMedia)
                .fill(.black)
                .blendMode(.destinationOut)
        }
        .compositingGroup()
        .frame(width: frame.width, height: frame.height)
        .position(x: frame.midX, y: frame.midY)
        .accessibilityHidden(true)
    }
}

private struct MessageActionPreviewOutline: Shape {
    var frame: CGRect
    let author: MessageAuthor
    let isMedia: Bool

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(AnimatablePair(frame.minX, frame.minY), AnimatablePair(frame.width, frame.height)) }
        set { frame = CGRect(x: newValue.first.first, y: newValue.first.second, width: newValue.second.first, height: newValue.second.second) }
    }

    func path(in rect: CGRect) -> Path {
        let bounds = CGRect(origin: .zero, size: frame.size)
        let path = isMedia
            ? RoundedRectangle(cornerRadius: 12, style: .continuous).path(in: bounds)
            : MessageBubbleGeometry.shape(for: author).path(in: bounds)
        return path.applying(CGAffineTransform(translationX: frame.minX, y: frame.minY))
    }
}

private struct MessageActionBackdrop: Shape {
    var cutout: CGRect
    let sourceAuthor: MessageAuthor
    let sourceWidth: CGFloat
    let isMedia: Bool
    var clipRect: CGRect? = nil

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
        let opening = outline.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                                        tx: cutout.minX, ty: cutout.minY))
        // The live bubble is clipped by the conversation viewport. Keep the
        // blur opening and its hit region inside that same visible area.
        path.addPath(opening.intersection(Path((clipRect ?? rect).intersection(rect))))
        return path
    }
}

/// Shared by the live bubble and the window-hosted overlay.
enum MessageActionMotion {
    static let pressFeedbackDelay: TimeInterval = 0.12
    static let activationDelay: TimeInterval = 0.32

    static func enter(reduceMotion: Bool) -> Animation {
        reduceMotion ? fade(reduceMotion: true) : .spring(duration: 0.3, bounce: 0.1)
    }

    static func exit(reduceMotion: Bool) -> Animation {
        reduceMotion ? fade(reduceMotion: true) : .timingCurve(0.32, 0.72, 0, 1, duration: 0.2)
    }

    static func fade(reduceMotion: Bool) -> Animation {
        .easeOut(duration: reduceMotion ? 0.12 : 0.16)
    }

    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? fade(reduceMotion: true) : .timingCurve(0.23, 1, 0.32, 1, duration: 0.2)
    }

    static func previewAnimation(for placement: MessageActionBubblePlacement?, reduceMotion: Bool) -> Animation {
        guard let placement, placement.previewFrame != placement.sourceFrame else {
            return exit(reduceMotion: reduceMotion)
        }
        return enter(reduceMotion: reduceMotion)
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
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
