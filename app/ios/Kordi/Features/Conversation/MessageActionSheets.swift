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
    let reactionCenter: CGPoint
    let menuCenter: CGPoint
    let pickerCenter: CGPoint
    let reactionWidth: CGFloat
    let menuWidth: CGFloat
    let menuHeight: CGFloat
    let pickerWidth: CGFloat
    let pickerHeight: CGFloat

    static func make(
        sourceFrame: CGRect,
        containerSize: CGSize,
        showsReactions: Bool,
        reactionCount: Int,
        actionCount: Int
    ) -> Self {
        let margin: CGFloat = 12
        let reactionHeight: CGFloat = showsReactions ? 52 : 0
        let menuWidth = min(238, containerSize.width - margin * 2)
        let preferredMenuHeight = CGFloat(actionCount) * 44 + 10
        let availableMenuHeightBelow = max(
            0,
            containerSize.height - sourceFrame.maxY - 8 - margin
        )
        let availableMenuHeightAbove = max(
            0,
            sourceFrame.minY - margin - reactionHeight - (showsReactions ? 16 : 8)
        )
        let placeMenuBelow = availableMenuHeightBelow >= preferredMenuHeight
            || (availableMenuHeightAbove < preferredMenuHeight
                && availableMenuHeightBelow > availableMenuHeightAbove)
        let availableMenuHeight = placeMenuBelow
            ? availableMenuHeightBelow
            : availableMenuHeightAbove
        let menuHeight = min(preferredMenuHeight, max(44, availableMenuHeight))
        let reactionWidth = min(
            containerSize.width - margin * 2,
            CGFloat(max(1, reactionCount + 1)) * 46 + 12
        )
        let pickerWidth = min(360, containerSize.width - margin * 2)
        let preferredPickerHeight = min(520, max(320, containerSize.height * 0.62))
        let reactionY = sourceFrame.minY - (showsReactions ? 8 : 0) - reactionHeight / 2
        let reactionCenterY = placeMenuBelow
            ? clamped(
                reactionY,
                half: reactionHeight / 2,
                extent: containerSize.height,
                margin: margin
            )
            : max(
                margin + menuHeight + 8 + reactionHeight / 2,
                reactionY
            )
        let pickerHeight = min(
            preferredPickerHeight,
            max(52, containerSize.height - margin * 2)
        )
        let pickerTop = min(
            max(margin, reactionCenterY - reactionHeight / 2),
            max(margin, containerSize.height - margin - pickerHeight)
        )
        let menuY = placeMenuBelow
            ? sourceFrame.maxY + 8 + menuHeight / 2
            : reactionY - reactionHeight / 2 - 8 - menuHeight / 2
        return Self(
            reactionCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: sourceFrame,
                    width: reactionWidth,
                    containerWidth: containerSize.width,
                    margin: margin
                ),
                y: reactionCenterY
            ),
            menuCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: sourceFrame,
                    width: menuWidth,
                    containerWidth: containerSize.width,
                    margin: margin
                ),
                y: clamped(menuY, half: menuHeight / 2, extent: containerSize.height, margin: margin)
            ),
            pickerCenter: CGPoint(
                x: alignedCenter(
                    sourceFrame: sourceFrame,
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
            pickerHeight: pickerHeight
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
    @State private var showsAllReactions = false
    @State private var didSchedulePreviewExpansion = false
    let message: ChatMessage
    let sourceFrame: CGRect
    let usableFrame: CGRect
    let ownAccountId: String?
    let allowsReply: Bool
    let allowsReactions: Bool
    let isPinned: Bool
    let mediaAttachment: ChatAttachment?
    let readReceiptLabel: String?
    let readReceiptReaders: [CloudGroupParticipant]
    let onDismiss: () -> Void
    let onReviewAttachment: () -> Void
    let onShareAttachment: () -> Void
    let onAddAttachmentToMediaLibrary: () -> Void
    let onReact: (String) -> Void
    let onReply: () -> Void
    let onPin: () -> Void
    let onCopy: () -> Void
    let onShareMessage: () -> Void
    let onForward: () -> Void
    let onSaveSticker: (ChatAttachment) -> Void
    let onSelect: () -> Void

    private var quickReactions: [BlobEmoji] {
        let recent = BlobEmojiRecentStore.ids(from: storedRecentEmojiIDs)
            .compactMap { BlobEmojiCatalog.byID[$0] }
        let fallback = BlobEmojiCatalog.all.filter { !$0.animated }
        return Array((recent + fallback.filter { !recent.contains($0) }).prefix(6))
    }

    private var actionCount: Int {
        (allowsReply ? 1 : 0)
            + (!message.text.isEmpty ? 2 : 0)
            + 3
            + mediaActionCount
            + (stickerAttachment == nil ? 0 : 1)
            + (readReceiptLabel == nil ? 0 : 1)
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
        !BlobEmojiRecentStore.ids(from: storedRecentEmojiIDs).isEmpty
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
            let layout = MessageActionOverlayLayout.make(
                sourceFrame: sourceFrameInLayout,
                containerSize: layoutFrame.size,
                showsReactions: allowsReactions,
                reactionCount: allowsReactions ? quickReactions.count : 0,
                actionCount: actionCount
            )
            ZStack {
                dismissalBackdrop(cutout: localSourceFrame)

                if allowsReactions {
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
                }

                if !showsAllReactions || !allowsReactions {
                    actionMenu
                        .frame(
                            width: layout.menuWidth,
                            height: layout.menuHeight,
                            alignment: .top
                        )
                        .position(layout.menuCenter)
                        .offset(layoutOffset)
                        .transition(.scale(scale: 0.96).combined(with: .opacity))
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Actions for message from \(message.authorName)")
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
                MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author)
                    .fill(.ultraThinMaterial, style: FillStyle(eoFill: true))
                MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author)
                    .fill(.black.opacity(0.08), style: FillStyle(eoFill: true))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(
                mediaAttachment == nil
                    ? AnyShape(MessageActionBackdrop(cutout: cutout, sourceAuthor: message.author))
                    : AnyShape(Rectangle()),
                eoFill: mediaAttachment == nil
            )
        }
        .buttonStyle(.plain)
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
                BlobEmojiSelectionBoard(
                    initialCategory: hasRecentReactions ? .recent : .all
                ) { emoji in
                    onReact(emoji.reactionValue)
                }
                .transition(.opacity)
            }
        }
    }

    private var reactionButtons: some View {
        HStack(spacing: 2) {
            ForEach(quickReactions, id: \.self) { reaction in
                Button {
                    storedRecentEmojiIDs = BlobEmojiRecentStore.recording(
                        reaction.id,
                        in: storedRecentEmojiIDs
                    )
                    onReact(reaction.reactionValue)
                } label: {
                    BlobEmojiView(emoji: reaction, size: 30)
                        .frame(width: 44, height: 44)
                        .background(
                            message.reactions
                                .first(where: { $0.value == reaction.reactionValue })?
                                .includes(accountId: ownAccountId) == true
                                ? KordiTheme.agentViolet.opacity(0.14)
                                : .clear,
                            in: Circle()
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("React with \(reaction.accessibilityName)")
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

    private var actionMenu: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
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
                if allowsReply {
                    actionButton("Reply", systemImage: "arrowshape.turn.up.left", action: onReply)
                }
                if !message.text.isEmpty {
                    actionButton("Copy", systemImage: "doc.on.doc", action: onCopy)
                    actionButton(
                        "Share",
                        systemImage: "square.and.arrow.up",
                        action: onShareMessage
                    )
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
                MessageActionReadReceiptRow(
                    label: readReceiptLabel,
                    readers: readReceiptReaders
                )
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

    private func actionButton(
        _ title: String,
        systemImage: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.body)
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
    private let content: (CGRect) -> Content

    init(
        passthroughFrame: CGRect?,
        @ViewBuilder content: @escaping (CGRect) -> Content
    ) {
        self.passthroughFrame = passthroughFrame
        self.content = content
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(rootView: content(.zero))
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        let passthroughFrame = self.passthroughFrame
        let content = self.content
        let coordinator = context.coordinator
        let update = { [weak uiView, weak coordinator] in
            guard let uiView, let coordinator else { return }
            coordinator.install(
                from: uiView,
                passthroughFrame: passthroughFrame,
                content: content
            )
        }
        if uiView.window == nil {
            DispatchQueue.main.async(execute: update)
        } else {
            update()
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.remove(animated: !UIAccessibility.isReduceMotionEnabled)
    }

    @MainActor
    final class Coordinator {
        private let container = MessageActionWindowOverlayView()
        private let hostingController: UIHostingController<Content>
        private weak var window: UIWindow?

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

            if container.superview === window {
                container.frame = window.bounds
                window.bringSubviewToFront(container)
                return
            }

            remove(animated: false)
            self.window = window
            container.frame = window.bounds
            container.alpha = 1
            container.isUserInteractionEnabled = true
            container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            hostingController.view.frame = container.bounds
            hostingController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(hostingController.view)
            window.addSubview(container)
        }

        func remove(animated: Bool) {
            guard animated, container.superview != nil else {
                detach()
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
            }
        }

        private func detach() {
            hostingController.view.removeFromSuperview()
            container.removeFromSuperview()
            window = nil
        }
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
    let cutout: CGRect
    let sourceAuthor: MessageAuthor

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addPath(MessageBubbleGeometry.shape(for: sourceAuthor).path(in: cutout))
        return path
    }
}
